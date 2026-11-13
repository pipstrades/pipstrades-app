/* =========================================================================
   PIPSTRADES — HIGHER/LOWER BOT
   Migrated from the standalone H/L Trader. Only the connection layer
   changed: the API token / App ID / Account ID form and manual OTP step
   are replaced by the platform's shared login and WebSocket connection.

   UNCHANGED from the standalone: the tick-confirmation entry scanner,
   the trend gauge, barrier construction (relative / absolute, opposite /
   same), buying BOTH Higher and Lower every round with independent
   stakes, per-side martingale, stop-loss / take-profit / loss-streak
   limits, and the contracts_for barrier suggestion.
   ========================================================================= */

import { isAuthenticated, getToken } from '/src/core/auth/tokenManager.js';
import {
  connect as wsConnect,
  send as wsSend,
  sendRequest as wsSendRequest,
} from '/src/core/connection/wsClient.js';
import { on as busOn } from '/src/core/state/eventBus.js';
import { getAccountType } from '/src/core/state/accountPreference.js';

const ROUND_GAP_MS = 1200;
const TREND_WINDOW = 20;

/* ---------------------------------------------------------------------
   Element cache
--------------------------------------------------------------------- */
window.els = {};
function cacheEls() {
  const ids = [
    'connectionDot', 'connectionStatusText', 'balanceValue',
    'statTrades', 'statWins', 'statLosses', 'statWinRate', 'statPL', 'statMartingale',
    'tickerPrice', 'tickerTrend', 'tickerProb', 'tickerSymbolName',
    'symbolSelect', 'durationVal', 'durationUnit', 'durationRangeHint',
    'contractTypeMode', 'barrierFormat', 'barrierMode', 'barrierOffset', 'higherStake', 'lowerStake',
    'scannerOn', 'scannerTicks',
    'martingaleOn', 'martingaleMult', 'stopLoss', 'takeProfit', 'maxLossStreak',
    'btnStart', 'btnStop', 'btnClearHistory', 'botState', 'logLine', 'historyList',
  ];
  ids.forEach((id) => (window.els[id] = document.getElementById(id)));
}

/* ---------------------------------------------------------------------
   State
--------------------------------------------------------------------- */
const state = {
  connected: false,

  symbol: null,
  tickSubId: null,

  lastQuote: null,
  waitingForQuoteLogged: false,
  trendWindow: [], // recent +1/-1 directions

  currency: 'USD',
  balance: null,
  initialBalance: null,

  botRunning: false,
  roundTimer: null,
  roundSeq: 0,

  // Tick-direction entry scanner (HL PRO style)
  scan: { rising: 0, falling: 0, armed: false },

  // Each side trades independently: its own base stake, current
  // (martingale-adjusted) stake, and its own loss streak.
  higher: { base: 1, current: 1, lossStreak: 0 },
  lower: { base: 1, current: 1, lossStreak: 0 },

  openContracts: {}, // contract_id -> { side, roundId, stake }
  openInRound: {},   // roundId -> Set of side-labels/contract_ids still open

  stats: { trades: 0, wins: 0, losses: 0 },
};

/* ---------------------------------------------------------------------
   Small helpers
--------------------------------------------------------------------- */
function fmt(n, dp) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Number(n).toFixed(dp === undefined ? 2 : dp);
}

// Known display decimals for the curated symbol list.
const SYMBOL_DECIMALS = {
  '1HZ10V': 2, '1HZ25V': 2, '1HZ50V': 2, '1HZ75V': 2, '1HZ100V': 2,
  'R_10': 3, 'R_25': 3, 'R_50': 4, 'R_75': 4, 'R_100': 2,
};

function decimalsForSymbol(code) {
  return SYMBOL_DECIMALS[code] !== undefined ? SYMBOL_DECIMALS[code] : 2;
}

// Shows only the single latest event (no accumulating history).
function log(msg, kind) {
  const el = window.els.logLine;
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const ss = String(t.getSeconds()).padStart(2, '0');
  el.className = 'status-msg ' + (kind || 'info');
  el.textContent = `${hh}:${mm}:${ss}  ${msg}`;
}

function setBotText(text) {
  window.els.botState.textContent = '🤖 ' + text;
}

function setConnUI(connected) {
  state.connected = connected;
  window.els.connectionDot.classList.toggle('live', connected);
  window.els.connectionStatusText.textContent = connected ? 'Connected · Live' : 'Disconnected';
  window.els.connectionStatusText.style.color = connected && getAccountType() === 'real' ? '#ff2d55' : '';
  window.els.btnStart.disabled = !connected || state.botRunning;
}

function setBotUI(running) {
  state.botRunning = running;
  window.els.btnStart.disabled = !state.connected || running;
  window.els.btnStop.disabled = !running;
  window.els.botState.classList.toggle('active', running);
  setBotText(running ? 'Bot is running…' : 'Bot is idle');
}

/* ---------------------------------------------------------------------
   Connection — platform OAuth session + shared wsClient
--------------------------------------------------------------------- */
async function startConnection() {
  if (!isAuthenticated()) {
    window.location.href = '/';
    return;
  }

  try {
    await wsConnect(getToken(), getAccountType());
    setConnUI(true);
    log('Connected.', 'info');

    wsSend({ balance: 1, subscribe: 1 });
    selectSymbol(window.els.symbolSelect.value);
    requestContractsFor(window.els.symbolSelect.value);
  } catch (err) {
    window.els.connectionStatusText.textContent = 'Connection failed';
    log(`Connection failed: ${err.message}`, 'warn');
    setConnUI(false);
  }
}

busOn('connection:close', () => {
  if (state.roundTimer) clearTimeout(state.roundTimer);
  state.roundTimer = null;
  setConnUI(false);
  setBotUI(false);
  log('Connection closed.', 'warn');
});

busOn('connection:error', (err) => {
  log(`API error: ${(err && err.message) || err}`, 'warn');
});

busOn('balance', (b) => handleBalance(b));
busOn('tick', (tick) => handleTick(tick));
busOn('contractUpdate', (poc) => handleProposalOpenContract(poc));

/* ---------------------------------------------------------------------
   Balance
--------------------------------------------------------------------- */
function handleBalance(b) {
  if (!b) return;
  state.currency = b.currency || state.currency;
  state.balance = Number(b.balance);
  if (state.initialBalance === null) state.initialBalance = state.balance;
  window.els.balanceValue.textContent = fmt(state.balance);
  updatePLDisplay();
  checkRiskLimits();
}

function updatePLDisplay() {
  const pl = state.initialBalance === null || state.balance === null
    ? 0 : state.balance - state.initialBalance;
  const el = window.els.statPL;
  el.textContent = (pl >= 0 ? '+' : '-') + '$' + fmt(Math.abs(pl));
  el.style.color = pl > 0 ? '#39ff14' : pl < 0 ? '#ff2d55' : '';
}

// Asks Deriv what this account/symbol supports and uses its own suggested
// barrier magnitude for the chosen tick-duration bracket as the offset.
async function requestContractsFor(symbol) {
  try {
    const msg = await wsSendRequest({ contracts_for: symbol });
    handleContractsFor(msg && msg.contracts_for);
  } catch (err) {
    log(`contracts_for failed: ${err.message}`, 'warn');
  }
}

function handleContractsFor(cf) {
  if (!cf) return;
  const list = cf.available || [];
  const relevant = list.filter((c) =>
    c.contract_type === 'CALL' || c.contract_type === 'PUT' ||
    c.contract_type === 'HIGHER' || c.contract_type === 'LOWER'
  );
  if (!relevant.length) {
    log(`contracts_for: no CALL/PUT/HIGHER/LOWER entries found for ${state.symbol}.`, 'warn');
    return;
  }

  const duration = parseInt(window.els.durationVal.value, 10) || 5;
  const candidates = relevant.filter((c) => {
    const min = parseInt(c.min_contract_duration, 10);
    const max = parseInt(c.max_contract_duration, 10);
    const isTicks = /t$/.test(c.min_contract_duration || '') || /t$/.test(c.max_contract_duration || '');
    return isTicks && !isNaN(min) && !isNaN(max) && duration >= min && duration <= max;
  });
  // Several brackets can contain the same duration — prefer the narrowest
  // (highest min), matching the "Range" hint in the UI.
  candidates.sort((a, b) => parseInt(b.min_contract_duration, 10) - parseInt(a.min_contract_duration, 10));
  const match = candidates[0] || relevant.find((c) => /t$/.test(c.min_contract_duration || ''));

  if (match && match.barrier !== undefined) {
    const magnitude = Math.abs(parseFloat(match.barrier));
    if (!isNaN(magnitude) && magnitude > 0) {
      window.els.barrierOffset.value = magnitude.toFixed(decimalsForSymbol(state.symbol));
      log(`Barrier offset auto-set to ${window.els.barrierOffset.value} (Deriv's own suggested magnitude for this duration bracket).`, 'info');
    }
  }
}

/* ---------------------------------------------------------------------
   Symbol selection
--------------------------------------------------------------------- */
function selectSymbol(code) {
  if (state.tickSubId) wsSend({ forget: state.tickSubId });
  state.tickSubId = null;

  state.symbol = code;
  state.lastQuote = null;
  state.trendWindow = [];
  const opt = window.els.symbolSelect.selectedOptions[0];
  window.els.tickerSymbolName.textContent = (opt ? opt.textContent : code).toUpperCase();

  wsSend({ ticks: code, subscribe: 1 });
}

/* ---------------------------------------------------------------------
   Ticks -> price, trend, probability gauge
--------------------------------------------------------------------- */
function handleTick(tick) {
  if (!tick || tick.symbol !== state.symbol) return;
  if (tick.id) state.tickSubId = tick.id;

  const dp = decimalsForSymbol(tick.symbol);
  const quote = tick.quote;
  const priceEl = window.els.tickerPrice;
  priceEl.textContent = fmt(quote, dp);
  priceEl.className = 'live-price';

  let dir = null; // null = first tick, nothing to compare against yet
  if (state.lastQuote !== null) {
    dir = quote > state.lastQuote ? 1 : quote < state.lastQuote ? -1 : 0;
    if (dir !== 0) {
      priceEl.classList.add(dir > 0 ? 'up' : 'down');
      state.trendWindow.push(dir);
      if (state.trendWindow.length > TREND_WINDOW) state.trendWindow.shift();
    }
  }
  state.lastQuote = quote;
  updateTrendGauge();
  if (dir !== null) scanTick(dir);
}

/* ---------------------------------------------------------------------
   Entry scanner (from the HL PRO 2.2 strategy): count consecutive
   rising/falling ticks; a flat tick resets both counts. Once either
   reaches the confirm count, fire one round (lead side first) and stop
   scanning until that round settles, then start a fresh count.
--------------------------------------------------------------------- */
function armScanner() {
  state.scan.armed = true;
  state.scan.rising = 0;
  state.scan.falling = 0;
  setBotText('Scanning for a confirmed move…');
}

function scanTick(dir) {
  const s = state.scan;
  if (!state.botRunning || !window.els.scannerOn.checked || !s.armed) return;
  const need = Math.max(1, parseInt(window.els.scannerTicks.value, 10) || 3);

  if (dir > 0) { s.rising++; s.falling = 0; }
  else if (dir < 0) { s.falling++; s.rising = 0; }
  else { s.rising = 0; s.falling = 0; }

  if (s.rising >= need || s.falling >= need) {
    const signal = s.rising >= need ? 'rising' : 'falling';
    s.armed = false;
    s.rising = 0;
    s.falling = 0;
    setBotText('Bot is running…');
    placeRound(signal);
  } else {
    setBotText(`Scanning… ↑${s.rising} ↓${s.falling} of ${need}`);
  }
}

function updateTrendGauge() {
  const w = state.trendWindow;
  const trendEl = window.els.tickerTrend;
  const probEl = window.els.tickerProb;
  if (!w.length) {
    trendEl.textContent = 'NEUTRAL';
    trendEl.className = 'ticker-trend neutral';
    probEl.textContent = '50%';
    return;
  }
  const ups = w.filter((d) => d > 0).length;
  const pct = Math.round((ups / w.length) * 100);
  probEl.textContent = pct + '%';
  if (pct >= 55) {
    trendEl.textContent = 'UP BIAS';
    trendEl.className = 'ticker-trend up';
  } else if (pct <= 45) {
    trendEl.textContent = 'DOWN BIAS';
    trendEl.className = 'ticker-trend down';
  } else {
    trendEl.textContent = 'NEUTRAL';
    trendEl.className = 'ticker-trend neutral';
  }
}

/* ---------------------------------------------------------------------
   Barrier / contract type — Higher = CALL, Lower = PUT (classic) or the
   native HIGHER/LOWER strings, single "barrier" field, relative signed
   offset or absolute level.
--------------------------------------------------------------------- */
function apiContractType(side) {
  if (window.els.contractTypeMode.value === 'higherlower') return side;
  return side === 'HIGHER' ? 'CALL' : 'PUT';
}

function barrierValue(side) {
  const offset = parseFloat(window.els.barrierOffset.value) || 0;
  const dp = decimalsForSymbol(state.symbol);
  // "opposite": Higher +offset / Lower −offset. "same": both +offset.
  const positive = window.els.barrierMode.value === 'same' || side === 'HIGHER';
  if (window.els.barrierFormat.value === 'absolute') {
    const target = state.lastQuote + (positive ? offset : -offset);
    return target.toFixed(dp);
  }
  return `${positive ? '+' : '-'}${offset.toFixed(dp)}`;
}

function stakeState(side) {
  return side === 'HIGHER' ? state.higher : state.lower;
}

/* ---------------------------------------------------------------------
   Trading — proposal -> buy -> settlement. Both sides of a round run
   concurrently, lead side first, exactly as before.
--------------------------------------------------------------------- */
function placeRound(signal) {
  if (!state.botRunning || !state.symbol) return;

  if (state.lastQuote === null) {
    if (!state.waitingForQuoteLogged) {
      log('Waiting for a live price before placing the first trade…', 'info');
      state.waitingForQuoteLogged = true;
    }
    state.roundTimer = setTimeout(() => placeRound(signal), 500);
    return;
  }
  state.waitingForQuoteLogged = false;

  const roundId = ++state.roundSeq;
  const sides = signal === 'falling' ? ['LOWER', 'HIGHER'] : ['HIGHER', 'LOWER'];
  state.openInRound[roundId] = new Set(sides);

  const duration = parseInt(window.els.durationVal.value, 10) || 5;
  const durationUnit = window.els.durationUnit.value;

  log(
    `Round #${roundId}${signal ? ` (${signal} signal)` : ''}: requesting HIGHER @ ${fmt(state.higher.current)} + LOWER @ ${fmt(state.lower.current)} ${state.currency}`,
    'info'
  );

  sides.forEach((side) => {
    placeSide(side, roundId, stakeState(side).current, duration, durationUnit, barrierValue(side));
  });
}

async function placeSide(side, roundId, stake, duration, durationUnit, barrier) {
  try {
    const prop = await wsSendRequest({
      proposal: 1,
      amount: stake,
      basis: 'stake',
      contract_type: apiContractType(side),
      currency: state.currency,
      underlying_symbol: state.symbol,
      duration,
      duration_unit: durationUnit,
      barrier,
    });
    const p = prop.proposal;
    const buy = await wsSendRequest({ buy: p.id, price: p.ask_price });
    handleBuy(buy.buy, side, roundId);
  } catch (err) {
    // A failed proposal/buy must not leave the round hanging forever.
    log(`[${side}] API error: ${err.message}`, 'warn');
    settleRoundSide(roundId, side, null);
  }
}

function handleBuy(buy, side, roundId) {
  if (!buy) return;

  state.openContracts[buy.contract_id] = { side, roundId, stake: Number(buy.buy_price) };
  if (state.openInRound[roundId]) {
    state.openInRound[roundId].delete(side);
    state.openInRound[roundId].add(buy.contract_id);
  }
  state.stats.trades++;
  window.els.statTrades.textContent = state.stats.trades;
  log(`Bought ${side} · stake ${fmt(buy.buy_price)} ${state.currency} · contract #${buy.contract_id}`, 'info');

  wsSend({ proposal_open_contract: 1, contract_id: buy.contract_id, subscribe: 1 });
}

function handleProposalOpenContract(poc) {
  if (!poc || !poc.contract_id) return;
  const rec = state.openContracts[poc.contract_id];
  if (!rec) return;

  if (!poc.is_sold) return; // still running, nothing to settle yet

  const profit = typeof poc.profit === 'number' ? poc.profit : (poc.sell_price - poc.buy_price);
  const won = profit > 0;
  const sideState = stakeState(rec.side);

  if (won) {
    state.stats.wins++;
    sideState.lossStreak = 0;
  } else {
    state.stats.losses++;
    sideState.lossStreak++;
  }
  window.els.statWins.textContent = state.stats.wins;
  window.els.statLosses.textContent = state.stats.losses;
  const total = state.stats.wins + state.stats.losses;
  window.els.statWinRate.textContent = total ? Math.round((state.stats.wins / total) * 100) + '%' : '0%';

  log(
    `${rec.side} contract #${poc.contract_id} ${won ? 'WON' : 'LOST'} · P/L ${profit >= 0 ? '+' : ''}${fmt(profit)} ${state.currency}`,
    won ? 'win' : 'loss'
  );
  addHistoryItem(rec.side, poc.contract_id, rec.stake, profit, won);

  delete state.openContracts[poc.contract_id];
  settleRoundSide(rec.roundId, null, poc.contract_id);
}

function settleRoundSide(roundId, side, contractId) {
  const set = state.openInRound[roundId];
  if (!set) return;
  if (contractId !== null && contractId !== undefined) set.delete(contractId);
  if (side) set.delete(side);

  if (set.size === 0) {
    delete state.openInRound[roundId];
    onRoundComplete();
  }
}

function onRoundComplete() {
  applyMartingale();
  if (!checkRiskLimits()) return;
  if (!state.botRunning) return;
  if (window.els.scannerOn.checked) { armScanner(); return; }
  state.roundTimer = setTimeout(() => placeRound(), ROUND_GAP_MS);
}

// Each side's stake progresses independently off its own loss streak.
function applyMartingale() {
  [state.higher, state.lower].forEach((s) => {
    if (!window.els.martingaleOn.checked) {
      s.current = s.base;
      return;
    }
    const mult = parseFloat(window.els.martingaleMult.value) || 2;
    s.current = s.lossStreak > 0
      ? +(s.base * Math.pow(mult, s.lossStreak)).toFixed(2)
      : s.base;
  });
}

function checkRiskLimits() {
  const sl = parseFloat(window.els.stopLoss.value);
  const tp = parseFloat(window.els.takeProfit.value);
  const maxStreak = parseInt(window.els.maxLossStreak.value, 10);
  const pl = state.initialBalance === null || state.balance === null
    ? 0 : state.balance - state.initialBalance;
  const worstStreak = Math.max(state.higher.lossStreak, state.lower.lossStreak);

  if (state.botRunning && !isNaN(sl) && sl > 0 && pl <= -Math.abs(sl)) {
    stopBot(`Stop loss of ${fmt(sl)} ${state.currency} reached.`);
    return false;
  }
  if (state.botRunning && !isNaN(tp) && tp > 0 && pl >= Math.abs(tp)) {
    stopBot(`Take profit of ${fmt(tp)} ${state.currency} reached.`);
    return false;
  }
  if (state.botRunning && !isNaN(maxStreak) && maxStreak > 0 && worstStreak >= maxStreak) {
    stopBot(`Paused after ${worstStreak} consecutive losses on one side.`);
    return false;
  }
  return true;
}

/* ---------------------------------------------------------------------
   Trade history list (right panel)
--------------------------------------------------------------------- */
function addHistoryItem(side, contractId, stake, profit, won) {
  const container = window.els.historyList;
  const placeholder = container.querySelector('div[style]');
  if (placeholder && placeholder.textContent.trim() === 'No trades yet') placeholder.remove();

  const time = new Date().toLocaleTimeString();
  const badge = won
    ? `<span class="win-badge">✅ WIN +$${fmt(Math.abs(profit))}</span>`
    : `<span class="loss-badge">❌ LOSS -$${fmt(Math.abs(profit))}</span>`;

  const item = document.createElement('div');
  item.className = 'history-item ' + (won ? 'history-win' : 'history-loss');
  item.innerHTML =
    `<div><div class="history-side ${side.toLowerCase()}">${side}</div>` +
    `<div style="font-size:0.7rem;color:#6b7280;">${time} · $${fmt(stake)} stake</div></div>` +
    `<div style="text-align:right;">${badge}` +
    `<div style="font-size:0.65rem;color:#4b5563;margin-top:3px;">#${contractId}</div></div>`;
  container.insertBefore(item, container.firstChild);
}

/* ---------------------------------------------------------------------
   Start / stop bot
--------------------------------------------------------------------- */
function startBot() {
  if (!state.connected || !state.symbol) return;
  state.higher.base = parseFloat(window.els.higherStake.value) || 1;
  state.higher.current = state.higher.base;
  state.higher.lossStreak = 0;
  state.lower.base = parseFloat(window.els.lowerStake.value) || 1;
  state.lower.current = state.lower.base;
  state.lower.lossStreak = 0;
  state.roundSeq = 0;
  state.openContracts = {};
  state.openInRound = {};
  setBotUI(true);
  log('Bot started.', 'info');
  if (window.els.scannerOn.checked) armScanner(); else placeRound();
}

function stopBot(reason) {
  setBotUI(false);
  state.scan.armed = false;
  if (state.roundTimer) clearTimeout(state.roundTimer);
  state.roundTimer = null;
  log(reason ? `Bot stopped — ${reason}` : 'Bot stopped. Any open contracts will still settle.', 'warn');
}

// Resets session stats and re-baselines P/L (so stop-loss/take-profit are
// measured fresh from here) and each side's martingale progress. Does not
// touch the configured SL/TP threshold values themselves.
function clearHistory() {
  state.stats = { trades: 0, wins: 0, losses: 0 };
  window.els.statTrades.textContent = '0';
  window.els.statWins.textContent = '0';
  window.els.statLosses.textContent = '0';
  window.els.statWinRate.textContent = '0%';

  if (state.balance !== null) state.initialBalance = state.balance;
  updatePLDisplay();

  state.higher.current = state.higher.base;
  state.higher.lossStreak = 0;
  state.lower.current = state.lower.base;
  state.lower.lossStreak = 0;

  window.els.historyList.innerHTML = '<div style="text-align:center;color:#5b6e8c;">No trades yet</div>';
  log('History cleared — stats and session P/L reset.', 'info');
}

/* ---------------------------------------------------------------------
   Wire up UI
--------------------------------------------------------------------- */
function bindEvents() {
  window.els.btnStart.addEventListener('click', startBot);
  window.els.btnStop.addEventListener('click', () => stopBot());
  window.els.btnClearHistory.addEventListener('click', clearHistory);

  window.els.symbolSelect.addEventListener('change', (e) => {
    selectSymbol(e.target.value);
    if (state.connected) requestContractsFor(e.target.value);
  });

  window.els.durationUnit.addEventListener('change', () => {
    const isTicks = window.els.durationUnit.value === 't';
    window.els.durationRangeHint.classList.toggle('hidden', !isTicks);
  });

  window.els.martingaleOn.addEventListener('change', () => {
    window.els.martingaleMult.disabled = !window.els.martingaleOn.checked;
    window.els.statMartingale.textContent = window.els.martingaleOn.checked ? 'ON' : 'OFF';
  });

  window.els.scannerOn.addEventListener('change', () => {
    window.els.scannerTicks.disabled = !window.els.scannerOn.checked;
    // Switched off while waiting for a signal: don't leave the bot idle forever.
    if (state.botRunning && !window.els.scannerOn.checked && state.scan.armed) {
      state.scan.armed = false;
      setBotText('Bot is running…');
      placeRound();
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  cacheEls();
  bindEvents();
  setConnUI(false);
  setBotUI(false);
  log('Ready. Connecting to your Deriv account…', 'info');
  startConnection();
});
