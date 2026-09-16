/* =========================================================================
   PIPSTRADES — EVEN/ODD BOT
   Two independent, mutually-exclusive entry strategies:
     Alpha 1 (current, unchanged) — target = OPPOSITE parity of the single
       most-frequent digit; entry digit = least-frequent digit WITHIN that
       top digit's own parity group.
     Alpha 2 (new) — target = whichever parity (even/odd) leads in
       aggregate count; entry digit = least-frequent digit WITHIN THE
       OPPOSITE parity group from the target.
   Only one runs at a time — toggling one on switches the other off.
   Everything else (connection, staking, session limits, stats, log) is
   shared and unaffected by which strategy is active.
   ========================================================================= */

import { isAuthenticated, getToken } from '/src/core/auth/tokenManager.js';
import {
  connect as wsConnect,
  send as wsSend,
  sendRequest as wsSendRequest,
} from '/src/core/connection/wsClient.js';
import { on as busOn } from '/src/core/state/eventBus.js';
import { getAccountType } from '/src/core/state/accountPreference.js';

const CONFIG = {
  MIN_STAKE: 0.35
};

window.els = {
  connectionStatus: document.getElementById('connectionStatus'),
  balanceValue: document.getElementById('balanceValue'),
  currencyValue: document.getElementById('currencyValue'),

  alpha1Row: document.getElementById('alpha1Row'),
  alpha2Row: document.getElementById('alpha2Row'),
  alpha1Toggle: document.getElementById('alpha1Toggle'),
  alpha2Toggle: document.getElementById('alpha2Toggle'),

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

const state = {
  connected: false,
  botRunning: false,

  currency: null,
  balance: null,

  activeStrategy: 'alpha1', // 'alpha1' | 'alpha2' — mutually exclusive

  activeSymbol: 'R_75',
  decimalPlaces: null,
  digitHistory: [],
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
const MIN_SAMPLE_SIZE = 20;
const ODD_DIGITS = [1, 3, 5, 7, 9];
const EVEN_DIGITS = [0, 2, 4, 6, 8];

/* ---------------------------------------------------------------------
   LOGGING — shows only the most recent activity.
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
   CONNECTION STATUS UI
   --------------------------------------------------------------------- */
function setConnectionState(stateName) {
  const pill = window.els.connectionStatus;
  pill.dataset.state = stateName;
  const label = pill.querySelector('.status-label');
  const labels = { disconnected: 'Disconnected', connecting: 'Connecting…', connected: 'Connected' };
  label.textContent = labels[stateName] || stateName;
}

/* ---------------------------------------------------------------------
   CONNECTION — platform OAuth + shared wsClient
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
   PRELOAD TICK HISTORY — real Deriv history so the distribution is
   stable immediately instead of building live from zero.
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
   EVENT BUS LISTENERS
   --------------------------------------------------------------------- */
busOn('balance', (balance) => handleBalance(balance));
busOn('tick', (tick) => handleTick(tick));
busOn('proposal', (proposal) => handleProposal(proposal));
busOn('buy', (buy) => handleBuy(buy));
busOn('contractUpdate', (poc) => handleProposalOpenContract(poc));

/* ---------------------------------------------------------------------
   BALANCE
   --------------------------------------------------------------------- */
function handleBalance(balance) {
  if (!balance) return;
  state.balance = balance.balance;
  state.currency = balance.currency;
  window.els.balanceValue.textContent = Number(balance.balance).toFixed(2);
  window.els.currencyValue.textContent = balance.currency;
}

/* ---------------------------------------------------------------------
   TICKS
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
   ALPHA 1 — CURRENT strategy, UNCHANGED math.
   Target = OPPOSITE parity of the single most-frequent digit.
   Entry digit = least-frequent digit WITHIN that top digit's own
   parity group.
   --------------------------------------------------------------------- */
function resolveAlpha1Strategy() {
  if (state.digitHistory.length < MIN_SAMPLE_SIZE) {
    return { status: 'collecting', sample: state.digitHistory.length };
  }

  const counts = state.digitCounts;

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

  const topIsOdd = topDigit % 2 !== 0;
  const targetContract = topIsOdd ? 'EVEN' : 'ODD';
  const group = topIsOdd ? ODD_DIGITS : EVEN_DIGITS;

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

/* ---------------------------------------------------------------------
   ALPHA 2 — NEW strategy.
   Target = whichever parity (EVEN/ODD) leads in AGGREGATE count.
   Entry digit = least-frequent digit WITHIN THE OPPOSITE parity group
   from the target.
   --------------------------------------------------------------------- */
function resolveAlpha2Strategy() {
  if (state.digitHistory.length < MIN_SAMPLE_SIZE) {
    return { status: 'collecting', sample: state.digitHistory.length };
  }

  const counts = state.digitCounts;

  let evenCount = 0;
  for (let d = 0; d <= 9; d += 2) evenCount += counts[d];
  const oddCount = state.digitHistory.length - evenCount;
  if (evenCount === oddCount) return { status: 'ambiguous' };
  const targetContract = evenCount > oddCount ? 'EVEN' : 'ODD';

  const oppositeGroup = targetContract === 'EVEN' ? ODD_DIGITS : EVEN_DIGITS;
  let entryDigit = null;
  let minCount = Infinity;
  let minTie = false;
  oppositeGroup.forEach((d) => {
    if (counts[d] < minCount) {
      minCount = counts[d];
      entryDigit = d;
      minTie = false;
    } else if (counts[d] === minCount) {
      minTie = true;
    }
  });
  if (minTie) return { status: 'ambiguous' };

  return {
    status: 'ready',
    entryDigit,
    targetContract,
    evenCount,
    oddCount
  };
}

/* ---------------------------------------------------------------------
   Dispatch to whichever strategy is currently active.
   --------------------------------------------------------------------- */
function resolveActiveStrategy() {
  return state.activeStrategy === 'alpha2' ? resolveAlpha2Strategy() : resolveAlpha1Strategy();
}

function evaluateEntrySignal() {
  renderStrategyStatus();

  if (!state.botRunning) return;
  if (state.awaitingProposal || state.awaitingBuy || state.pendingContractId) return;

  const strategy = resolveActiveStrategy();
  if (strategy.status !== 'ready') return;

  if (state.lastDigit === strategy.entryDigit) {
    fireTrade(strategy.targetContract);
  }
}

/* ---------------------------------------------------------------------
   STRATEGY TOGGLES — mutually exclusive, always exactly one active.
   --------------------------------------------------------------------- */
function setActiveStrategy(name) {
  state.activeStrategy = name;
  window.els.alpha1Toggle.checked = name === 'alpha1';
  window.els.alpha2Toggle.checked = name === 'alpha2';
  window.els.alpha1Row.classList.toggle('active', name === 'alpha1');
  window.els.alpha2Row.classList.toggle('active', name === 'alpha2');
  renderStrategyStatus();
}

window.els.alpha1Toggle.addEventListener('change', (e) => {
  if (e.target.checked) {
    setActiveStrategy('alpha1');
  } else {
    // Exactly one must always be active — refuse to leave both off.
    e.target.checked = true;
  }
});

window.els.alpha2Toggle.addEventListener('change', (e) => {
  if (e.target.checked) {
    setActiveStrategy('alpha2');
  } else {
    e.target.checked = true;
  }
});

/* ---------------------------------------------------------------------
   PROPOSAL -> BUY -> PROPOSAL_OPEN_CONTRACT
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

  log(`Signal confirmed (${state.activeStrategy}) — requesting ${parity} proposal (stake ${state.currentStake.toFixed(2)}).`, 'info');
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
   STATS / SESSION LIMITS
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
   TRADE SIDE STATUS (auto-computed display, per active strategy)
   --------------------------------------------------------------------- */
function renderStrategyStatus() {
  const strategy = resolveActiveStrategy();

  if (strategy.status === 'collecting') {
    window.els.patternNote.textContent =
      `[${state.activeStrategy.toUpperCase()}] Collecting live digit data… (${strategy.sample}/${MIN_SAMPLE_SIZE} ticks)`;
    return;
  }

  if (strategy.status === 'ambiguous') {
    window.els.patternNote.textContent =
      `[${state.activeStrategy.toUpperCase()}] Distribution is tied — waiting for a clear signal.`;
    return;
  }

  if (state.activeStrategy === 'alpha1') {
    window.els.patternNote.textContent =
      `[ALPHA 1] Top digit ${strategy.topDigit} (${strategy.topParity}) is most frequent → target ${strategy.targetContract}. ` +
      `Entry digit ${strategy.entryDigit} (least-frequent ${strategy.topParity.toLowerCase()} digit) → buy ${strategy.targetContract}.`;
  } else {
    const evenPct = ((strategy.evenCount / state.digitHistory.length) * 100).toFixed(1);
    const oddPct = ((strategy.oddCount / state.digitHistory.length) * 100).toFixed(1);
    const oppositeParity = strategy.targetContract === 'EVEN' ? 'odd' : 'even';
    window.els.patternNote.textContent =
      `[ALPHA 2] ${strategy.targetContract} digits lead overall (${strategy.targetContract === 'EVEN' ? evenPct : oddPct}% ` +
      `vs ${strategy.targetContract === 'EVEN' ? oddPct : evenPct}%) → trading ${strategy.targetContract}. ` +
      `Entry digit ${strategy.entryDigit} is the least-frequent ${oppositeParity} digit → buy ${strategy.targetContract}.`;
  }
}

/* ---------------------------------------------------------------------
   START / STOP BOT
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

  log(`Bot started — ${state.activeStrategy} strategy on ${state.activeSymbol}.`, 'info');
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
