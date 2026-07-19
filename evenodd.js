/* =========================================================================
   PIPSTRADES — EVEN/ODD BOT (connection section replaced only)
   =========================================================================
   Uses the platform's shared OAuth session + WebSocket connection instead
   of a manual API Token / App ID / Account ID form.

   UNCHANGED from the original bot: pattern-based entry logic
   (checkPatternMatch), resolveTradeStrategy, auto-mode contrarian pick,
   martingale staking, session stop-loss/take-profit, loss-pause, digit
   chart, parity summary, and all stats.
   ========================================================================= */

import { isAuthenticated, getToken } from '/src/core/auth/tokenManager.js';
import {
  connect as wsConnect,
  send as wsSend,
  sendRequest as wsSendRequest,
} from '/src/core/connection/wsClient.js';
import { on as busOn } from '/src/core/state/eventBus.js';
import { getAccountType } from '/src/core/state/accountPreference.js';

/* ---------------------------------------------------------------------
   CONFIG
   --------------------------------------------------------------------- */
const CONFIG = {
  MIN_STAKE: 0.35
};

/* ---------------------------------------------------------------------
   ELEMENT CACHE (window.els, not window.el)
   --------------------------------------------------------------------- */
window.els = {
  connectionStatus: document.getElementById('connectionStatus'),
  balanceValue: document.getElementById('balanceValue'),
  currencyValue: document.getElementById('currencyValue'),

  evenBtn: document.getElementById('evenBtn'),
  oddBtn: document.getElementById('oddBtn'),

  symbolSelect: document.getElementById('symbolSelect'),
  stakeInput: document.getElementById('stakeInput'),
  durationInput: document.getElementById('durationInput'),
  durationUnit: document.getElementById('durationUnit'),
  martingaleInput: document.getElementById('martingaleInput'),
  lossPauseInput: document.getElementById('lossPauseInput'),
  stopLossInput: document.getElementById('stopLossInput'),
  takeProfitInput: document.getElementById('takeProfitInput'),
  patternNote: document.getElementById('patternNote'),

  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),

  activeSymbolTag: document.getElementById('activeSymbolTag'),
  lastDigitValue: document.getElementById('lastDigitValue'),
  lastDigitParity: document.getElementById('lastDigitParity'),
  lastQuoteValue: document.getElementById('lastQuoteValue'),
  livePriceLabel: document.getElementById('livePriceLabel'),
  livePriceLastDigit: document.getElementById('livePriceLastDigit'),
  digitChart: document.getElementById('digitChart'),
  evenCount: document.getElementById('evenCount'),
  oddCount: document.getElementById('oddCount'),
  evenPct: document.getElementById('evenPct'),
  oddPct: document.getElementById('oddPct'),

  statTrades: document.getElementById('statTrades'),
  statWins: document.getElementById('statWins'),
  statLosses: document.getElementById('statLosses'),
  statWinRate: document.getElementById('statWinRate'),
  statPnl: document.getElementById('statPnl'),
  statCurrentStake: document.getElementById('statCurrentStake'),

  logConsole: document.getElementById('logConsole'),
  clearLogBtn: document.getElementById('clearLogBtn')
};

/* ---------------------------------------------------------------------
   STATE
   --------------------------------------------------------------------- */
const state = {
  connected: false,
  botRunning: false,

  currency: null,
  balance: null,

  activeSymbol: 'R_75',
  decimalPlaces: null,           // auto-detected from live ticks
  digitHistory: [],              // rolling window of last digits
  digitCounts: new Array(10).fill(0),
  lastDigit: null,

  baseStake: 1,
  currentStake: 1,
  consecutiveLosses: 0,

  sessionPnl: 0,
  trades: 0,
  wins: 0,
  losses: 0,

  pendingContractId: null,
  awaitingProposal: false,
  awaitingBuy: false
};

const HISTORY_WINDOW = 100;

/* ---------------------------------------------------------------------
   LOGGING (unchanged)
   --------------------------------------------------------------------- */
function log(message, level = 'info') {
  const time = new Date().toLocaleTimeString();
  window.els.logConsole.innerHTML = '';
  const line = document.createElement('div');
  line.className = `log-line log-${level}`;
  line.innerHTML = `<span class="log-time">${time}</span>${escapeHtml(message)}`;
  window.els.logConsole.appendChild(line);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

window.els.clearLogBtn.addEventListener('click', () => {
  window.els.logConsole.innerHTML = '';
});

/* ---------------------------------------------------------------------
   CONNECTION STATUS UI (unchanged)
   --------------------------------------------------------------------- */
function setConnectionState(stateName) {
  const pill = window.els.connectionStatus;
  pill.dataset.state = stateName;
  const label = pill.querySelector('.status-label');
  const labels = { disconnected: 'Disconnected', connecting: 'Connecting…', connected: 'Connected' };
  label.textContent = labels[stateName] || stateName;
}

/* ---------------------------------------------------------------------
   CONNECTION — via platform OAuth session + shared wsClient
   (replaces the old API Token / App ID / Account ID form entirely)
   --------------------------------------------------------------------- */
async function startConnection() {
  if (!isAuthenticated()) {
    window.location.href = '/';
    return;
  }

  setConnectionState('connecting');
  log('Connecting to your Deriv account…', 'info');

  try {
    const token = getToken();
    await wsConnect(token, getAccountType());

    state.connected = true;
    setConnectionState('connected');
    const accountLabel = getAccountType() === 'real' ? 'Real' : 'Demo';
    log(`Connected (${accountLabel}).`, 'info');
    if (getAccountType() === 'real') {
      window.els.connectionStatus.querySelector('.status-label').textContent = 'Connected · Real';
      window.els.connectionStatus.querySelector('.status-label').style.color = 'var(--red)';
    }

    window.els.startBtn.disabled = false;

    subscribeBalance();
    await subscribeTicks(window.els.symbolSelect.value);
  } catch (err) {
    log(`Connection failed: ${err.message}`, 'error');
    setConnectionState('disconnected');
  }
}

busOn('connection:close', () => {
  state.connected = false;
  setConnectionState('disconnected');
  log('Connection closed.', 'warn');
  if (state.botRunning) stopBot();
  window.els.startBtn.disabled = true;
});

busOn('connection:error', (err) => {
  log(`Connection error: ${err.message || err}`, 'error');
});

/* ---------------------------------------------------------------------
   REQUEST HELPERS
   --------------------------------------------------------------------- */
function subscribeBalance() {
  wsSend({ balance: 1, subscribe: 1 });
}

/* ---------------------------------------------------------------------
   PRELOAD TICK HISTORY — fetches Deriv's own recent tick history so the
   digit distribution and target/entry digits are stable immediately,
   instead of starting at 0 and drifting as live ticks slowly accumulate.
   --------------------------------------------------------------------- */
async function preloadTickHistory(symbol) {
  try {
    const response = await wsSendRequest({
      ticks_history: symbol,
      end: 'latest',
      count: 150,
      style: 'ticks'
    });

    const prices = response.history.prices;
    const pipSize = response.pip_size;

    if (typeof pipSize === 'number') {
      state.decimalPlaces = pipSize;
    }
    const decimals = state.decimalPlaces !== null ? state.decimalPlaces : 4;

    prices.forEach((price) => {
      const quoteStr = Number(price).toFixed(decimals);
      const lastChar = quoteStr.replace('.', '').slice(-1);
      const digit = parseInt(lastChar, 10);
      if (Number.isNaN(digit)) return;
      state.digitHistory.push(digit);
      if (state.digitHistory.length > HISTORY_WINDOW) {
        const removed = state.digitHistory.shift();
        state.digitCounts[removed]--;
      }
      state.digitCounts[digit]++;
      state.lastDigit = digit;
    });

    if (prices.length > 0) {
      const quoteStr = Number(prices[prices.length - 1]).toFixed(decimals);
      window.els.lastQuoteValue.textContent = quoteStr;
      window.els.livePriceLastDigit.textContent = state.lastDigit;
      window.els.livePriceLastDigit.style.color = state.lastDigit % 2 === 0 ? 'var(--cyan)' : 'var(--magenta)';
      updateLastDigitDisplay(state.lastDigit);
    }

    renderDigitChart();
    updateParitySummary();
    renderStrategyStatus();

    log(`Loaded ${state.digitHistory.length} recent ticks from Deriv for ${symbol}.`, 'info');
  } catch (err) {
    console.error('Tick history preload failed:', err);
    log('Could not preload tick history — building live instead.', 'warn');
  }
}

async function subscribeTicks(symbol) {
  // Reset digit history whenever the symbol changes so stale data from a
  // different market never leaks into the current chart or trade logic.
  state.activeSymbol = symbol;
  state.decimalPlaces = null;
  state.digitHistory = [];
  state.digitCounts = new Array(10).fill(0);
  state.lastDigit = null;
  window.els.activeSymbolTag.textContent = symbol;
  updateLivePriceLabel();
  window.els.lastQuoteValue.textContent = '--';
  window.els.livePriceLastDigit.textContent = '-';
  renderDigitChart();
  updateParitySummary();
  renderStrategyStatus();

  await preloadTickHistory(symbol);

  wsSend({ ticks: symbol, subscribe: 1 });
  log(`Subscribed to live ticks for ${symbol}.`, 'info');
}

function updateLivePriceLabel() {
  const select = window.els.symbolSelect;
  const selectedOption = select.options[select.selectedIndex];
  const marketName = selectedOption ? selectedOption.textContent : state.activeSymbol;
  window.els.livePriceLabel.textContent = `${marketName} Live Price`;
}

window.els.symbolSelect.addEventListener('change', (e) => {
  if (state.connected) subscribeTicks(e.target.value);
});

/* ---------------------------------------------------------------------
   EVENT BUS LISTENERS (replaces old raw ws.onmessage routing)
   --------------------------------------------------------------------- */
busOn('balance', (balance) => handleBalance(balance));
busOn('tick', (tick) => handleTick(tick));
busOn('proposal', (proposal) => handleProposal(proposal));
busOn('buy', (buy) => handleBuy(buy));
busOn('contractUpdate', (poc) => handleProposalOpenContract(poc));

/* ---------------------------------------------------------------------
   BALANCE (unchanged)
   --------------------------------------------------------------------- */
function handleBalance(balance) {
  if (!balance) return;
  state.balance = balance.balance;
  state.currency = balance.currency;
  window.els.balanceValue.textContent = Number(balance.balance).toFixed(2);
  window.els.currencyValue.textContent = balance.currency;
}

/* ---------------------------------------------------------------------
   TICKS (unchanged)
   --------------------------------------------------------------------- */
function handleTick(tick) {
  if (!tick || tick.symbol !== state.activeSymbol) return;

  if (typeof tick.pip_size === 'number') {
    state.decimalPlaces = tick.pip_size;
  } else if (state.decimalPlaces === null) {
    const raw = String(tick.quote);
    const parts = raw.split('.');
    state.decimalPlaces = parts[1] ? parts[1].length : 0;
  }

  const quoteStr = Number(tick.quote).toFixed(state.decimalPlaces);
  const lastChar = quoteStr.replace('.', '').slice(-1);
  const digit = parseInt(lastChar, 10);
  if (Number.isNaN(digit)) return;

  state.lastDigit = digit;
  state.digitHistory.push(digit);
  if (state.digitHistory.length > HISTORY_WINDOW) {
    const removed = state.digitHistory.shift();
    state.digitCounts[removed]--;
  }
  state.digitCounts[digit]++;

  window.els.lastQuoteValue.textContent = quoteStr;
  window.els.livePriceLastDigit.textContent = digit;
  window.els.livePriceLastDigit.style.color = digit % 2 === 0 ? 'var(--cyan)' : 'var(--magenta)';
  updateLastDigitDisplay(digit);
  renderDigitChart();
  updateParitySummary();

  evaluateEntrySignal();
}

function updateLastDigitDisplay(digit) {
  const parity = digit % 2 === 0 ? 'EVEN' : 'ODD';
  window.els.lastDigitValue.textContent = digit;
  window.els.lastDigitParity.textContent = parity;
  window.els.lastDigitParity.style.color = parity === 'EVEN' ? 'var(--cyan)' : 'var(--magenta)';
}

function renderDigitChart() {
  const container = window.els.digitChart;
  container.innerHTML = '';

  for (let d = 0; d <= 9; d++) {
    const count = state.digitCounts[d];
    const isOdd = d % 2 !== 0;

    const tile = document.createElement('div');
    tile.className = 'digit-tile' + (isOdd ? ' odd-digit' : '');

    const digitEl = document.createElement('span');
    digitEl.className = 'digit-tile-digit';
    digitEl.textContent = d;

    const countEl = document.createElement('span');
    countEl.className = 'digit-tile-count';
    countEl.textContent = count;

    tile.appendChild(digitEl);
    tile.appendChild(countEl);
    container.appendChild(tile);
  }
}

function updateParitySummary() {
  const total = state.digitHistory.length;
  let evenCount = 0;
  for (let d = 0; d <= 9; d += 2) evenCount += state.digitCounts[d];
  const oddCount = total - evenCount;

  window.els.evenCount.textContent = evenCount;
  window.els.oddCount.textContent = oddCount;
  window.els.evenPct.textContent = total ? `${((evenCount / total) * 100).toFixed(1)}%` : '0%';
  window.els.oddPct.textContent = total ? `${((oddCount / total) * 100).toFixed(1)}%` : '0%';
}

/* ---------------------------------------------------------------------
   TRADE STRATEGY — distribution-driven entry
   ---------------------------------------------------------------------
   1. Find the digit (0-9) with the highest occurrence count in the
      rolling window — the "top digit".
   2. Its parity decides the target contract:
        top digit is ODD  → target EVEN
        top digit is EVEN → target ODD
   3. Within that same parity group as the top digit, find the digit
      with the LOWEST occurrence count — the "entry digit".
   4. Every tick, check if the just-arrived digit equals the entry
      digit. If it does (and the condition above still holds), fire the
      trade for the target contract immediately, on that same tick.

   Example: top digit = 3 (ODD, most frequent) → target EVEN,
            entry digit = 7 (least frequent ODD digit) → buy EVEN the
            instant a "7" ticks in.
   --------------------------------------------------------------------- */

const MIN_SAMPLE_SIZE = 20; // don't act on a distribution with too little data

const ODD_DIGITS = [1, 3, 5, 7, 9];
const EVEN_DIGITS = [0, 2, 4, 6, 8];

function resolveDistributionStrategy() {
  if (state.digitHistory.length < MIN_SAMPLE_SIZE) {
    return { status: 'collecting', sample: state.digitHistory.length };
  }

  const counts = state.digitCounts;

  // Step 1: find the single most frequent digit. If there's a tie for
  // the top spot, the signal is ambiguous — skip this tick.
  let topDigit = null;
  let topCount = -1;
  let topTie = false;
  for (let d = 0; d <= 9; d++) {
    if (counts[d] > topCount) {
      topCount = counts[d];
      topDigit = d;
      topTie = false;
    } else if (counts[d] === topCount) {
      topTie = true;
    }
  }
  if (topTie) return { status: 'ambiguous' };

  // Step 2: top digit's parity decides the target contract.
  const topIsOdd = topDigit % 2 !== 0;
  const targetContract = topIsOdd ? 'EVEN' : 'ODD';
  const group = topIsOdd ? ODD_DIGITS : EVEN_DIGITS;

  // Step 3: within that same parity group, find the least frequent digit.
  let entryDigit = null;
  let minCount = Infinity;
  group.forEach((d) => {
    if (counts[d] < minCount) {
      minCount = counts[d];
      entryDigit = d;
    }
  });

  return {
    status: 'ready',
    topDigit,
    topParity: topIsOdd ? 'ODD' : 'EVEN',
    targetContract,
    entryDigit
  };
}

function evaluateEntrySignal() {
  renderStrategyStatus();

  if (!state.botRunning) return;
  if (state.awaitingProposal || state.awaitingBuy || state.pendingContractId) return;

  const strategy = resolveDistributionStrategy();
  if (strategy.status !== 'ready') return;

  // Fire the instant the just-arrived digit matches the computed entry digit.
  if (state.lastDigit === strategy.entryDigit) {
    fireTrade(strategy.targetContract);
  }
}

/* ---------------------------------------------------------------------
   PROPOSAL -> BUY -> PROPOSAL_OPEN_CONTRACT (UNCHANGED)
   --------------------------------------------------------------------- */
function fireTrade(parity) {
  const contractType = parity === 'EVEN' ? 'DIGITEVEN' : 'DIGITODD';

  state.awaitingProposal = true;
  state.pendingParity = parity;

  wsSend({
    proposal: 1,
    amount: Number(state.currentStake.toFixed(2)),
    basis: 'stake',
    contract_type: contractType,
    currency: state.currency || 'USD',
    duration: Number(window.els.durationInput.value),
    duration_unit: window.els.durationUnit.value,
    underlying_symbol: state.activeSymbol
  });

  log(`Signal confirmed — requesting ${parity} proposal (stake ${state.currentStake.toFixed(2)}).`, 'info');
}

function handleProposal(proposal) {
  if (!state.awaitingProposal || !proposal) return;
  state.awaitingProposal = false;
  state.awaitingBuy = true;

  wsSend({
    buy: proposal.id,
    price: proposal.ask_price
  });
}

function handleBuy(buy) {
  state.awaitingBuy = false;
  if (!buy) return;

  state.pendingContractId = buy.contract_id;
  state.trades++;
  window.els.statTrades.textContent = state.trades;
  window.els.statCurrentStake.textContent = state.currentStake.toFixed(2);

  log(`Bought contract #${buy.contract_id} — ${state.pendingParity} @ stake ${state.currentStake.toFixed(2)}.`, 'info');

  wsSend({
    proposal_open_contract: 1,
    contract_id: buy.contract_id,
    subscribe: 1
  });
}

function handleProposalOpenContract(poc) {
  if (!poc || poc.contract_id !== state.pendingContractId) return;
  if (!poc.is_sold) return;

  const profit = Number(poc.profit);
  const won = profit > 0;

  state.sessionPnl += profit;
  state.pendingContractId = null;

  if (won) {
    state.wins++;
    state.consecutiveLosses = 0;
    state.currentStake = state.baseStake;
    log(`Contract #${poc.contract_id} WON — profit ${profit.toFixed(2)}.`, 'win');
  } else {
    state.losses++;
    state.consecutiveLosses++;
    const multiplier = Number(window.els.martingaleInput.value) || 1;
    state.currentStake = Number((state.currentStake * multiplier).toFixed(2));
    log(`Contract #${poc.contract_id} LOST — loss ${profit.toFixed(2)}. Next stake ${state.currentStake.toFixed(2)}.`, 'loss');
  }

  updateStatsUI();
  checkSessionLimits();
  checkLossPause();
}

/* ---------------------------------------------------------------------
   STATS / SESSION LIMITS (UNCHANGED)
   --------------------------------------------------------------------- */
function updateStatsUI() {
  window.els.statWins.textContent = state.wins;
  window.els.statLosses.textContent = state.losses;
  const rate = state.trades ? ((state.wins / state.trades) * 100).toFixed(1) : '0.0';
  window.els.statWinRate.textContent = `${rate}%`;
  window.els.statPnl.textContent = state.sessionPnl.toFixed(2);
  window.els.statPnl.style.color = state.sessionPnl >= 0 ? 'var(--green)' : 'var(--red)';
  window.els.statCurrentStake.textContent = state.currentStake.toFixed(2);
}

function checkSessionLimits() {
  const stopLoss = Number(window.els.stopLossInput.value);
  const takeProfit = Number(window.els.takeProfitInput.value);

  if (stopLoss > 0 && state.sessionPnl <= -Math.abs(stopLoss)) {
    log(`Session stop-loss of ${stopLoss} reached. Stopping bot.`, 'warn');
    stopBot();
  } else if (takeProfit > 0 && state.sessionPnl >= Math.abs(takeProfit)) {
    log(`Session take-profit of ${takeProfit} reached. Stopping bot.`, 'win');
    stopBot();
  }
}

function checkLossPause() {
  const pauseAfter = Number(window.els.lossPauseInput.value);
  if (pauseAfter > 0 && state.consecutiveLosses >= pauseAfter) {
    log(`${state.consecutiveLosses} consecutive losses reached. Pausing bot.`, 'warn');
    stopBot();
  }
}

/* ---------------------------------------------------------------------
   TRADE SIDE STATUS (auto-computed — no manual controls)
   --------------------------------------------------------------------- */
function renderStrategyStatus() {
  const strategy = resolveDistributionStrategy();

  if (strategy.status === 'collecting') {
    window.els.evenBtn.classList.remove('active');
    window.els.oddBtn.classList.remove('active');
    window.els.patternNote.textContent =
      `Collecting live digit data… (${strategy.sample}/${MIN_SAMPLE_SIZE} ticks)`;
    return;
  }

  if (strategy.status === 'ambiguous') {
    window.els.evenBtn.classList.remove('active');
    window.els.oddBtn.classList.remove('active');
    window.els.patternNote.textContent =
      'Top digit is tied between multiple digits — waiting for a clear leader.';
    return;
  }

  window.els.evenBtn.classList.toggle('active', strategy.targetContract === 'EVEN');
  window.els.oddBtn.classList.toggle('active', strategy.targetContract === 'ODD');
  window.els.patternNote.textContent =
    `Top digit ${strategy.topDigit} (${strategy.topParity}) is most frequent → ` +
    `target ${strategy.targetContract}. Waiting for entry digit ${strategy.entryDigit} ` +
    `(least-frequent ${strategy.topParity.toLowerCase()} digit) to buy ${strategy.targetContract}.`;
}

/* ---------------------------------------------------------------------
   START / STOP BOT (UNCHANGED)
   --------------------------------------------------------------------- */
function startBot() {
  if (!state.connected) {
    log('Not connected yet — please wait.', 'warn');
    return;
  }

  const stake = Number(window.els.stakeInput.value);
  if (!stake || stake < CONFIG.MIN_STAKE) {
    log(`Stake must be at least ${CONFIG.MIN_STAKE}.`, 'warn');
    return;
  }

  state.baseStake = stake;
  state.currentStake = stake;
  state.consecutiveLosses = 0;
  state.sessionPnl = 0;
  state.trades = 0;
  state.wins = 0;
  state.losses = 0;
  state.pendingContractId = null;

  state.botRunning = true;
  updateStatsUI();

  window.els.startBtn.classList.add('hidden');
  window.els.stopBtn.classList.remove('hidden');

  log(`Bot started — distribution-driven auto strategy on ${state.activeSymbol}.`, 'info');
}

function stopBot() {
  state.botRunning = false;
  window.els.startBtn.classList.remove('hidden');
  window.els.stopBtn.classList.add('hidden');
  log('Bot stopped.', 'warn');
}

window.els.startBtn.addEventListener('click', startBot);
window.els.stopBtn.addEventListener('click', stopBot);

/* ---------------------------------------------------------------------
   INIT
   --------------------------------------------------------------------- */
updateLivePriceLabel();
renderDigitChart();
updateParitySummary();
renderStrategyStatus();
setConnectionState('disconnected');
log('Connecting to your Deriv account…', 'info');
startConnection();
