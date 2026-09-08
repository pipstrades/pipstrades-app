/* =========================================================
   PIPSTRADES — TOUCH / NO TOUCH AUTOBOT
   Connection: platform OAuth + shared wsClient.
   Entry logic reuses only the two Rise/Fall tools that are
   actually relevant to a touch/no-touch decision:
     - ADX(14): regime (ranging vs trending) AND direction
       (DI+ vs DI-) — Rise/Fall's M1_GATE_M3 regime detector,
       reused verbatim.
     - Rolling volatility (same stddev calc as Bollinger
       bands) — used here to calibrate barrier DISTANCE
       instead of as a mean-reversion trigger.
   EMA crossover and streak-exhaustion (Rise/Fall's M1/M3)
   are not relevant to touch/no-touch and are not included.

   Strategy modes:
     T1 — No-Touch only: barrier placed FAR (large volatility
          multiple) in the ADX-led direction.
     T2 — One-Touch only: barrier placed CLOSE (small
          volatility multiple) in the ADX-led direction.
     T3 — Auto Regime Switch: ranging -> T1, trending -> T2.

   Same Auto multi-market scanning as Rise/Fall: each market
   gets its own independent ADX/volatility state.
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
  VOL_PERIOD: 20,       // rolling window for volatility (stddev), same as Rise/Fall's Bollinger period
  ADX_PERIOD: 14,
  ADX_RANGE_THRESHOLD: 20,
  MAX_HISTORY_ITEMS: 100
};

const ALL_MARKETS = [
  'R_10', '1HZ10V', 'R_25', '1HZ25V', 'R_50', '1HZ50V',
  'R_75', '1HZ75V', 'R_100', '1HZ100V', '1HZ15V', '1HZ30V', '1HZ90V'
];

const state = {
  connected: false,
  currency: 'USD',
  balance: null,

  autoMode: false,
  activeSymbols: [],
  marketStates: new Map(),
  displayMarket: null,

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
    notouchMult: document.getElementById('notouchMult'),
    onetouchMult: document.getElementById('onetouchMult'),
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
    indVol: document.getElementById('indVol'),
    indAdx: document.getElementById('indAdx'),
    indLean: document.getElementById('indLean'),
    indRegime: document.getElementById('indRegime'),
    indBarrier: document.getElementById('indBarrier'),

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
    case 'T3': return 'Ranging markets (ADX < 20) trade No-Touch with a barrier placed far away. Trending markets (ADX ≥ 20) trade One-Touch with a barrier placed close, in the trend direction.';
    case 'T1': return 'Always trades No-Touch. Barrier is placed a large multiple of recent volatility away, in the ADX-led direction — a harder, more meaningful test than picking the "easy" side.';
    case 'T2': return 'Always trades One-Touch. Barrier is placed a small multiple of recent volatility away, in the ADX-led direction — betting the current lean reaches a nearby target soon.';
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
    smDmPlus: null, smDmMinus: null, smTr: null, dxSeed: [], adx: null,
    diPlus: null, diMinus: null,
    pipSize: 2
  };
}

// =======================================================
// PRELOAD TICK HISTORY — same approach as Rise/Fall: feed
// Deriv's own recent history through the live update
// functions so ADX/volatility are warmed up immediately.
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
      updateAdx(ms, price);
      ms.prices.push(price);
      if (ms.prices.length > CONFIG.MAX_PRICE_HISTORY) ms.prices.shift();
    });
  } catch (err) {
    console.error(`Tick history preload failed for ${symbol}:`, err);
  }
}

// =======================================================
// TICK HANDLING + INDICATORS
// =======================================================
function handleTick(tick) {
  const ms = state.marketStates.get(tick.symbol);
  if (!ms) return;
  if (typeof tick.pip_size === 'number') ms.pipSize = tick.pip_size;
  const price = parseFloat(tick.quote);
  if (Number.isNaN(price)) return;

  updateAdx(ms, price);
  ms.prices.push(price);
  if (ms.prices.length > CONFIG.MAX_PRICE_HISTORY) ms.prices.shift();

  state.displayMarket = tick.symbol;
  renderIndicators(ms, tick.symbol, price);

  if (state.running && !state.tradeInFlight) {
    const signal = evaluateStrategy(ms);
    if (signal) executeTrade(signal, tick.symbol);
  }
}

// ADX update — reused verbatim from Rise/Fall (Wilder's DM/TR,
// treating each tick as its own bar since there's no OHLC).
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

function getLeanDirection(ms) {
  if (ms.diPlus === null || ms.diMinus === null) return null;
  return ms.diPlus >= ms.diMinus ? 'UP' : 'DOWN';
}

// Volatility — same rolling stddev calc as Rise/Fall's Bollinger
// bands, used here purely to size the barrier distance.
function getVolatility(ms) {
  const period = CONFIG.VOL_PERIOD;
  if (ms.prices.length < period) return null;
  const window = ms.prices.slice(-period);
  const mean = window.reduce((a, b) => a + b, 0) / period;
  const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  return Math.sqrt(variance);
}

function renderIndicators(ms, symbol, price) {
  const d = ms.pipSize;
  els.indMarket.textContent = symbol;
  els.indTick.textContent = price.toFixed(d);

  const vol = getVolatility(ms);
  els.indVol.textContent = vol !== null ? vol.toFixed(d + 1) : 'warming up...';

  els.indAdx.textContent = ms.adx !== null ? ms.adx.toFixed(1) : '—';

  const lean = getLeanDirection(ms);
  els.indLean.textContent = lean || '—';

  els.indRegime.textContent = getRegime(ms) + (ms.adx !== null ? ` (${ms.adx.toFixed(1)})` : '');

  const preview = evaluateStrategy(ms);
  if (preview) {
    els.indBarrier.textContent = `${preview.contractType} ${formatBarrier(preview.barrierOffset)}`;
  } else {
    els.indBarrier.textContent = 'not ready';
  }
}

// =======================================================
// STRATEGY SIGNALS — T1 (No-Touch), T2 (One-Touch), T3 (Auto)
// =======================================================
function buildSignal(ms, contractType, multiplier) {
  const vol = getVolatility(ms);
  const lean = getLeanDirection(ms);
  if (vol === null || lean === null || !ms.prices.length) return null;

  const distance = multiplier * vol;
  const barrierOffset = lean === 'UP' ? distance : -distance;
  return { contractType, barrierOffset };
}

function getT1Signal(ms) {
  const multiplier = parseFloat(els.notouchMult.value) || 3;
  return buildSignal(ms, 'NOTOUCH', multiplier);
}

function getT2Signal(ms) {
  const multiplier = parseFloat(els.onetouchMult.value) || 1.2;
  return buildSignal(ms, 'ONETOUCH', multiplier);
}

function getT3Signal(ms) {
  const regime = getRegime(ms);
  if (regime === 'RANGING') return getT1Signal(ms);
  if (regime === 'UPTREND' || regime === 'DOWNTREND') return getT2Signal(ms);
  return null;
}

function evaluateStrategy(ms) {
  const mode = els.strategyMode.value;
  switch (mode) {
    case 'T1': return getT1Signal(ms);
    case 'T2': return getT2Signal(ms);
    case 'T3': return getT3Signal(ms);
    default: return null;
  }
}

function formatBarrier(offset) {
  // Deriv rejects relative barriers with more than 2 decimal places,
  // regardless of the underlying market's own pip size.
  const sign = offset >= 0 ? '+' : '';
  return sign + offset.toFixed(2);
}

// =======================================================
// TRADE EXECUTION
// =======================================================
function executeTrade(signal, symbol) {
  state.tradeInFlight = true;
  state.awaiting = 'proposal';

  const stake = state.nextStake;
  const duration = parseInt(els.durationInput.value, 10) || 15;
  const barrierStr = formatBarrier(signal.barrierOffset);

  state.activeTradeMeta = {
    contractType: signal.contractType,
    barrier: barrierStr,
    stake,
    market: symbol,
    time: new Date(),
    contractId: null
  };

  log(`Signal ${signal.contractType} on ${symbol} — barrier ${barrierStr} @ stake ${fmtMoney(stake)}`, 'trade');

  wsSend({
    proposal: 1,
    amount: stake,
    basis: 'stake',
    contract_type: signal.contractType,
    barrier: barrierStr,
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
    contractType: meta.contractType || null,
    barrier: meta.barrier || null,
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
    dirEl.className = 'history-direction ' + (t.contractType === 'ONETOUCH' ? 'touch' : 'notouch');
    dirEl.textContent = t.contractType === 'ONETOUCH' ? 'ONE TOUCH' : 'NO TOUCH';

    const marketEl = document.createElement('span');
    marketEl.className = 'history-market';
    marketEl.textContent = `${t.market || ''} · barrier ${t.barrier || '—'}`;

    const metaEl = document.createElement('span');
    metaEl.className = 'history-meta';
    metaEl.textContent = `${fmtTime(t.time)} · ${fmtMoney(t.stake)} stake`;

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
