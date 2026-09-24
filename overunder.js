// =======================================================
// PIPSTRADES — OVER/UNDER BOT (base, reconstructed)
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

const minFrequencyGap     = 8.0;
const maxConsecLosses     = 2;
const pauseTicksAfterLoss = 30;

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
    'R_10': 4, 'R_25': 4, 'R_50': 4, 'R_75': 4, 'R_100': 4,
    '1HZ10V': 3, '1HZ25V': 3, '1HZ50V': 3, '1HZ75V': 3, '1HZ100V': 3
};
let currentDecimalPlaces  = marketDecimalFallback['R_10'];
let decimalPlacesDetected = false;

let baseStake            = 1.00;
let currentStake         = 1.00;
let tickHistory           = [];
let leastFrequentDigit    = null;
let currentTickSymbol     = '';

let totalTrades          = 0;
let totalWins            = 0;
let totalLosses          = 0;
let totalProfit          = 0;

let recoveryEnabled      = false;
let consecutiveLosses    = 0;

let autoModeEnabled      = false;
let pauseTicksRemaining  = 0;
const autoHysteresis     = 5.0;

let stopLossEnabled      = false;
let stopLossPct          = 10;
let takeProfitEnabled    = false;
let takeProfitPct        = 15;

let activeContracts      = {};

const marketNames = {
    'R_10': { name: 'Volatility 10' }, 'R_25': { name: 'Volatility 25' },
    'R_50': { name: 'Volatility 50' }, 'R_75': { name: 'Volatility 75' },
    'R_100': { name: 'Volatility 100' },
    '1HZ10V': { name: 'Volatility 10 (1s)' }, '1HZ25V': { name: 'Volatility 25 (1s)' },
    '1HZ50V': { name: 'Volatility 50 (1s)' }, '1HZ75V': { name: 'Volatility 75 (1s)' },
    '1HZ100V': { name: 'Volatility 100 (1s)' }
};

const strategyConfig = {
    'over2':  { contract_type: 'DIGITOVER',  barrier: '2', label: 'OVER 2'  },
    'under7': { contract_type: 'DIGITUNDER', barrier: '7', label: 'UNDER 7' }
};

let digitFrequency = { 0:0,1:0,2:0,3:0,4:0,5:0,6:0,7:0,8:0,9:0 };

function detectDecimalPlaces(quoteNumber) {
    let s = String(quoteNumber);
    let dot = s.indexOf('.');
    return dot === -1 ? 0 : s.length - dot - 1;
}

document.addEventListener('DOMContentLoaded', function () {
    initializeElements();
    setupEventListeners();
    renderEntryDigit();
    updateStatsUI();
    updateStrategyUI();
    updateRiskUI();
    updateUI();
    startConnection();
    initAi();
});

function initializeElements() {
    window.els = {
        connectionDot: document.getElementById('connectionDot'),
        connectionStatusText: document.getElementById('connectionStatusText'),
        balanceValue: document.getElementById('balanceValue'),
        totalTrades: document.getElementById('totalTrades'),
        totalWins: document.getElementById('totalWins'),
        totalLosses: document.getElementById('totalLosses'),
        winRate: document.getElementById('winRate'),
        totalProfit: document.getElementById('totalProfit'),
        recoveryModeStat: document.getElementById('recoveryModeStat'),
        marketSelect: document.getElementById('marketSelect'),
        marketInfo: document.getElementById('marketInfo'),
        marketLabel: document.getElementById('marketLabel'),
        livePriceDisplay: document.getElementById('livePriceDisplay'),
        currentLastDigit: document.getElementById('currentLastDigit'),
        stakeInput: document.getElementById('stakeInput'),
        expectedProfit: document.getElementById('expectedProfit'),
        stakeAmount: document.getElementById('stakeAmount'),
        recoveryToggle: document.getElementById('recoveryToggle'),
        recoveryInfo: document.getElementById('recoveryInfo'),
        recoveryStatusText: document.getElementById('recoveryStatusText'),
        consecutiveLosses: document.getElementById('consecutiveLossesCount'),
        nextStakeAmount: document.getElementById('nextStakeAmount'),
        autoModeToggle: document.getElementById('autoModeToggle'),
        autoModeInfo: document.getElementById('autoModeInfo'),
        marketBiasStatus: document.getElementById('marketBiasStatus'),
        autoCurrentStrategy: document.getElementById('autoCurrentStrategy'),
        over2Strength: document.getElementById('over2Strength'),
        under7Strength: document.getElementById('under7Strength'),
        optionOver2Btn: document.getElementById('optionOver2Btn'),
        optionUnder7Btn: document.getElementById('optionUnder7Btn'),
        entryDigitNumber: document.getElementById('entryDigitNumber'),
        entryDigitPct: document.getElementById('entryDigitPct'),
        leastFrequentDigit: document.getElementById('leastFrequentDigit'),
        activeStrategy: document.getElementById('activeStrategy'),
        startBotBtn: document.getElementById('startBotBtn'),
        stopBotBtn: document.getElementById('stopBotBtn'),
        botStatus: document.getElementById('botStatus'),
        tradeStatusMsg: document.getElementById('tradeStatusMsg'),
        historyContainer: document.getElementById('historyContainer'),
        clearHistoryBtn: document.getElementById('clearHistoryBtn'),
        stopLossToggle: document.getElementById('stopLossToggle'),
        stopLossPctInput: document.getElementById('stopLossPctInput'),
        takeProfitToggle: document.getElementById('takeProfitToggle'),
        takeProfitPctInput: document.getElementById('takeProfitPctInput'),
        riskStatusDisplay: document.getElementById('riskStatusDisplay')
    };
}

function el(id) { return window.els[id]; }

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
            el('stakeAmount').textContent = val.toFixed(2) + ' USD';
            updateRecoveryUI();
        }
    });

    el('marketSelect').addEventListener('change', function () {
        let newMarket = this.value;
        if (newMarket === currentMarket) return;
        currentMarket = newMarket;
        currentPrice = null; currentLastDigit = null;
        decimalPlacesDetected = false;
        currentDecimalPlaces = marketDecimalFallback[currentMarket] || 4;
        tickHistory = [];
        for (let i = 0; i <= 9; i++) digitFrequency[i] = 0;
        leastFrequentDigit = null;
        pauseTicksRemaining = 0;
        el('livePriceDisplay').innerHTML = '—';
        el('currentLastDigit').textContent = '—';
        let info = marketNames[currentMarket];
        if (info) {
            el('marketLabel').textContent = '📊 ' + info.name.toUpperCase() + ' LIVE PRICE';
            el('marketInfo').textContent = 'Current: ' + this.options[this.selectedIndex].text + ' — loading tick history...';
        }
        renderEntryDigit();
        if (isConnected) {
            preloadTickHistory().then(function () { subscribeTicks(); });
        }
    });

    el('recoveryToggle').addEventListener('change', function () {
        recoveryEnabled = this.checked;
        el('recoveryInfo').style.display = recoveryEnabled ? 'block' : 'none';
        el('recoveryStatusText').textContent = recoveryEnabled ? 'ON' : 'OFF';
        el('recoveryModeStat').textContent = recoveryEnabled ? 'ON' : 'OFF';
        if (!recoveryEnabled) { consecutiveLosses = 0; currentStake = baseStake; }
        updateRecoveryUI();
    });

    el('autoModeToggle').addEventListener('change', function () {
        autoModeEnabled = this.checked;
        el('autoModeInfo').style.display = autoModeEnabled ? 'block' : 'none';
        if (autoModeEnabled) updateAutoMode();
        updateStrategyUI();
    });

    el('optionOver2Btn').addEventListener('click', function () { setStrategy('over2'); });
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

function setStrategy(strategy) {
    if (autoModeEnabled) return;
    activeStrategy = strategy;
    updateStrategyUI();
}

function updateStrategyUI() {
    ['optionOver2Btn', 'optionUnder7Btn'].forEach(function (id) { el(id).classList.remove('active'); });
    let map = { over2: 'optionOver2Btn', under7: 'optionUnder7Btn' };
    if (map[activeStrategy]) el(map[activeStrategy]).classList.add('active');
    let cfg = strategyConfig[activeStrategy];
    if (cfg) el('activeStrategy').textContent = cfg.label;
}

function updateAutoMode() {
    if (!autoModeEnabled || tickHistory.length < 20) return;
    let recent = tickHistory.slice(-100);
    let over2cnt = recent.filter(function (d) { return d > 2; }).length;
    let under7cnt = recent.filter(function (d) { return d < 7; }).length;
    let over2pct = (over2cnt / recent.length) * 100;
    let under7pct = (under7cnt / recent.length) * 100;
    el('over2Strength').textContent = over2pct.toFixed(1) + '%';
    el('under7Strength').textContent = under7pct.toFixed(1) + '%';
    let newStrategy = activeStrategy;
    let diff = Math.abs(over2pct - under7pct);
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

function checkEntryConditions(lastDigit) {
    if (tickHistory.length < 20) return { allowed: false };
    if (lastDigit !== leastFrequentDigit) return { allowed: false };
    let total = tickHistory.length;
    let pct = (digitFrequency[leastFrequentDigit] / total) * 100;
    if (pct >= minFrequencyGap) return { allowed: false };
    if (pauseTicksRemaining > 0) return { allowed: false };
    return { allowed: true };
}

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

function updateRecoveryUI() {
    if (!recoveryEnabled) return;
    el('consecutiveLosses').textContent = consecutiveLosses;
    el('nextStakeAmount').textContent = '$' + currentStake.toFixed(2);
}

function onTradeWin(profit) {
    totalWins++; totalProfit += profit; consecutiveLosses = 0;
    pauseTicksRemaining = 0;
    if (recoveryEnabled) currentStake = baseStake;
    updateStatsUI(); updateRecoveryUI(); updateStakeDisplay(); updateRiskUI();
}

function onTradeLoss(loss) {
    totalLosses++; totalProfit -= loss; consecutiveLosses++;
    if (consecutiveLosses >= maxConsecLosses) pauseTicksRemaining = pauseTicksAfterLoss;
    if (recoveryEnabled) currentStake = parseFloat((currentStake * 2).toFixed(2));
    updateStatsUI(); updateRecoveryUI(); updateStakeDisplay(); updateRiskUI();
}

function updateStakeDisplay() {
    el('stakeInput').value = currentStake.toFixed(2);
    el('stakeAmount').textContent = currentStake.toFixed(2) + ' USD';
    el('expectedProfit').textContent = (currentStake * 0.95).toFixed(2);
}

function updateStatsUI() {
    totalTrades = totalWins + totalLosses;
    let rate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : '0';
    el('totalTrades').textContent = totalTrades;
    el('totalWins').textContent = totalWins;
    el('totalLosses').textContent = totalLosses;
    el('winRate').textContent = rate + '%';
    let p = el('totalProfit');
    p.textContent = (totalProfit >= 0 ? '+' : '') + '$' + totalProfit.toFixed(2);
    p.style.color = totalProfit >= 0 ? '#facc15' : '#ef4444';
}

async function startConnection() {
    if (!isAuthenticated()) { window.location.href = '/'; return; }
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

async function preloadTickHistory() {
    try {
        let response = await wsSendRequest({ ticks_history: currentMarket, end: 'latest', count: 150, style: 'ticks' });
        let prices = response.history.prices;
        let pipSize = response.pip_size;
        if (typeof pipSize === 'number') { currentDecimalPlaces = pipSize; decimalPlacesDetected = true; }
        tickHistory = prices.map(function (price) { return parseInt(getLastDigit(price), 10); }).filter(function (d) { return !isNaN(d); });
        if (tickHistory.length > 200) tickHistory = tickHistory.slice(-200);
        if (prices.length > 0) {
            currentPrice = prices[prices.length - 1];
            currentLastDigit = tickHistory[tickHistory.length - 1];
        }
        updateDigitAnalysis();
        renderEntryDigit();
        updateLivePriceDisplay();
        el('marketInfo').textContent = 'Current: ' + el('marketSelect').options[el('marketSelect').selectedIndex].text
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
            el('marketInfo').textContent = 'Current: ' + el('marketSelect').options[el('marketSelect').selectedIndex].text
                + ' — ' + currentDecimalPlaces + ' decimal places';
        }
    }

    let lastDigit = parseInt(getLastDigit(price));
    currentLastDigit = lastDigit;
    tickHistory.push(lastDigit);
    if (tickHistory.length > 200) tickHistory.shift();

    if (pauseTicksRemaining > 0) pauseTicksRemaining--;

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
        let stake = activeContracts[contractId].stake;
        let strat = activeContracts[contractId].strategy;
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

busOn('connection:error', () => {
    updateStatus('⚠️ Connection error');
});

busOn('connection:close', () => {
    isConnected = false;
    el('connectionDot').classList.remove('live');
    el('connectionStatusText').textContent = 'Disconnected';
    updateUI();
});

function resolveTradeStrategy(entryDigit) {
    if (entryDigit >= 0 && entryDigit <= 4) return 'under7';
    else if (entryDigit >= 6 && entryDigit <= 9) return 'over2';
    else return activeStrategy;
}

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

function updateDigitAnalysis() {
    for (let i = 0; i <= 9; i++) digitFrequency[i] = 0;
    for (let d of tickHistory) digitFrequency[d]++;
    let min = Infinity, least = 0;
    for (let d = 0; d <= 9; d++) { if (digitFrequency[d] < min) { min = digitFrequency[d]; least = d; } }
    leastFrequentDigit = least;
}

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
        + leastFrequentDigit + '</strong> = ' + pct.toFixed(1) + '% — ' + (ready ? 'ENTRY READY' : 'waiting for lower frequency');
}

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

function addHistoryItem(isWin, stake, profitLoss, contractId, strategy) {
    let container = el('historyContainer');
    let placeholder = container.querySelector('div[style]');
    if (placeholder && placeholder.textContent.trim() === 'No trades yet') placeholder.remove();
    let label = strategyConfig[strategy] ? strategyConfig[strategy].label : strategy;
    let time = new Date().toLocaleTimeString();
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

function updateStatus(msg) { if (el('tradeStatusMsg')) el('tradeStatusMsg').textContent = msg; }

function setBotStatus(text, cls) {
    let b = el('botStatus'); if (!b) return;
    b.textContent = text; b.className = 'bot-status' + (cls ? ' ' + cls : '');
}

function updateUI() {
    el('startBotBtn').disabled = !isConnected || isBotRunning;
    el('stopBotBtn').disabled = !isBotRunning;
}

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


// =========================================================================
// AI MARKET SCANNER — fully independent session, runs alongside the
// manual controls above. Reuses the EXACT SAME entry-logic building
// blocks already established for this bot (digit-frequency counting,
// the fixed 8% minimum-frequency-gap threshold, the fixed
// 2-losses/30-ticks pause rule) — just applied per-market instead of to
// one selected market, and gated on a barrier the USER chooses (digit +
// OVER/UNDER) instead of an auto-picked least-frequent digit.
//
// "Avoids bad markets": a market only becomes a trade candidate once the
// user's chosen barrier digit is currently trading BELOW the same 8%
// frequency threshold used elsewhere on this platform — the exact same
// statistical reasoning the manual Over/Under logic already relies on,
// just checked across every market instead of one.
// =========================================================================

const AI_ALL_MARKETS = [
    'R_10', '1HZ10V', 'R_25', '1HZ25V', 'R_50', '1HZ50V',
    'R_75', '1HZ75V', 'R_100', '1HZ100V'
];

const aiState = {
    running: false,
    tradeInFlight: false,
    connected: false,

    barrierDigit: 2,
    barrierDirection: 'over', // 'over' | 'under'

    marketStates: new Map(), // symbol -> { tickHistory, digitFrequency, pauseTicksRemaining, consecutiveLosses }

    baseStake: 1,
    currentStake: 1,
    recoveryEnabled: false,

    stopLossPct: 10,
    takeProfitPct: 15,
    sessionStartBalance: 0,

    trades: 0,
    wins: 0,
    losses: 0,
    pnl: 0,

    activeContracts: {} // contractId -> { stake, market }
};

let aiEls = {};

function initAi() {
    aiEls = {
        fab: document.getElementById('aiFab'),
        fabDot: document.getElementById('aiFabDot'),
        backdrop: document.getElementById('aiBackdrop'),
        panel: document.getElementById('aiPanel'),
        closeBtn: document.getElementById('aiCloseBtn'),
        directionSelect: document.getElementById('aiDirectionSelect'),
        digitSelect: document.getElementById('aiDigitSelect'),
        stakeInput: document.getElementById('aiStakeInput'),
        recoveryToggle: document.getElementById('aiRecoveryToggle'),
        stopLossInput: document.getElementById('aiStopLossInput'),
        takeProfitInput: document.getElementById('aiTakeProfitInput'),
        statTrades: document.getElementById('aiStatTrades'),
        statWins: document.getElementById('aiStatWins'),
        statLosses: document.getElementById('aiStatLosses'),
        statPnl: document.getElementById('aiStatPnl'),
        scanLine: document.getElementById('aiScanLine'),
        startBtn: document.getElementById('aiStartBtn'),
        stopBtn: document.getElementById('aiStopBtn')
    };

    aiEls.fab.addEventListener('click', () => openAiPanel());
    aiEls.closeBtn.addEventListener('click', () => closeAiPanel());
    aiEls.backdrop.addEventListener('click', () => closeAiPanel());

    aiEls.directionSelect.addEventListener('change', (e) => { aiState.barrierDirection = e.target.value; });
    aiEls.digitSelect.addEventListener('change', (e) => { aiState.barrierDigit = parseInt(e.target.value, 10); });

    aiEls.recoveryToggle.addEventListener('change', (e) => { aiState.recoveryEnabled = e.target.checked; });

    aiEls.startBtn.addEventListener('click', onAiStart);
    aiEls.stopBtn.addEventListener('click', onAiStop);

    // The AI connection reuses the SAME shared wsClient connection as the
    // manual section — it just adds its own tick subscriptions on top.
    busOn('connection:close', () => {
        aiState.connected = false;
        if (aiState.running) onAiStop();
        aiEls.startBtn.disabled = true;
    });
}

function openAiPanel() {
    aiEls.backdrop.classList.add('open');
    aiEls.panel.classList.add('open');
}
function closeAiPanel() {
    aiEls.backdrop.classList.remove('open');
    aiEls.panel.classList.remove('open');
}

// Called once the manual section's shared connection is up — the AI
// scanner rides on that same WebSocket, it just needs its own market
// history preloaded once the page knows it's connected.
busOn('connection:open', () => {
    aiState.connected = true;
    aiEls.startBtn.disabled = false;
});

// wsClient may not emit 'connection:open' if it already fired before
// initAi() ran — fall back to checking isConnected shortly after load.
setTimeout(() => {
    if (isConnected) {
        aiState.connected = true;
        if (aiEls.startBtn) aiEls.startBtn.disabled = false;
    }
}, 3000);

function createAiMarketState() {
    return {
        tickHistory: [],
        digitFrequency: { 0:0,1:0,2:0,3:0,4:0,5:0,6:0,7:0,8:0,9:0 },
        pauseTicksRemaining: 0,
        decimalPlaces: 4,
        decimalPlacesDetected: false
    };
}

async function aiPreloadMarket(symbol) {
    const ms = createAiMarketState();
    aiState.marketStates.set(symbol, ms);
    ms.decimalPlaces = marketDecimalFallback[symbol] || 4;

    try {
        const response = await wsSendRequest({ ticks_history: symbol, end: 'latest', count: 150, style: 'ticks' });
        const prices = response.history.prices;
        if (typeof response.pip_size === 'number') {
            ms.decimalPlaces = response.pip_size;
            ms.decimalPlacesDetected = true;
        }
        prices.forEach((price) => {
            const digit = aiGetLastDigit(price, ms.decimalPlaces);
            ms.tickHistory.push(digit);
            if (ms.tickHistory.length > 200) ms.tickHistory.shift();
        });
        aiRecalculateFrequency(ms);
    } catch (err) {
        console.error(`AI: tick history preload failed for ${symbol}:`, err);
    }
}

function aiGetLastDigit(price, decimals) {
    const str = Number(price).toFixed(decimals).replace(/\./g, '');
    return parseInt(str.charAt(str.length - 1), 10);
}

function aiRecalculateFrequency(ms) {
    for (let i = 0; i <= 9; i++) ms.digitFrequency[i] = 0;
    for (const d of ms.tickHistory) ms.digitFrequency[d]++;
}

// Reuses the SAME fixed 8% frequency-gap threshold already established
// for this bot's manual logic — a market is a "good" candidate only when
// the user's chosen barrier digit is currently below that threshold here.
function aiEvaluateMarket(symbol, ms) {
    if (ms.tickHistory.length < 20) return { ready: false, reason: 'collecting' };
    if (ms.pauseTicksRemaining > 0) return { ready: false, reason: 'paused' };

    const total = ms.tickHistory.length;
    const pct = (ms.digitFrequency[aiState.barrierDigit] / total) * 100;

    if (pct >= minFrequencyGap) return { ready: false, reason: 'above-threshold', pct };

    return { ready: true, pct };
}

busOn('tick', (tick) => {
    if (!aiState.running) return;
    const ms = aiState.marketStates.get(tick.symbol);
    if (!ms) return;

    const digit = aiGetLastDigit(tick.quote, ms.decimalPlaces);
    ms.tickHistory.push(digit);
    if (ms.tickHistory.length > 200) ms.tickHistory.shift();
    aiRecalculateFrequency(ms);

    if (ms.pauseTicksRemaining > 0) ms.pauseTicksRemaining--;

    aiScanAllMarkets();
});

function aiScanAllMarkets() {
    if (!aiState.running || aiState.tradeInFlight) return;
    if (!aiCheckSessionLimits()) return;

    let bestSymbol = null;
    let bestPct = Infinity;

    for (const symbol of AI_ALL_MARKETS) {
        const ms = aiState.marketStates.get(symbol);
        if (!ms) continue;
        const result = aiEvaluateMarket(symbol, ms);
        if (result.ready && result.pct < bestPct) {
            bestPct = result.pct;
            bestSymbol = symbol;
        }
    }

    if (bestSymbol) {
        aiEls.scanLine.innerHTML = `Best candidate: <strong>${bestSymbol}</strong> — digit ${aiState.barrierDigit} at ${bestPct.toFixed(1)}% (below ${minFrequencyGap}% threshold). Firing trade…`;
        aiExecuteTrade(bestSymbol);
    } else {
        aiEls.scanLine.textContent = `Scanning ${AI_ALL_MARKETS.length} markets — no market currently has digit ${aiState.barrierDigit} below ${minFrequencyGap}%.`;
    }
}

function aiCheckSessionLimits() {
    if (aiState.sessionStartBalance === 0) return true;
    const stopLossAmt = aiState.sessionStartBalance * (aiState.stopLossPct / 100);
    const takeProfitAmt = aiState.sessionStartBalance * (aiState.takeProfitPct / 100);
    if (aiState.pnl <= -stopLossAmt) {
        aiLog(`🛑 AI stop-loss hit (${aiState.stopLossPct}%). Stopping AI.`);
        onAiStop();
        return false;
    }
    if (aiState.pnl >= takeProfitAmt) {
        aiLog(`🎯 AI take-profit hit (${aiState.takeProfitPct}%). Stopping AI.`);
        onAiStop();
        return false;
    }
    return true;
}

async function aiExecuteTrade(symbol) {
    aiState.tradeInFlight = true;
    const ms = aiState.marketStates.get(symbol);
    const contractType = aiState.barrierDirection === 'over' ? 'DIGITOVER' : 'DIGITUNDER';
    const stake = aiState.currentStake;

    try {
        const proposal = await wsSendRequest({
            proposal: 1, amount: stake, basis: 'stake',
            contract_type: contractType, currency: 'USD',
            duration: 1, duration_unit: 't', barrier: String(aiState.barrierDigit),
            underlying_symbol: symbol
        });
        const buy = await wsSendRequest({ buy: proposal.proposal.id, price: stake });
        const contractId = buy.buy.contract_id;
        aiState.activeContracts[contractId] = { stake, market: symbol };
        wsSend({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
        aiLog(`[AI] Trade placed on ${symbol} — ${contractType.replace('DIGIT', '')} ${aiState.barrierDigit} @ $${stake.toFixed(2)} (#${contractId})`);
    } catch (err) {
        console.error('AI trade error:', err);
        aiLog(`[AI] Trade failed on ${symbol}: ${err.message}`);
        aiState.tradeInFlight = false;
    }
}

busOn('contractUpdate', (poc) => {
    const contractId = poc.contract_id;
    const meta = aiState.activeContracts[contractId];
    if (!meta) return; // not an AI contract — the manual handler already covers its own
    if (!(poc.is_sold || poc.status === 'won' || poc.status === 'lost')) return;

    const profit = parseFloat(poc.profit || 0);
    delete aiState.activeContracts[contractId];
    aiState.tradeInFlight = false;
    aiState.trades++;
    aiState.pnl += profit;

    const ms = aiState.marketStates.get(meta.market);

    if (poc.status === 'won') {
        aiState.wins++;
        if (ms) { ms.pauseTicksRemaining = 0; }
        if (aiState.recoveryEnabled) aiState.currentStake = aiState.baseStake;
        aiLog(`[AI] WIN +$${profit.toFixed(2)} on ${meta.market} — session P/L $${aiState.pnl.toFixed(2)}`);
        addHistoryItem(true, meta.stake, profit, contractId, 'ai-' + meta.market);
    } else {
        aiState.losses++;
        if (ms) {
            ms.consecutiveLossesAi = (ms.consecutiveLossesAi || 0) + 1;
            if (ms.consecutiveLossesAi >= maxConsecLosses) {
                ms.pauseTicksRemaining = pauseTicksAfterLoss;
                ms.consecutiveLossesAi = 0;
            }
        }
        if (aiState.recoveryEnabled) aiState.currentStake = parseFloat((aiState.currentStake * 2).toFixed(2));
        aiLog(`[AI] LOSS -$${meta.stake.toFixed(2)} on ${meta.market} — session P/L $${aiState.pnl.toFixed(2)}`);
        addHistoryItem(false, meta.stake, -meta.stake, contractId, 'ai-' + meta.market);
    }

    aiUpdateStats();
    aiScanAllMarkets();
});

function aiLog(msg) {
    console.log(msg);
    if (aiEls.scanLine) aiEls.scanLine.innerHTML = msg;
}

function aiUpdateStats() {
    aiEls.statTrades.textContent = aiState.trades;
    aiEls.statWins.textContent = aiState.wins;
    aiEls.statLosses.textContent = aiState.losses;
    aiEls.statPnl.textContent = aiState.pnl.toFixed(2);
    aiEls.statPnl.style.color = aiState.pnl >= 0 ? '#39ff14' : '#ff2d55';
}

async function onAiStart() {
    if (!isConnected) {
        aiLog('❌ Not connected yet.');
        return;
    }

    aiState.baseStake = parseFloat(aiEls.stakeInput.value) || 1;
    aiState.currentStake = aiState.baseStake;
    aiState.recoveryEnabled = aiEls.recoveryToggle.checked;
    aiState.stopLossPct = parseFloat(aiEls.stopLossInput.value) || 10;
    aiState.takeProfitPct = parseFloat(aiEls.takeProfitInput.value) || 15;
    aiState.sessionStartBalance = balance;
    aiState.trades = 0; aiState.wins = 0; aiState.losses = 0; aiState.pnl = 0;
    aiUpdateStats();

    aiEls.startBtn.disabled = true;
    aiEls.stopBtn.disabled = false;
    aiEls.fabDot.classList.add('running');
    aiEls.scanLine.textContent = `Loading history for ${AI_ALL_MARKETS.length} markets…`;

    await Promise.all(AI_ALL_MARKETS.map((symbol) => aiPreloadMarket(symbol)));
    AI_ALL_MARKETS.forEach((symbol) => wsSend({ ticks: symbol, subscribe: 1 }));

    aiState.running = true;
    aiEls.scanLine.textContent = `Scanning ${AI_ALL_MARKETS.length} markets for digit ${aiState.barrierDigit} ${aiState.barrierDirection === 'over' ? 'OVER' : 'UNDER'} opportunities…`;
    aiScanAllMarkets();
}

function onAiStop() {
    aiState.running = false;
    aiState.tradeInFlight = false;
    aiEls.startBtn.disabled = !isConnected;
    aiEls.stopBtn.disabled = true;
    aiEls.fabDot.classList.remove('running');
    aiEls.scanLine.textContent = 'AI scanner stopped.';
}
