// =======================================================
// PIPSTRADES — OVER/UNDER BOT (simplified UI, same entry logic)
// =======================================================
// Uses the platform's shared OAuth session + WebSocket connection
// instead of a manual PAT/App ID/Account ID form.
//
// UNCHANGED from the original bot: digit-frequency analysis,
// least-frequent-digit selection, resolveTradeStrategy() (the
// digit-position → contract-type decision), auto-mode hysteresis,
// recovery/martingale staking, and session stop-loss/take-profit.
//
// Removed per simplification request: connection UI, UNDER2/OVER7,
// double-confirmation, and the full 10-digit frequency table.
// Three settings that were previously user-adjustable are now
// fixed constants, hidden from the UI (see FIXED SETTINGS below).
// =======================================================

import { isAuthenticated, getToken, clearToken } from '/src/core/auth/tokenManager.js';
import {
  connect as wsConnect,
  send as wsSend,
  sendRequest as wsSendRequest,
  subscribeTicks as wsSubscribeTicks,
  disconnect as wsDisconnect,
} from '/src/core/connection/wsClient.js';
import { on as busOn } from '/src/core/state/eventBus.js';
import { getAccountType } from '/src/core/state/accountPreference.js';

console.log("=== OVER/UNDER BOT STARTING ===");

// =======================================================
// FIXED SETTINGS (previously adjustable, now hardcoded — not shown in UI)
// =======================================================

const minFrequencyGap     = 8.0;  // was: Min Frequency Gap input
const maxConsecLosses     = 2;    // was: Pause after losses input
const pauseTicksAfterLoss = 30;   // was: Pause duration input

// =======================================================
// GLOBAL STATE
// =======================================================

let isConnected          = false;
let isBotRunning         = false;
let isProcessingTrade    = false;

let balance               = 0;
let sessionStartBalance   = 0;
let currentPrice          = null;
let currentLastDigit      = null;
let activeStrategy        = 'over2';
let currentMarket         = 'R_10';

const marketDecimalFallback = {
    'R_10':    4, 'R_25':    4, 'R_50':    4,
    'R_75':    4, 'R_100':   4,
    '1HZ10V':  3, '1HZ25V':  3, '1HZ50V':  3,
    '1HZ75V':  3, '1HZ100V': 3
};
let currentDecimalPlaces  = marketDecimalFallback['R_10'];
let decimalPlacesDetected = false;

let baseStake            = 1.00;
let currentStake         = 1.00;
let tickHistory           = [];
let leastFrequentDigit    = null;
let currentTickSymbol     = '';

// Stats
let totalTrades          = 0;
let totalWins            = 0;
let totalLosses          = 0;
let totalProfit          = 0;

// Recovery
let recoveryEnabled      = false;
let consecutiveLosses    = 0;

// Auto Mode
let autoModeEnabled      = false;
let pauseTicksRemaining  = 0;
const autoHysteresis     = 5.0;

// Risk
let stopLossEnabled      = false;
let stopLossPct          = 10;
let takeProfitEnabled    = false;
let takeProfitPct        = 15;

// Active contracts
let activeContracts      = {};

// =======================================================
// MARKET & STRATEGY SETTINGS (UNDER2 / OVER7 removed)
// =======================================================

const marketNames = {
    'R_10':    { name: 'Volatility 10'       },
    'R_25':    { name: 'Volatility 25'       },
    'R_50':    { name: 'Volatility 50'       },
    'R_75':    { name: 'Volatility 75'       },
    'R_100':   { name: 'Volatility 100'      },
    '1HZ10V':  { name: 'Volatility 10 (1s)'  },
    '1HZ25V':  { name: 'Volatility 25 (1s)'  },
    '1HZ50V':  { name: 'Volatility 50 (1s)'  },
    '1HZ75V':  { name: 'Volatility 75 (1s)'  },
    '1HZ100V': { name: 'Volatility 100 (1s)' }
};

const strategyConfig = {
    'over2':  { contract_type: 'DIGITOVER',  barrier: '2', label: 'OVER 2'  },
    'under7': { contract_type: 'DIGITUNDER', barrier: '7', label: 'UNDER 7' }
};

let digitFrequency = { 0:0,1:0,2:0,3:0,4:0,5:0,6:0,7:0,8:0,9:0 };

// =======================================================
// DETECT DECIMAL PLACES
// =======================================================

function detectDecimalPlaces(quoteNumber) {
    let s   = String(quoteNumber);
    let dot = s.indexOf('.');
    return dot === -1 ? 0 : s.length - dot - 1;
}

// =======================================================
// DOM READY
// =======================================================

document.addEventListener('DOMContentLoaded', function () {
    console.log("DOM LOADED");
    initializeElements();
    setupEventListeners();
    renderEntryDigit();
    updateStatsUI();
    updateStrategyUI();
    updateRiskUI();
    updateUI();
    startConnection();
});

// =======================================================
// CACHE ELEMENTS
// =======================================================

function initializeElements() {
    window.els = {
        connectionDot:        document.getElementById('connectionDot'),
        connectionStatusText: document.getElementById('connectionStatusText'),
        balanceValue:         document.getElementById('balanceValue'),
        totalTrades:          document.getElementById('totalTrades'),
        totalWins:            document.getElementById('totalWins'),
        totalLosses:          document.getElementById('totalLosses'),
        winRate:              document.getElementById('winRate'),
        totalProfit:          document.getElementById('totalProfit'),
        recoveryModeStat:     document.getElementById('recoveryModeStat'),
        marketSelect:         document.getElementById('marketSelect'),
        marketInfo:           document.getElementById('marketInfo'),
        marketLabel:          document.getElementById('marketLabel'),
        livePriceDisplay:     document.getElementById('livePriceDisplay'),
        currentLastDigit:     document.getElementById('currentLastDigit'),
        stakeInput:           document.getElementById('stakeInput'),
        expectedProfit:       document.getElementById('expectedProfit'),
        stakeAmount:          document.getElementById('stakeAmount'),
        recoveryToggle:       document.getElementById('recoveryToggle'),
        recoveryInfo:         document.getElementById('recoveryInfo'),
        recoveryStatusText:   document.getElementById('recoveryStatusText'),
        consecutiveLosses:    document.getElementById('consecutiveLossesCount'),
        nextStakeAmount:      document.getElementById('nextStakeAmount'),
        autoModeToggle:       document.getElementById('autoModeToggle'),
        autoModeInfo:         document.getElementById('autoModeInfo'),
        marketBiasStatus:     document.getElementById('marketBiasStatus'),
        autoCurrentStrategy:  document.getElementById('autoCurrentStrategy'),
        over2Strength:        document.getElementById('over2Strength'),
        under7Strength:       document.getElementById('under7Strength'),
        optionOver2Btn:       document.getElementById('optionOver2Btn'),
        optionUnder7Btn:      document.getElementById('optionUnder7Btn'),
        entryDigitNumber:     document.getElementById('entryDigitNumber'),
        entryDigitPct:        document.getElementById('entryDigitPct'),
        leastFrequentDigit:   document.getElementById('leastFrequentDigit'),
        activeStrategy:       document.getElementById('activeStrategy'),
        startBotBtn:          document.getElementById('startBotBtn'),
        stopBotBtn:           document.getElementById('stopBotBtn'),
        botStatus:            document.getElementById('botStatus'),
        tradeStatusMsg:       document.getElementById('tradeStatusMsg'),
        historyContainer:     document.getElementById('historyContainer'),
        clearHistoryBtn:      document.getElementById('clearHistoryBtn'),
        stopLossToggle:       document.getElementById('stopLossToggle'),
        stopLossPctInput:     document.getElementById('stopLossPctInput'),
        takeProfitToggle:     document.getElementById('takeProfitToggle'),
        takeProfitPctInput:   document.getElementById('takeProfitPctInput'),
        riskStatusDisplay:    document.getElementById('riskStatusDisplay')
    };
}

function el(id) { return window.els[id]; }

// =======================================================
// EVENT LISTENERS
// =======================================================

function setupEventListeners() {

    el('startBotBtn').addEventListener('click', onStartBot);
    el('stopBotBtn').addEventListener('click', onStopBot);

    el('clearHistoryBtn').addEventListener('click', function () {
        el('historyContainer').innerHTML = '<div style="text-align:center;color:#5b6e8c;">No trades yet</div>';
        totalTrades = 0; totalWins = 0; totalLosses = 0; totalProfit = 0;
        consecutiveLosses = 0; currentStake = baseStake;
        pauseTicksRemaining = 0;
        updateStatsUI(); updateRecoveryUI(); updateStakeDisplay(); updateRiskUI();
    });

    el('stakeInput').addEventListener('input', function () {
        let val = parseFloat(this.value);
        if (!isNaN(val) && val > 0) {
            baseStake = val; currentStake = val;
            el('expectedProfit').textContent = (val * 0.95).toFixed(2);
            el('stakeAmount').textContent    = val.toFixed(2) + ' USD';
            updateRecoveryUI();
        }
    });

    el('marketSelect').addEventListener('change', function () {
        let newMarket = this.value;
        if (newMarket === currentMarket) return;
        currentMarket = newMarket;
        currentPrice = null; currentLastDigit = null;
        decimalPlacesDetected = false;
        currentDecimalPlaces  = marketDecimalFallback[currentMarket] || 4;
        tickHistory = [];
        for (let i = 0; i <= 9; i++) digitFrequency[i] = 0;
        leastFrequentDigit  = null;
        pauseTicksRemaining = 0;
        el('livePriceDisplay').innerHTML   = '—';
        el('currentLastDigit').textContent = '—';
        let info = marketNames[currentMarket];
        if (info) {
            el('marketLabel').textContent = '📊 ' + info.name.toUpperCase() + ' LIVE PRICE';
            el('marketInfo').textContent  = 'Current: ' + this.options[this.selectedIndex].text + ' — loading tick history...';
        }
        renderEntryDigit();
        if (isConnected) {
            preloadTickHistory().then(function () { subscribeTicks(); });
        }
    });

    el('recoveryToggle').addEventListener('change', function () {
        recoveryEnabled = this.checked;
        el('recoveryInfo').style.display     = recoveryEnabled ? 'block' : 'none';
        el('recoveryStatusText').textContent = recoveryEnabled ? 'ON' : 'OFF';
        el('recoveryModeStat').textContent   = recoveryEnabled ? 'ON' : 'OFF';
        if (!recoveryEnabled) { consecutiveLosses = 0; currentStake = baseStake; }
        updateRecoveryUI();
    });

    el('autoModeToggle').addEventListener('change', function () {
        autoModeEnabled = this.checked;
        el('autoModeInfo').style.display = autoModeEnabled ? 'block' : 'none';
        if (autoModeEnabled) updateAutoMode();
        updateStrategyUI();
    });

    el('optionOver2Btn').addEventListener('click',  function () { setStrategy('over2');  });
    el('optionUnder7Btn').addEventListener('click', function () { setStrategy('under7'); });

    if (el('stopLossToggle')) el('stopLossToggle').addEventListener('change', function () {
        stopLossEnabled = this.checked; updateRiskUI();
    });
    if (el('stopLossPctInput')) el('stopLossPctInput').addEventListener('input', function () {
        let v = parseFloat(this.value);
        if (!isNaN(v) && v > 0) stopLossPct = v;
    });
    if (el('takeProfitToggle')) el('takeProfitToggle').addEventListener('change', function () {
        takeProfitEnabled = this.checked; updateRiskUI();
    });
    if (el('takeProfitPctInput')) el('takeProfitPctInput').addEventListener('input', function () {
        let v = parseFloat(this.value);
        if (!isNaN(v) && v > 0) takeProfitPct = v;
    });
}

// =======================================================
// STRATEGY
// =======================================================

function setStrategy(strategy) {
    if (autoModeEnabled) return;
    activeStrategy = strategy;
    updateStrategyUI();
}

function updateStrategyUI() {
    ['optionOver2Btn','optionUnder7Btn'].forEach(function (id) {
        el(id).classList.remove('active');
    });
    let map = { over2:'optionOver2Btn', under7:'optionUnder7Btn' };
    if (map[activeStrategy]) el(map[activeStrategy]).classList.add('active');
    let cfg = strategyConfig[activeStrategy];
    if (cfg) {
        el('activeStrategy').textContent = cfg.label;
    }
}

// =======================================================
// AUTO MODE — 100-tick window + hysteresis (UNCHANGED)
// =======================================================

function updateAutoMode() {
    if (!autoModeEnabled || tickHistory.length < 20) return;
    let recent    = tickHistory.slice(-100);
    let over2cnt  = recent.filter(function (d) { return d > 2; }).length;
    let under7cnt = recent.filter(function (d) { return d < 7; }).length;
    let over2pct  = (over2cnt  / recent.length) * 100;
    let under7pct = (under7cnt / recent.length) * 100;
    el('over2Strength').textContent  = over2pct.toFixed(1)  + '%';
    el('under7Strength').textContent = under7pct.toFixed(1) + '%';
    let newStrategy = activeStrategy;
    let diff        = Math.abs(over2pct - under7pct);
    if (over2pct > under7pct && diff >= autoHysteresis) {
        newStrategy = 'over2';
        el('marketBiasStatus').textContent = 'High (OVER 2 favoured +' + diff.toFixed(1) + '%)';
    } else if (under7pct > over2pct && diff >= autoHysteresis) {
        newStrategy = 'under7';
        el('marketBiasStatus').textContent = 'Low (UNDER 7 favoured +' + diff.toFixed(1) + '%)';
    } else {
        el('marketBiasStatus').textContent = 'Neutral (gap ' + diff.toFixed(1) + '% < ' + autoHysteresis + '% threshold)';
    }
    if (newStrategy !== activeStrategy) {
        activeStrategy = newStrategy;
        el('autoCurrentStrategy').textContent = strategyConfig[activeStrategy].label;
        updateStrategyUI();
        updateStatus('🤖 Auto switched to ' + strategyConfig[activeStrategy].label + ' (gap: ' + diff.toFixed(1) + '%)');
    }
}

// =======================================================
// ENTRY FILTER (UNCHANGED except double-confirmation removed)
// =======================================================

function checkEntryConditions(lastDigit) {
    if (tickHistory.length < 20) return { allowed: false };
    if (lastDigit !== leastFrequentDigit) return { allowed: false };

    // 1. Minimum frequency gap (fixed at 8%, hidden from UI)
    let total = tickHistory.length;
    let pct   = (digitFrequency[leastFrequentDigit] / total) * 100;
    if (pct >= minFrequencyGap) {
        return { allowed: false };
    }

    // 2. Consecutive loss pause (fixed: 2 losses / 30 ticks, hidden from UI)
    if (pauseTicksRemaining > 0) {
        return { allowed: false };
    }

    return { allowed: true };
}

// =======================================================
// SESSION RISK CHECKS (UNCHANGED)
// =======================================================

function checkSessionLimits() {
    if (sessionStartBalance === 0) return true;
    if (stopLossEnabled) {
        let lossAmt = sessionStartBalance * (stopLossPct / 100);
        if (totalProfit <= -lossAmt) {
            haltBot('🛑 STOP-LOSS HIT — session loss reached ' + stopLossPct + '% ($' + lossAmt.toFixed(2) + ')');
            return false;
        }
    }
    if (takeProfitEnabled) {
        let profitAmt = sessionStartBalance * (takeProfitPct / 100);
        if (totalProfit >= profitAmt) {
            haltBot('🎯 TAKE-PROFIT HIT — session profit reached ' + takeProfitPct + '% ($' + profitAmt.toFixed(2) + ')');
            return false;
        }
    }
    return true;
}

function haltBot(reason) {
    isBotRunning = false; isProcessingTrade = false;
    setBotStatus('🛑 Bot Status: HALTED', 'stopped');
    updateStatus(reason); updateUI(); updateRiskUI();
}

// =======================================================
// RISK UI
// =======================================================

function updateRiskUI() {
    if (!el('riskStatusDisplay')) return;
    let lines = [];
    if (stopLossEnabled) {
        let lossAmt = sessionStartBalance > 0 ? sessionStartBalance * (stopLossPct / 100) : 0;
        lines.push('🛑 Stop-loss: ' + stopLossPct + '%' + (lossAmt > 0 ? ' ($' + lossAmt.toFixed(2) + ')' : ''));
    }
    if (takeProfitEnabled) {
        let profitAmt = sessionStartBalance > 0 ? sessionStartBalance * (takeProfitPct / 100) : 0;
        lines.push('🎯 Take-profit: ' + takeProfitPct + '%' + (profitAmt > 0 ? ' ($' + profitAmt.toFixed(2) + ')' : ''));
    }
    el('riskStatusDisplay').textContent = lines.length ? lines.join(' | ') : 'No risk limits active';
}

// =======================================================
// RECOVERY (UNCHANGED)
// =======================================================

function updateRecoveryUI() {
    if (!recoveryEnabled) return;
    el('consecutiveLosses').textContent = consecutiveLosses;
    el('nextStakeAmount').textContent   = '$' + currentStake.toFixed(2);
}

function onTradeWin(profit) {
    totalWins++; totalProfit += profit; consecutiveLosses = 0;
    pauseTicksRemaining = 0;
    if (recoveryEnabled) currentStake = baseStake;
    updateStatsUI(); updateRecoveryUI(); updateStakeDisplay(); updateRiskUI();
}

function onTradeLoss(loss) {
    totalLosses++; totalProfit -= loss; consecutiveLosses++;
    if (consecutiveLosses >= maxConsecLosses) {
        pauseTicksRemaining = pauseTicksAfterLoss;
    }
    if (recoveryEnabled) currentStake = parseFloat((currentStake * 2).toFixed(2));
    updateStatsUI(); updateRecoveryUI(); updateStakeDisplay(); updateRiskUI();
}

function updateStakeDisplay() {
    el('stakeInput').value           = currentStake.toFixed(2);
    el('stakeAmount').textContent    = currentStake.toFixed(2) + ' USD';
    el('expectedProfit').textContent = (currentStake * 0.95).toFixed(2);
}

// =======================================================
// STATS UI
// =======================================================

function updateStatsUI() {
    totalTrades = totalWins + totalLosses;
    let rate    = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : '0';
    el('totalTrades').textContent = totalTrades;
    el('totalWins').textContent   = totalWins;
    el('totalLosses').textContent = totalLosses;
    el('winRate').textContent     = rate + '%';
    let p = el('totalProfit');
    p.textContent = (totalProfit >= 0 ? '+' : '') + '$' + totalProfit.toFixed(2);
    p.style.color = totalProfit >= 0 ? '#facc15' : '#ef4444';
}

// =======================================================
// CONNECTION — via platform OAuth session + shared wsClient
// (replaces the old PAT / App ID / Account ID form entirely)
// =======================================================

async function startConnection() {
    if (!isAuthenticated()) {
        window.location.href = '/';
        return;
    }

    try {
        const token = getToken();
        await wsConnect(token, getAccountType());
        isConnected = true;
        el('connectionDot').classList.add('live');
        el('connectionStatusText').textContent = 'Connected · Live';
        if (getAccountType() === 'real') {
            el('connectionStatusText').style.color = '#ff2d55';
        }
        updateStatus('✅ Connected! Loading recent tick history from Deriv...');
        wsSend({ balance: 1, subscribe: 1 });
        await preloadTickHistory();
        subscribeTicks();
        updateUI();
    } catch (err) {
        console.error(err);
        el('connectionStatusText').textContent = 'Connection failed';
        updateStatus('❌ ' + err.message);
        isConnected = false;
        updateUI();
    }
}

// =======================================================
// PRELOAD TICK HISTORY — fetches Deriv's own recent tick history
// on connect (and on market change) so the digit distribution and
// entry digit are stable immediately, instead of starting at 0 and
// drifting as live ticks slowly accumulate.
// =======================================================

async function preloadTickHistory() {
    try {
        let response = await wsSendRequest({
            ticks_history: currentMarket,
            end: 'latest',
            count: 150,
            style: 'ticks'
        });

        let prices = response.history.prices;
        let pipSize = response.pip_size;

        if (typeof pipSize === 'number') {
            currentDecimalPlaces = pipSize;
            decimalPlacesDetected = true;
        }

        tickHistory = prices.map(function (price) {
            return parseInt(getLastDigit(price), 10);
        }).filter(function (d) { return !isNaN(d); });

        if (tickHistory.length > 200) {
            tickHistory = tickHistory.slice(-200);
        }

        if (prices.length > 0) {
            currentPrice = prices[prices.length - 1];
            currentLastDigit = tickHistory[tickHistory.length - 1];
        }

        updateDigitAnalysis();
        renderEntryDigit();
        updateLivePriceDisplay();

        el('marketInfo').textContent = 'Current: '
            + el('marketSelect').options[el('marketSelect').selectedIndex].text
            + ' — ' + currentDecimalPlaces + ' decimal places (history loaded: ' + tickHistory.length + ' ticks)';

        updateStatus('✅ Loaded ' + tickHistory.length + ' recent ticks from Deriv — entry digit ready.');
    } catch (err) {
        console.error('Tick history preload failed:', err);
        updateStatus('⚠️ Could not preload tick history — building live instead.');
    }
}

function subscribeTicks() {
    wsSubscribeTicks(currentMarket);
    currentTickSymbol = currentMarket;
}

// =======================================================
// EVENT BUS LISTENERS (replaces old raw ws.onmessage routing)
// =======================================================

busOn('balance', (bal) => {
    balance = parseFloat(bal.balance);
    el('balanceValue').textContent = balance.toFixed(2);
});

busOn('tick', (tick) => {
    if (tick.symbol !== currentMarket) return;
    let price = tick.quote;
    currentPrice = price;

    if (!decimalPlacesDetected) {
        let detected = detectDecimalPlaces(price);
        if (detected > 0) {
            currentDecimalPlaces = detected; decimalPlacesDetected = true;
            el('marketInfo').textContent = 'Current: '
                + el('marketSelect').options[el('marketSelect').selectedIndex].text
                + ' — ' + currentDecimalPlaces + ' decimal places';
        }
    }

    let lastDigit = parseInt(getLastDigit(price));
    currentLastDigit = lastDigit;
    tickHistory.push(lastDigit);
    if (tickHistory.length > 200) tickHistory.shift();

    if (pauseTicksRemaining > 0) {
        pauseTicksRemaining--;
    }

    updateDigitAnalysis();
    renderEntryDigit();
    updateLivePriceDisplay();
    if (autoModeEnabled && tickHistory.length % 10 === 0) updateAutoMode();

    if (isConnected && isBotRunning && !isProcessingTrade) {
        if (!checkSessionLimits()) return;
        let entry = checkEntryConditions(lastDigit);
        if (entry.allowed) { isProcessingTrade = true; executeTrade(); }
    }
});

busOn('contractUpdate', (poc) => {
    let contractId = poc.contract_id;
    if ((poc.is_sold || poc.status === 'won' || poc.status === 'lost') && activeContracts[contractId]) {
        let stake  = activeContracts[contractId].stake;
        let strat  = activeContracts[contractId].strategy;
        let profit = parseFloat(poc.profit || 0);
        delete activeContracts[contractId];
        if (poc.status === 'won') {
            onTradeWin(profit);
            addHistoryItem(true, stake, profit, contractId, strat);
            updateStatus('✅ WIN +$' + profit.toFixed(2) + ' | P/L: ' + (totalProfit >= 0 ? '+' : '') + '$' + totalProfit.toFixed(2));
        } else {
            onTradeLoss(stake);
            addHistoryItem(false, stake, -stake, contractId, strat);
            updateStatus('❌ LOSS -$' + stake.toFixed(2) + ' | P/L: ' + (totalProfit >= 0 ? '+' : '') + '$' + totalProfit.toFixed(2));
        }
        isProcessingTrade = false;
        if (isBotRunning) checkSessionLimits();
    }
});

busOn('connection:error', (err) => {
    console.error('Connection error:', err);
    updateStatus('⚠️ ' + (err.message || 'Connection error'));
});

busOn('connection:close', () => {
    isConnected = false;
    el('connectionDot').classList.remove('live');
    el('connectionStatusText').textContent = 'Disconnected';
    updateUI();
});

// =======================================================
// RESOLVE TRADE STRATEGY BASED ON ENTRY DIGIT POSITION
// =======================================================
// UNCHANGED — this is the core entry logic. The entry digit
// (least frequent) tells us where the market has NOT been
// going. We use its position on the 0–9 number line to pick
// the contract most likely to win:
//
//   Digit 0–4  → market has skewed HIGH (low digits absent)
//               → trade UNDER 7 (wins on 0–6, 70% chance)
//
//   Digit 5    → neutral midpoint
//               → keep the manually selected strategy
//
//   Digit 6–9  → market has skewed LOW (high digits absent)
//               → trade OVER 2 (wins on 3–9, 70% chance)
//
// This overrides autoMode and manual strategy selection
// when the entry digit is in range 0–4 or 6–9.
// =======================================================

function resolveTradeStrategy(entryDigit) {
    if (entryDigit >= 0 && entryDigit <= 4) {
        return 'under7';
    } else if (entryDigit >= 6 && entryDigit <= 9) {
        return 'over2';
    } else {
        return activeStrategy;
    }
}

// =======================================================
// EXECUTE TRADE (UNCHANGED)
// =======================================================

async function executeTrade() {
    try {
        let resolvedStrategy = resolveTradeStrategy(leastFrequentDigit);
        let cfg = strategyConfig[resolvedStrategy];
        let tradeMarket = currentMarket, tradeStrategy = resolvedStrategy, tradeStake = currentStake;
        updateStatus('🚀 Digit ' + leastFrequentDigit + ' → ' + cfg.label + ' @ $' + tradeStake.toFixed(2) + '...');
        let proposal = await wsSendRequest({
            proposal: 1, amount: tradeStake, basis: 'stake',
            contract_type: cfg.contract_type, currency: 'USD',
            duration: 1, duration_unit: 't', barrier: cfg.barrier,
            underlying_symbol: tradeMarket
        });
        let buy = await wsSendRequest({ buy: proposal.proposal.id, price: tradeStake });
        let contractId = buy.buy.contract_id;
        console.log("BUY SUCCESS:", contractId, "| Strategy:", resolvedStrategy, "| Entry digit:", leastFrequentDigit);
        activeContracts[contractId] = { stake: tradeStake, strategy: tradeStrategy };
        wsSend({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
        el('activeStrategy').textContent = cfg.label + ' (digit ' + leastFrequentDigit + ')';
        updateStatus('⏳ Trade placed (#' + contractId + ') — digit ' + leastFrequentDigit + ' → ' + cfg.label + ' | awaiting result...');
    } catch (err) {
        console.error("TRADE ERROR:", err);
        updateStatus('❌ Trade failed: ' + err.message);
        isProcessingTrade = false;
    }
}

// =======================================================
// DIGIT ANALYSIS (UNCHANGED)
// =======================================================

function updateDigitAnalysis() {
    for (let i = 0; i <= 9; i++) digitFrequency[i] = 0;
    for (let d of tickHistory)   digitFrequency[d]++;
    let min = Infinity, least = 0;
    for (let d = 0; d <= 9; d++) { if (digitFrequency[d] < min) { min = digitFrequency[d]; least = d; } }
    leastFrequentDigit = least;
}

// =======================================================
// RENDER ENTRY DIGIT (replaces old full 10-digit grid)
// =======================================================

function renderEntryDigit() {
    let total = tickHistory.length;

    if (total === 0) {
        el('entryDigitNumber').textContent = '—';
        el('entryDigitPct').textContent = 'Waiting for ticks...';
        el('leastFrequentDigit').textContent = '⏳ Waiting for ticks...';
        return;
    }

    if (total < 20) {
        el('entryDigitNumber').textContent = leastFrequentDigit ?? '—';
        el('entryDigitPct').textContent = 'Building history... (' + total + '/20 ticks)';
        el('leastFrequentDigit').textContent = '⏳ Building history... (' + total + '/20 ticks)';
        return;
    }

    let pct = (digitFrequency[leastFrequentDigit] / total) * 100;
    let ready = pct < minFrequencyGap;

    el('entryDigitNumber').textContent = leastFrequentDigit;
    el('entryDigitPct').textContent = pct.toFixed(1) + '% frequency';

    let col = ready ? '#00e676' : '#facc15';
    el('leastFrequentDigit').innerHTML = (ready ? '✅' : '⏸') + ' Digit <strong style="color:' + col + ';font-size:1.1rem;">'
        + leastFrequentDigit + '</strong> = ' + pct.toFixed(1) + '% — '
        + (ready ? 'ENTRY READY' : 'waiting for lower frequency');
}

// =======================================================
// LIVE PRICE DISPLAY (UNCHANGED)
// =======================================================

function updateLivePriceDisplay() {
    if (currentPrice === null) return;
    let priceStr = currentPrice.toFixed(currentDecimalPlaces), lastIdx = priceStr.length - 1;
    el('livePriceDisplay').innerHTML = '<span style="color:#e2e8f0;">' + priceStr.slice(0, lastIdx) + '</span>'
        + '<span class="highlight-digit">' + priceStr.slice(lastIdx) + '</span>';
    el('currentLastDigit').textContent = currentLastDigit;
    el('livePriceDisplay').classList.add('tick-update');
    setTimeout(function () { el('livePriceDisplay').classList.remove('tick-update'); }, 300);
}

function getLastDigit(price) {
    let str = price.toFixed(currentDecimalPlaces).replace(/\./g, '');
    return str.charAt(str.length - 1);
}

// =======================================================
// TRADE HISTORY (UNCHANGED)
// =======================================================

function addHistoryItem(isWin, stake, profitLoss, contractId, strategy) {
    let container = el('historyContainer');
    let placeholder = container.querySelector('div[style]');
    if (placeholder && placeholder.textContent.trim() === 'No trades yet') placeholder.remove();
    let label = strategyConfig[strategy] ? strategyConfig[strategy].label : strategy;
    let time  = new Date().toLocaleTimeString();
    let badge = isWin
        ? '<span class="win-badge">✅ WIN +$' + Math.abs(profitLoss).toFixed(2) + '</span>'
        : '<span class="loss-badge">❌ LOSS -$' + stake.toFixed(2) + '</span>';
    let item = document.createElement('div');
    item.className = 'history-item ' + (isWin ? 'history-win' : 'history-loss');
    item.innerHTML = '<div><div class="history-price">' + label + '</div>'
        + '<div style="font-size:0.7rem;color:#6b7280;">' + time + ' · $' + stake.toFixed(2) + ' stake</div></div>'
        + '<div style="text-align:right;">' + badge
        + '<div style="font-size:0.65rem;color:#4b5563;margin-top:3px;">#' + contractId + '</div></div>';
    container.insertBefore(item, container.firstChild);
}

// =======================================================
// STATUS / UI
// =======================================================

function updateStatus(msg) { console.log("STATUS:", msg); if (el('tradeStatusMsg')) el('tradeStatusMsg').textContent = msg; }

function setBotStatus(text, cls) {
    let b = el('botStatus'); if (!b) return;
    b.textContent = text; b.className = 'bot-status' + (cls ? ' ' + cls : '');
}

function updateUI() {
    el('startBotBtn').disabled = !isConnected || isBotRunning;
    el('stopBotBtn').disabled  = !isBotRunning;
}

// =======================================================
// START / STOP BOT (UNCHANGED)
// =======================================================

function onStartBot() {
    if (!isConnected) { updateStatus('❌ Not connected'); return; }
    if (tickHistory.length < 20) { updateStatus('⏳ Need at least 20 ticks (' + tickHistory.length + '/20)'); return; }
    sessionStartBalance = balance;
    pauseTicksRemaining = 0;
    isBotRunning = true;
    setBotStatus('🤖 Bot Status: RUNNING', 'active');
    updateStatus('🤖 BOT STARTED');
    updateRiskUI(); updateUI();
}

function onStopBot() {
    isBotRunning = false; isProcessingTrade = false; pauseTicksRemaining = 0;
    setBotStatus('⏹ Bot Status: STOPPED', 'stopped');
    updateStatus('⏹️ BOT STOPPED'); updateUI();
}
