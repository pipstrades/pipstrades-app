/* =========================================================
   PIPSTRADES — RISE/FALL AUTOBOT
   Connection: platform OAuth + shared wsClient.
   Entry logic: M1 EMA crossover, M2 Bollinger reversion,
   M3 streak exhaustion, M4 RSI extreme, plus two combo modes
   (M2_M4 lookback confirmation, M1_GATE_M3 ADX regime gate).
   NEW: Auto mode — scans every market simultaneously, each
   with its own independent indicator state, and trades
   whichever market first satisfies the selected strategy.
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
  MAX_PRICE_HISTORY: 300,
  EMA_FAST: 5,
  EMA_SLOW: 15,
  BOLL_PERIOD: 20,
  BOLL_MULT: 2,
  RSI_PERIOD: 14,
  ADX_PERIOD: 14,
  ADX_RANGE_THRESHOLD: 20,
  M2_LOOKBACK_TICKS: 3,
  STREAK_LEN: 5,
  MAX_HISTORY_ITEMS: 100
};

const ALL_MARKETS = [
  'R_10', '1HZ10V', 'R_25', '1HZ25V', 'R_50', '1HZ50V',
  'R_75', '1HZ75V', 'R_100', '1HZ100V', '1HZ15V', '1HZ30V', '1HZ90V'
];

// Session-wide state (not per-market)
const state = {
  connected: false,
  currency: 'USD',
  balance: null,

  autoMode: false,
  activeSymbols: [],      // symbols currently subscribed
  marketStates: new Map(),// symbol -> per-market indicator state
  displayMarket: null,    // whichever market's indicators are shown right now

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
    autoHint: document.getElementById('autoHint'),
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

    indMarket: document.getElementById('indMarket'),
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
      log('Stop the bot before changing the market selection.', 'warn');
      els.symbolSelect.value = state.autoMode ? 'AUTO' : state.activeSymbols[0];
      return;
    }
    if (state.connected) applyMarketSelection();
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
// LOGGING — shows only the most recent activity.
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
// CONNECTION — platform OAuth + shared wsClient
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
    await applyMarketSelection();
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
  if (!tick || !state.activeSymbols.includes(tick.symbol)) return;
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

// =======================================================
// MARKET SELECTION — single market or Auto (all markets)
// =======================================================
async function applyMarketSelection() {
  wsSend({ forget_all: 'ticks' });

  const selection = els.symbolSelect.value;
  state.autoMode = selection === 'AUTO';
  state.activeSymbols = state.autoMode ? [...ALL_MARKETS] : [selection];
  state.marketStates = new Map();
  state.displayMarket = state.activeSymbols[0];
  els.autoHint.hidden = !state.autoMode;

  log(
    state.autoMode
      ? `Auto mode — loading history for all ${state.activeSymbols.length} markets…`
      : `Loading history for ${selection}…`,
    'info'
  );

  await Promise.all(state.activeSymbols.map((symbol) => preloadTickHistory(symbol)));

  state.activeSymbols.forEach((symbol) => {
    wsSend({ ticks: symbol, subscribe: 1 });
  });

  const initialMs = state.marketStates.get(state.displayMarket);
  if (initialMs && initialMs.prices.length) {
    renderIndicators(initialMs, state.displayMarket, initialMs.prices[initialMs.prices.length - 1]);
  }

  log(
    state.autoMode
      ? `Auto mode ready — scanning ${state.activeSymbols.length} markets.`
      : `Ready on ${selection}.`,
    'ok'
  );
}

function createMarketState() {
  return {
    prices: [],
    emaFast: null, emaSlow: null, prevEmaFast: null, prevEmaSlow: null,
    avgGain: null, avgLoss: null, rsi: null,
    smDmPlus: null, smDmMinus: null, smTr: null, dxSeed: [], adx: null,
    diPlus: null, diMinus: null,
    m2History: [],
    streakDir: null, streakCount: 0,
    pipSize: 2
  };
}

// =======================================================
// PRELOAD TICK HISTORY — fetches Deriv's own recent tick
// history per market and feeds each price through the SAME
// incremental update functions used for live ticks.
// =======================================================
async function preloadTickHistory(symbol) {
  const ms = createMarketState();
  state.marketStates.set(symbol, ms);

  try {
    const response = await wsSendRequest({
      ticks_history: symbol,
      end: 'latest',
      count: 150,
      style: 'ticks'
    });

    const prices = response.history.prices.map(Number);
    if (typeof response.pip_size === 'number') {
      ms.pipSize = response.pip_size;
    }

    prices.forEach((price) => {
      updateStreak(ms, price);
      updateEma(ms, price);
      updateRsi(ms, price);
      updateAdx(ms, price);
      ms.prices.push(price);
      if (ms.prices.length > CONFIG.MAX_PRICE_HISTORY) ms.prices.shift();
      const m2Now = getM2Signal(ms);
      ms.m2History.push(m2Now);
      if (ms.m2History.length > CONFIG.M2_LOOKBACK_TICKS) ms.m2History.shift();
    });
  } catch (err) {
    console.error(`Tick history preload failed for ${symbol}:`, err);
  }
}

// =======================================================
// TICK HANDLING + INDICATORS (per-market, math unchanged)
// =======================================================
function handleTick(tick) {
  const ms = state.marketStates.get(tick.symbol);
  if (!ms) return;
  if (typeof tick.pip_size === 'number') ms.pipSize = tick.pip_size;
  const price = parseFloat(tick.quote);
  if (Number.isNaN(price)) return;

  updateStreak(ms, price);
  updateEma(ms, price);
  updateRsi(ms, price);
  updateAdx(ms, price);

  ms.prices.push(price);
  if (ms.prices.length > CONFIG.MAX_PRICE_HISTORY) ms.prices.shift();

  const m2Now = getM2Signal(ms);
  ms.m2History.push(m2Now);
  if (ms.m2History.length > CONFIG.M2_LOOKBACK_TICKS) ms.m2History.shift();

  state.displayMarket = tick.symbol;
  renderIndicators(ms, tick.symbol, price);

  if (state.running && !state.tradeInFlight) {
    const signal = evaluateStrategy(ms);
    if (signal) executeTrade(signal, tick.symbol);
  }
}

function updateEma(ms, price) {
  const kFast = 2 / (CONFIG.EMA_FAST + 1);
  const kSlow = 2 / (CONFIG.EMA_SLOW + 1);

  ms.prevEmaFast = ms.emaFast;
  ms.prevEmaSlow = ms.emaSlow;

  ms.emaFast = ms.emaFast === null ? price : (price - ms.emaFast) * kFast + ms.emaFast;
  ms.emaSlow = ms.emaSlow === null ? price : (price - ms.emaSlow) * kSlow + ms.emaSlow;
}

function updateRsi(ms, price) {
  const prev = ms.prices[ms.prices.length - 1];
  if (prev === undefined) return;

  const change = price - prev;
  const gain = change > 0 ? change : 0;
  const loss = change < 0 ? -change : 0;
  const p = CONFIG.RSI_PERIOD;

  if (ms.avgGain === null || ms.avgLoss === null) {
    ms.avgGain = gain;
    ms.avgLoss = loss;
  } else {
    ms.avgGain = (ms.avgGain * (p - 1) + gain) / p;
    ms.avgLoss = (ms.avgLoss * (p - 1) + loss) / p;
  }

  if (ms.avgLoss === 0) {
    ms.rsi = 100;
  } else {
    const rs = ms.avgGain / ms.avgLoss;
    ms.rsi = 100 - (100 / (1 + rs));
  }
}

function updateStreak(ms, price) {
  const prev = ms.prices[ms.prices.length - 1];
  if (prev === undefined) return;
  if (price === prev) return;

  const dir = price > prev ? 'up' : 'down';
  if (dir === ms.streakDir) {
    ms.streakCount += 1;
  } else {
    ms.streakDir = dir;
    ms.streakCount = 1;
  }
}

function getBollinger(ms) {
  const period = CONFIG.BOLL_PERIOD;
  if (ms.prices.length < period) return null;
  const window = ms.prices.slice(-period);
  const mean = window.reduce((a, b) => a + b, 0) / period;
  const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return {
    upper: mean + CONFIG.BOLL_MULT * sd,
    mid: mean,
    lower: mean - CONFIG.BOLL_MULT * sd
  };
}

function updateAdx(ms, price) {
  const prev = ms.prices[ms.prices.length - 1];
  if (prev === undefined) return;

  const p = CONFIG.ADX_PERIOD;
  const upMove = price - prev;
  const downMove = prev - price;

  const dmPlus = (upMove > downMove && upMove > 0) ? upMove : 0;
  const dmMinus = (downMove > upMove && downMove > 0) ? downMove : 0;
  const tr = Math.abs(price - prev);

  if (ms.smDmPlus === null) {
    ms.smDmPlus = dmPlus;
    ms.smDmMinus = dmMinus;
    ms.smTr = tr;
  } else {
    ms.smDmPlus = ms.smDmPlus - (ms.smDmPlus / p) + dmPlus;
    ms.smDmMinus = ms.smDmMinus - (ms.smDmMinus / p) + dmMinus;
    ms.smTr = ms.smTr - (ms.smTr / p) + tr;
  }

  ms.diPlus = ms.smTr === 0 ? 0 : 100 * (ms.smDmPlus / ms.smTr);
  ms.diMinus = ms.smTr === 0 ? 0 : 100 * (ms.smDmMinus / ms.smTr);

  const diSum = ms.diPlus + ms.diMinus;
  const dx = diSum === 0 ? 0 : 100 * Math.abs(ms.diPlus - ms.diMinus) / diSum;

  if (ms.adx === null) {
    ms.dxSeed.push(dx);
    if (ms.dxSeed.length >= p) {
      ms.adx = ms.dxSeed.reduce((a, b) => a + b, 0) / ms.dxSeed.length;
    }
  } else {
    ms.adx = (ms.adx * (p - 1) + dx) / p;
  }
}

function getRegime(ms) {
  if (ms.adx === null || !ms.prices.length) return 'WARMING UP';
  if (ms.adx < CONFIG.ADX_RANGE_THRESHOLD) return 'RANGING';
  return ms.diPlus >= ms.diMinus ? 'UPTREND' : 'DOWNTREND';
}

function renderIndicators(ms, symbol, price) {
  const d = ms.pipSize;
  els.indMarket.textContent = symbol;
  els.indTick.textContent = price.toFixed(d);
  els.indEma.textContent = (ms.emaFast !== null ? ms.emaFast.toFixed(d) : '—')
    + ' / ' + (ms.emaSlow !== null ? ms.emaSlow.toFixed(d) : '—');

  const boll = getBollinger(ms);
  els.indBoll.textContent = boll
    ? `${boll.upper.toFixed(d)} / ${boll.mid.toFixed(d)} / ${boll.lower.toFixed(d)}`
    : 'warming up...';

  els.indRsi.textContent = ms.rsi !== null ? ms.rsi.toFixed(1) : '—';
  els.indAdx.textContent = ms.adx !== null ? ms.adx.toFixed(1) : '—';
  els.indStreak.textContent = ms.streakCount ? `${ms.streakCount} ${ms.streakDir}` : '—';
  els.indRegime.textContent = getRegime(ms) + (ms.adx !== null ? ` (${ms.adx.toFixed(1)})` : '');
}

// =======================================================
// STRATEGY SIGNALS (M1-M4 + combos) — math unchanged,
// now parameterized per-market instead of one global state.
// =======================================================
function getM1Signal(ms) {
  if (ms.prevEmaFast === null || ms.prevEmaSlow === null) return null;
  const crossedUp = ms.prevEmaFast <= ms.prevEmaSlow && ms.emaFast > ms.emaSlow;
  const crossedDown = ms.prevEmaFast >= ms.prevEmaSlow && ms.emaFast < ms.emaSlow;
  if (crossedUp) return 'CALL';
  if (crossedDown) return 'PUT';
  return null;
}

function getM2Signal(ms) {
  const boll = getBollinger(ms);
  if (!boll || !ms.prices.length) return null;
  const price = ms.prices[ms.prices.length - 1];
  if (price >= boll.upper) return 'PUT';
  if (price <= boll.lower) return 'CALL';
  return null;
}

function getM3Signal(ms) {
  if (ms.streakCount >= CONFIG.STREAK_LEN) {
    if (ms.streakDir === 'up') return 'PUT';
    if (ms.streakDir === 'down') return 'CALL';
  }
  return null;
}

function getM4Signal(ms) {
  if (ms.rsi === null) return null;
  if (ms.rsi >= 70) return 'PUT';
  if (ms.rsi <= 30) return 'CALL';
  return null;
}

function evaluateStrategy(ms) {
  const mode = els.strategyMode.value;
  switch (mode) {
    case 'M1': return getM1Signal(ms);
    case 'M2': return getM2Signal(ms);
    case 'M3': return getM3Signal(ms);
    case 'M4': return getM4Signal(ms);
    case 'M2_M4': {
      const m4 = getM4Signal(ms);
      if (!m4) return null;
      return ms.m2History.includes(m4) ? m4 : null;
    }
    case 'M1_GATE_M3': {
      return getRegime(ms) === 'RANGING' ? getM3Signal(ms) : null;
    }
    default: return null;
  }
}

// =======================================================
// TRADE EXECUTION
// =======================================================
function executeTrade(direction, symbol) {
  state.tradeInFlight = true;
  state.awaiting = 'proposal';

  const stake = state.nextStake;
  const duration = parseInt(els.durationInput.value, 10) || 5;

  state.activeTradeMeta = { direction, stake, market: symbol, time: new Date(), contractId: null };

  log(`Signal ${direction === 'CALL' ? 'RISE' : 'FALL'} on ${symbol} — requesting proposal @ stake ${fmtMoney(stake)}`, 'trade');

  wsSend({
    proposal: 1,
    amount: stake,
    basis: 'stake',
    contract_type: direction,
    currency: state.currency || 'USD',
    duration: duration,
    duration_unit: 't',
    underlying_symbol: symbol
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
    log(`WIN  +${fmtMoney(profit)} on ${meta.market || '?'} — net P/L ${fmtMoney(state.netPnl)}`, 'ok');
  } else {
    state.losses += 1;
    state.consecutiveLosses += 1;
    state.nextStake = state.martingaleOn
      ? +(state.nextStake * state.martingaleMult).toFixed(2)
      : state.baseStake;
    log(`LOSS ${fmtMoney(profit)} on ${meta.market || '?'} — net P/L ${fmtMoney(state.netPnl)}`, 'err');
  }

  state.history.unshift({
    direction: meta.direction || null,
    stake: meta.stake,
    market: meta.market || null,
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

    const marketEl = document.createElement('span');
    marketEl.className = 'history-market';
    marketEl.textContent = t.market || '';

    left.appendChild(dirEl);
    left.appendChild(marketEl);
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
// BOT START / STOP
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
  els.botStateLabel.textContent = 'RUNNING — ' + strategyLabel(els.strategyMode.value)
    + (state.autoMode ? ` (Auto · ${state.activeSymbols.length} markets)` : ` (${state.activeSymbols[0]})`);

  renderStats();
  log('Bot started using ' + strategyLabel(els.strategyMode.value)
    + (state.autoMode ? ` — scanning ${state.activeSymbols.length} markets` : ` on ${state.activeSymbols[0]}`), 'ok');
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
