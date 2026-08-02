/* =========================================================
   PIPSTRADES — RISE/FALL AUTOBOT
   Connection: platform OAuth + shared wsClient (not a manual
   API Token / App ID / Account ID form).
   Entry logic: M1 EMA crossover, M2 Bollinger reversion,
   M3 streak exhaustion, M4 RSI extreme, plus two combo modes
   (M2_M4 lookback confirmation, M1_GATE_M3 ADX regime gate) —
   ported exactly from the backtested standalone version.
   ========================================================= */

import { isAuthenticated, getToken } from '/src/core/auth/tokenManager.js';
import {
  connect as wsConnect,
  send as wsSend,
  sendRequest as wsSendRequest,
} from '/src/core/connection/wsClient.js';
import { on as busOn } from '/src/core/state/eventBus.js';
import { getAccountType } from '/src/core/state/accountPreference.js';

const CONFIG = {
  PING_INTERVAL_MS: 30000,
  MAX_PRICE_HISTORY: 300,
  EMA_FAST: 5,
  EMA_SLOW: 15,
  BOLL_PERIOD: 20,
  BOLL_MULT: 2,
  RSI_PERIOD: 14,
  ADX_PERIOD: 14,
  ADX_RANGE_THRESHOLD: 20, // ADX below this = ranging (per Wilder's convention)
  M2_LOOKBACK_TICKS: 3,    // M2 can lead M4 by up to this many ticks in the combo mode
  STREAK_LEN: 5,
  MAX_HISTORY_ITEMS: 100
};

const state = {
  connected: false,
  currency: 'USD',
  balance: null,

  symbol: 'R_100',
  pipSize: 2,

  prices: [],
  emaFast: null,
  emaSlow: null,
  prevEmaFast: null,
  prevEmaSlow: null,

  avgGain: null,
  avgLoss: null,
  rsi: null,

  smDmPlus: null,
  smDmMinus: null,
  smTr: null,
  dxSeed: [],
  adx: null,
  diPlus: null,
  diMinus: null,

  m2History: [],

  streakDir: null,
  streakCount: 0,

  running: false,
  tradeInFlight: false,
  awaiting: null,
  activeContractId: null,

  baseStake: 1,
  nextStake: 1,
  martingaleOn: false,
  martingaleMult: 2.1,
  maxLosses: 4,
  consecutiveLosses: 0,

  stopLoss: 10,
  takeProfit: 10,

  trades: 0,
  wins: 0,
  losses: 0,
  netPnl: 0,

  history: [],
  activeTradeMeta: null
};

let els = {};

document.addEventListener('DOMContentLoaded', () => {
  cacheEls();
  bindEvents();
  els.strategyHint.textContent = strategyHintText(els.strategyMode.value);
  log('Ready. Connecting to your Deriv account…', 'info');
  startConnection();
});

function cacheEls() {
  window.els = els = {
    connDot: document.getElementById('connDot'),
    connLabel: document.getElementById('connLabel'),
    balanceBox: document.getElementById('balanceBox'),

    symbolSelect: document.getElementById('symbolSelect'),
    strategyMode: document.getElementById('strategyMode'),
    strategyHint: document.getElementById('strategyHint'),
    stakeInput: document.getElementById('stakeInput'),
    durationInput: document.getElementById('durationInput'),
    martingaleToggle: document.getElementById('martingaleToggle'),
    martingaleRow: document.getElementById('martingaleRow'),
    martingaleMult: document.getElementById('martingaleMult'),
    maxLosses: document.getElementById('maxLosses'),
    stopLossInput: document.getElementById('stopLossInput'),
    takeProfitInput: document.getElementById('takeProfitInput'),

    btnStart: document.getElementById('btnStart'),
    btnStop: document.getElementById('btnStop'),
    botDot: document.getElementById('botDot'),
    botStateLabel: document.getElementById('botStateLabel'),

    indTick: document.getElementById('indTick'),
    indEma: document.getElementById('indEma'),
    indBoll: document.getElementById('indBoll'),
    indRsi: document.getElementById('indRsi'),
    indAdx: document.getElementById('indAdx'),
    indStreak: document.getElementById('indStreak'),
    indRegime: document.getElementById('indRegime'),

    statTrades: document.getElementById('statTrades'),
    statWins: document.getElementById('statWins'),
    statLosses: document.getElementById('statLosses'),
    statWinRate: document.getElementById('statWinRate'),
    statPnl: document.getElementById('statPnl'),
    statNextStake: document.getElementById('statNextStake'),

    logBox: document.getElementById('logBox'),

    historyList: document.getElementById('historyList'),
    btnClearHistory: document.getElementById('btnClearHistory')
  };
}

function bindEvents() {
  els.btnStart.addEventListener('click', startBot);
  els.btnStop.addEventListener('click', stopBot);
  els.btnClearHistory.addEventListener('click', clearHistory);

  els.martingaleToggle.addEventListener('change', () => {
    state.martingaleOn = els.martingaleToggle.checked;
    els.martingaleRow.hidden = !state.martingaleOn;
  });

  els.strategyMode.addEventListener('change', () => {
    els.strategyHint.textContent = strategyHintText(els.strategyMode.value);
  });

  els.symbolSelect.addEventListener('change', () => {
    if (state.running) {
      log('Stop the bot before switching markets.', 'warn');
      els.symbolSelect.value = state.symbol;
      return;
    }
    if (state.connected) switchSymbol(els.symbolSelect.value);
  });
}

function strategyHintText(mode) {
  switch (mode) {
    case 'M2_M4': return `Trades when RSI confirms an overbought/oversold extreme now, and Bollinger flagged the same extreme within the last ${CONFIG.M2_LOOKBACK_TICKS} ticks — catches the setup earlier instead of waiting for both to align on the exact same tick.`;
    case 'M1_GATE_M3': return `Streak-exhaustion (M3) trades only fire when ADX(${CONFIG.ADX_PERIOD}) is below ${CONFIG.ADX_RANGE_THRESHOLD} (ranging). Above that, the market is trending and M3 signals are suppressed to avoid fading a real trend.`;
    case 'M1': return 'Trades every EMA fast/slow crossover. Trend-following — rides breakouts, will get chopped up in ranging markets.';
    case 'M2': return 'Trades every time price closes outside the Bollinger Band, betting on reversion to the mean.';
    case 'M3': return 'Trades after ' + CONFIG.STREAK_LEN + ' consecutive same-direction ticks, betting the streak reverses.';
    case 'M4': return 'Trades whenever RSI(14) crosses into overbought (>70) or oversold (<30) territory.';
    default: return '';
  }
}

// =======================================================
// LOGGING — shows only the most recent activity (platform
// convention), not an accumulating history like the original
// standalone version.
// =======================================================
function log(msg, kind = 'info') {
  const classMap = { ok: 'win', err: 'loss', info: 'info', warn: 'warn', trade: 'trade' };
  const cls = classMap[kind] || 'info';
  els.logBox.innerHTML = '';
  const line = document.createElement('div');
  line.className = 'log-line';
  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = new Date().toLocaleTimeString();
  const message = document.createElement('span');
  message.className = cls;
  message.textContent = msg;
  line.appendChild(time);
  line.appendChild(message);
  els.logBox.appendChild(line);
}

// =======================================================
// CONNECTION — via platform OAuth session + shared wsClient
// (replaces the standalone bot's API-token form and OTP fetch
// entirely).
// =======================================================
async function startConnection() {
  if (!isAuthenticated()) {
    window.location.href = '/';
    return;
  }

  setConnUi('pending', 'Connecting…');

  try {
    const token = getToken();
    await wsConnect(token, getAccountType());
    state.connected = true;
    setConnUi('on', 'Connected');
    if (getAccountType() === 'real') {
      els.connLabel.style.color = '#ff2d55';
    }
    log('Connected.', 'ok');

    wsSend({ balance: 1, subscribe: 1 });
    state.symbol = els.symbolSelect.value;
    await preloadTickHistory(state.symbol);
    subscribeTicks(state.symbol);
    els.btnStart.disabled = false;
  } catch (err) {
    log('Connection failed: ' + err.message, 'err');
    setConnUi('off', 'Disconnected');
  }
}

busOn('connection:close', () => {
  state.connected = false;
  setConnUi('off', 'Disconnected');
  els.btnStart.disabled = true;
  els.btnStop.disabled = true;
  if (state.running) stopBot();
  log('Connection closed.', 'warn');
});

busOn('connection:error', (err) => {
  log('WebSocket error: ' + (err.message || err), 'err');
});

busOn('balance', (balance) => {
  if (!balance) return;
  state.balance = balance.balance;
  state.currency = balance.currency;
  els.balanceBox.textContent = `${fmtMoney(state.balance)} ${state.currency}`;
});

busOn('tick', (tick) => {
  if (tick.symbol !== state.symbol) return;
  handleTick(tick);
});

busOn('proposal', (proposal) => {
  if (state.awaiting !== 'proposal' || !proposal) return;
  state.awaiting = 'buy';
  wsSend({ buy: proposal.id, price: proposal.ask_price });
});

busOn('buy', (buy) => {
  if (state.awaiting !== 'buy' || !buy) return;
  state.awaiting = null;
  state.activeContractId = buy.contract_id;
  if (state.activeTradeMeta) state.activeTradeMeta.contractId = buy.contract_id;
  log(`Contract bought — id ${buy.contract_id}, price ${fmtMoney(buy.buy_price)}`, 'trade');
  wsSend({ proposal_open_contract: 1, contract_id: buy.contract_id, subscribe: 1 });
});

busOn('contractUpdate', (poc) => {
  if (!poc || poc.contract_id !== state.activeContractId) return;
  if (!poc.is_sold) return;
  const profit = parseFloat(poc.profit);
  settleTrade(profit);
  state.activeContractId = null;
  state.tradeInFlight = false;
});

function setConnUi(mode, label) {
  els.connDot.className = 'dot' + (mode === 'on' ? ' on' : mode === 'pending' ? ' pending' : '');
  els.connLabel.textContent = label;
  els.connLabel.style.color = '';
}

function switchSymbol(symbol) {
  wsSend({ forget_all: 'ticks' });
  resetIndicators();
  state.symbol = symbol;
  preloadTickHistory(symbol).then(() => {
    subscribeTicks(symbol);
    log('Switched market to ' + symbol, 'info');
  });
}

function subscribeTicks(symbol) {
  wsSend({ ticks: symbol, subscribe: 1 });
}

// =======================================================
// PRELOAD TICK HISTORY — fetches Deriv's own recent tick
// history and feeds each price through the SAME incremental
// update functions used for live ticks, so EMA/RSI/ADX/
// Bollinger/streak are warmed up and usable immediately
// instead of starting cold.
// =======================================================
async function preloadTickHistory(symbol) {
  try {
    const response = await wsSendRequest({
      ticks_history: symbol,
      end: 'latest',
      count: 150,
      style: 'ticks'
    });

    const prices = response.history.prices.map(Number);
    if (typeof response.pip_size === 'number') {
      state.pipSize = response.pip_size;
    }

    prices.forEach((price) => {
      updateStreak(price);
      updateEma(price);
      updateRsi(price);
      updateAdx(price);
      state.prices.push(price);
      if (state.prices.length > CONFIG.MAX_PRICE_HISTORY) state.prices.shift();
      const m2Now = getM2Signal();
      state.m2History.push(m2Now);
      if (state.m2History.length > CONFIG.M2_LOOKBACK_TICKS) state.m2History.shift();
    });

    if (prices.length > 0) renderIndicators(prices[prices.length - 1]);
    log(`Loaded ${prices.length} recent ticks from Deriv for ${symbol}.`, 'info');
  } catch (err) {
    console.error('Tick history preload failed:', err);
    log('Could not preload tick history — building live instead.', 'warn');
  }
}

// =======================================================
// TICK HANDLING + INDICATORS (UNCHANGED from backtested version)
// =======================================================
function handleTick(tick) {
  if (!tick) return;
  if (typeof tick.pip_size === 'number') state.pipSize = tick.pip_size;
  const price = parseFloat(tick.quote);
  if (Number.isNaN(price)) return;

  updateStreak(price);
  updateEma(price);
  updateRsi(price);
  updateAdx(price);

  state.prices.push(price);
  if (state.prices.length > CONFIG.MAX_PRICE_HISTORY) state.prices.shift();

  const m2Now = getM2Signal();
  state.m2History.push(m2Now);
  if (state.m2History.length > CONFIG.M2_LOOKBACK_TICKS) state.m2History.shift();

  renderIndicators(price);

  if (state.running && !state.tradeInFlight) {
    const signal = evaluateStrategy();
    if (signal) executeTrade(signal);
  }
}

function updateEma(price) {
  const kFast = 2 / (CONFIG.EMA_FAST + 1);
  const kSlow = 2 / (CONFIG.EMA_SLOW + 1);

  state.prevEmaFast = state.emaFast;
  state.prevEmaSlow = state.emaSlow;

  state.emaFast = state.emaFast === null ? price : (price - state.emaFast) * kFast + state.emaFast;
  state.emaSlow = state.emaSlow === null ? price : (price - state.emaSlow) * kSlow + state.emaSlow;
}

function updateRsi(price) {
  const prev = state.prices[state.prices.length - 1];
  if (prev === undefined) return;

  const change = price - prev;
  const gain = change > 0 ? change : 0;
  const loss = change < 0 ? -change : 0;
  const p = CONFIG.RSI_PERIOD;

  if (state.avgGain === null || state.avgLoss === null) {
    state.avgGain = gain;
    state.avgLoss = loss;
  } else {
    state.avgGain = (state.avgGain * (p - 1) + gain) / p;
    state.avgLoss = (state.avgLoss * (p - 1) + loss) / p;
  }

  if (state.avgLoss === 0) {
    state.rsi = 100;
  } else {
    const rs = state.avgGain / state.avgLoss;
    state.rsi = 100 - (100 / (1 + rs));
  }
}

function updateStreak(price) {
  const prev = state.prices[state.prices.length - 1];
  if (prev === undefined) return;
  if (price === prev) return;

  const dir = price > prev ? 'up' : 'down';
  if (dir === state.streakDir) {
    state.streakCount += 1;
  } else {
    state.streakDir = dir;
    state.streakCount = 1;
  }
}

function getBollinger() {
  const period = CONFIG.BOLL_PERIOD;
  if (state.prices.length < period) return null;
  const window = state.prices.slice(-period);
  const mean = window.reduce((a, b) => a + b, 0) / period;
  const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return {
    upper: mean + CONFIG.BOLL_MULT * sd,
    mid: mean,
    lower: mean - CONFIG.BOLL_MULT * sd
  };
}

function updateAdx(price) {
  const prev = state.prices[state.prices.length - 1];
  if (prev === undefined) return;

  const p = CONFIG.ADX_PERIOD;
  const upMove = price - prev;
  const downMove = prev - price;

  const dmPlus = (upMove > downMove && upMove > 0) ? upMove : 0;
  const dmMinus = (downMove > upMove && downMove > 0) ? downMove : 0;
  const tr = Math.abs(price - prev);

  if (state.smDmPlus === null) {
    state.smDmPlus = dmPlus;
    state.smDmMinus = dmMinus;
    state.smTr = tr;
  } else {
    state.smDmPlus = state.smDmPlus - (state.smDmPlus / p) + dmPlus;
    state.smDmMinus = state.smDmMinus - (state.smDmMinus / p) + dmMinus;
    state.smTr = state.smTr - (state.smTr / p) + tr;
  }

  state.diPlus = state.smTr === 0 ? 0 : 100 * (state.smDmPlus / state.smTr);
  state.diMinus = state.smTr === 0 ? 0 : 100 * (state.smDmMinus / state.smTr);

  const diSum = state.diPlus + state.diMinus;
  const dx = diSum === 0 ? 0 : 100 * Math.abs(state.diPlus - state.diMinus) / diSum;

  if (state.adx === null) {
    state.dxSeed.push(dx);
    if (state.dxSeed.length >= p) {
      state.adx = state.dxSeed.reduce((a, b) => a + b, 0) / state.dxSeed.length;
    }
  } else {
    state.adx = (state.adx * (p - 1) + dx) / p;
  }
}

function getRegime() {
  if (state.adx === null || !state.prices.length) return 'WARMING UP';
  if (state.adx < CONFIG.ADX_RANGE_THRESHOLD) return 'RANGING';
  return state.diPlus >= state.diMinus ? 'UPTREND' : 'DOWNTREND';
}

function renderIndicators(price) {
  const d = state.pipSize;
  els.indTick.textContent = price.toFixed(d);
  els.indEma.textContent = (state.emaFast !== null ? state.emaFast.toFixed(d) : '—')
    + ' / ' + (state.emaSlow !== null ? state.emaSlow.toFixed(d) : '—');

  const boll = getBollinger();
  els.indBoll.textContent = boll
    ? `${boll.upper.toFixed(d)} / ${boll.mid.toFixed(d)} / ${boll.lower.toFixed(d)}`
    : 'warming up...';

  els.indRsi.textContent = state.rsi !== null ? state.rsi.toFixed(1) : '—';
  els.indAdx.textContent = state.adx !== null ? state.adx.toFixed(1) : '—';
  els.indStreak.textContent = state.streakCount
    ? `${state.streakCount} ${state.streakDir}`
    : '—';
  els.indRegime.textContent = getRegime() + (state.adx !== null ? ` (${state.adx.toFixed(1)})` : '');
}

function resetIndicators() {
  state.prices = [];
  state.emaFast = state.emaSlow = state.prevEmaFast = state.prevEmaSlow = null;
  state.avgGain = state.avgLoss = state.rsi = null;
  state.smDmPlus = state.smDmMinus = state.smTr = state.adx = null;
  state.diPlus = state.diMinus = null;
  state.dxSeed = [];
  state.m2History = [];
  state.streakDir = null;
  state.streakCount = 0;
}

// =======================================================
// STRATEGY SIGNALS (M1-M4 + combos) — UNCHANGED, ported
// exactly from the backtested standalone version.
// =======================================================
function getM1Signal() {
  if (state.prevEmaFast === null || state.prevEmaSlow === null) return null;
  const crossedUp = state.prevEmaFast <= state.prevEmaSlow && state.emaFast > state.emaSlow;
  const crossedDown = state.prevEmaFast >= state.prevEmaSlow && state.emaFast < state.emaSlow;
  if (crossedUp) return 'CALL';
  if (crossedDown) return 'PUT';
  return null;
}

function getM2Signal() {
  const boll = getBollinger();
  if (!boll || !state.prices.length) return null;
  const price = state.prices[state.prices.length - 1];
  if (price >= boll.upper) return 'PUT';
  if (price <= boll.lower) return 'CALL';
  return null;
}

function getM3Signal() {
  if (state.streakCount >= CONFIG.STREAK_LEN) {
    if (state.streakDir === 'up') return 'PUT';
    if (state.streakDir === 'down') return 'CALL';
  }
  return null;
}

function getM4Signal() {
  if (state.rsi === null) return null;
  if (state.rsi >= 70) return 'PUT';
  if (state.rsi <= 30) return 'CALL';
  return null;
}

function evaluateStrategy() {
  const mode = els.strategyMode.value;
  switch (mode) {
    case 'M1': return getM1Signal();
    case 'M2': return getM2Signal();
    case 'M3': return getM3Signal();
    case 'M4': return getM4Signal();
    case 'M2_M4': {
      const m4 = getM4Signal();
      if (!m4) return null;
      return state.m2History.includes(m4) ? m4 : null;
    }
    case 'M1_GATE_M3': {
      return getRegime() === 'RANGING' ? getM3Signal() : null;
    }
    default: return null;
  }
}

// =======================================================
// TRADE EXECUTION (UNCHANGED)
// =======================================================
function executeTrade(direction) {
  state.tradeInFlight = true;
  state.awaiting = 'proposal';

  const stake = state.nextStake;
  const duration = parseInt(els.durationInput.value, 10) || 5;

  state.activeTradeMeta = { direction, stake, time: new Date(), contractId: null };

  log(`Signal ${direction === 'CALL' ? 'RISE' : 'FALL'} — requesting proposal @ stake ${fmtMoney(stake)}`, 'trade');

  wsSend({
    proposal: 1,
    amount: stake,
    basis: 'stake',
    contract_type: direction,
    currency: state.currency || 'USD',
    duration: duration,
    duration_unit: 't',
    underlying_symbol: state.symbol
  });
}

function settleTrade(profit) {
  state.trades += 1;
  state.netPnl += profit;

  const meta = state.activeTradeMeta || {};
  const isWin = profit >= 0;

  if (isWin) {
    state.wins += 1;
    state.consecutiveLosses = 0;
    state.nextStake = state.baseStake;
    log(`WIN  +${fmtMoney(profit)} — net P/L ${fmtMoney(state.netPnl)}`, 'ok');
  } else {
    state.losses += 1;
    state.consecutiveLosses += 1;
    state.nextStake = state.martingaleOn
      ? +(state.nextStake * state.martingaleMult).toFixed(2)
      : state.baseStake;
    log(`LOSS ${fmtMoney(profit)} — net P/L ${fmtMoney(state.netPnl)}`, 'err');
  }

  state.history.unshift({
    direction: meta.direction || null,
    stake: meta.stake,
    time: meta.time || new Date(),
    contractId: meta.contractId,
    win: isWin,
    profit: profit
  });
  if (state.history.length > CONFIG.MAX_HISTORY_ITEMS) state.history.length = CONFIG.MAX_HISTORY_ITEMS;
  state.activeTradeMeta = null;

  renderStats();
  renderHistory();
  checkSessionLimits();
}

function renderHistory() {
  els.historyList.innerHTML = '';

  if (!state.history.length) {
    const empty = document.createElement('p');
    empty.className = 'history-empty';
    empty.textContent = 'No trades yet this session.';
    els.historyList.appendChild(empty);
    return;
  }

  state.history.forEach((t) => {
    const item = document.createElement('div');
    item.className = 'history-item ' + (t.win ? 'win' : 'loss');

    const left = document.createElement('div');
    left.className = 'history-left';

    const dirEl = document.createElement('span');
    dirEl.className = 'history-direction ' + (t.direction === 'CALL' ? 'rise' : 'fall');
    dirEl.textContent = t.direction === 'CALL' ? 'RISE' : 'FALL';

    const metaEl = document.createElement('span');
    metaEl.className = 'history-meta';
    metaEl.textContent = `${fmtTime(t.time)} · ${fmtMoney(t.stake)} stake`;

    left.appendChild(dirEl);
    left.appendChild(metaEl);

    const right = document.createElement('div');
    right.className = 'history-right';

    const badge = document.createElement('span');
    badge.className = 'history-badge ' + (t.win ? 'win' : 'loss');
    badge.textContent = (t.win ? '✓ WIN ' : '✕ LOSS ') + (t.profit >= 0 ? '+' : '') + fmtMoney(t.profit);

    const idEl = document.createElement('span');
    idEl.className = 'history-id';
    idEl.textContent = t.contractId ? '#' + t.contractId : '';

    right.appendChild(badge);
    right.appendChild(idEl);

    item.appendChild(left);
    item.appendChild(right);
    els.historyList.appendChild(item);
  });
}

function clearHistory() {
  state.trades = 0;
  state.wins = 0;
  state.losses = 0;
  state.netPnl = 0;
  state.consecutiveLosses = 0;
  state.nextStake = state.baseStake;
  state.history = [];

  renderStats();
  renderHistory();
  log('Session stats and trade history cleared.', 'warn');
}

function fmtTime(d) {
  const date = d instanceof Date ? d : new Date(d);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function checkSessionLimits() {
  if (state.consecutiveLosses >= state.maxLosses) {
    log(`Paused: ${state.consecutiveLosses} consecutive losses reached.`, 'warn');
    stopBot();
    return;
  }
  if (state.stopLoss > 0 && state.netPnl <= -Math.abs(state.stopLoss)) {
    log(`Stopped: session stop-loss of ${fmtMoney(state.stopLoss)} reached.`, 'warn');
    stopBot();
    return;
  }
  if (state.takeProfit > 0 && state.netPnl >= Math.abs(state.takeProfit)) {
    log(`Stopped: session take-profit of ${fmtMoney(state.takeProfit)} reached.`, 'ok');
    stopBot();
  }
}

// =======================================================
// BOT START / STOP (UNCHANGED)
// =======================================================
function startBot() {
  if (!state.connected) {
    log('Connect your account before starting the bot.', 'err');
    return;
  }

  state.baseStake = parseFloat(els.stakeInput.value) || 1;
  state.nextStake = state.baseStake;
  state.martingaleOn = els.martingaleToggle.checked;
  state.martingaleMult = parseFloat(els.martingaleMult.value) || 2.1;
  state.maxLosses = parseInt(els.maxLosses.value, 10) || 4;
  state.stopLoss = parseFloat(els.stopLossInput.value) || 0;
  state.takeProfit = parseFloat(els.takeProfitInput.value) || 0;
  state.consecutiveLosses = 0;

  state.running = true;
  els.btnStart.disabled = true;
  els.btnStop.disabled = false;
  els.symbolSelect.disabled = true;
  els.botDot.classList.add('on');
  els.botStateLabel.textContent = 'RUNNING — ' + strategyLabel(els.strategyMode.value);

  renderStats();
  log('Bot started on ' + state.symbol + ' using ' + strategyLabel(els.strategyMode.value), 'ok');
}

function stopBot() {
  state.running = false;
  els.btnStart.disabled = !state.connected;
  els.btnStop.disabled = true;
  els.symbolSelect.disabled = false;
  els.botDot.classList.remove('on');
  els.botStateLabel.textContent = 'IDLE';
  log('Bot stopped.', 'warn');
}

function strategyLabel(mode) {
  const opt = Array.from(els.strategyMode.options).find((o) => o.value === mode);
  return opt ? opt.textContent.split(' — ')[0] : mode;
}

// =======================================================
// STATS / FORMATTING
// =======================================================
function renderStats() {
  els.statTrades.textContent = state.trades;
  els.statWins.textContent = state.wins;
  els.statLosses.textContent = state.losses;
  els.statWinRate.textContent = state.trades
    ? Math.round((state.wins / state.trades) * 100) + '%'
    : '0%';
  els.statPnl.textContent = fmtMoney(state.netPnl);
  els.statNextStake.textContent = fmtMoney(state.nextStake);
}

function fmtMoney(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return Number(v).toFixed(2);
}
