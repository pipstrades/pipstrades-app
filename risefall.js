// ==========================================================================
// PIPSTRADES — RISE/FALL BOT (connection layer replaced, entry logic untouched)
// ==========================================================================
// Uses the platform's shared OAuth session + WebSocket connection instead of
// a manual API Token form and the standalone bot's (incorrect/legacy) auth
// endpoint.
//
// UNCHANGED building blocks from the original standalone bot: ema(),
// stddev(), rsi() — the raw math. The four original signals (EMA
// Crossover, Bollinger Reversion, Streak Exhaustion, RSI Extreme) have
// been combined into two strategies per your request:
//
//   M1 = Bollinger Reversion + RSI Extreme, both required to agree
//   M2 = EMA Crossover (as a regime filter) gating Streak Exhaustion —
//        the streak signal only fires when EMA finds no clear trend
//
// The single-active-strategy toggle behavior, martingale staking, and
// session stop-loss/take-profit are otherwise unchanged.
//
// One protocol-level fix (not entry logic): the proposal request now uses
// `underlying_symbol` instead of `symbol`, matching Deriv's actual API and
// the convention already used by your other two bots.
// ==========================================================================

import { isAuthenticated, getToken } from '/src/core/auth/tokenManager.js';
import {
  connect as wsConnect,
  send as wsSend,
  sendRequest as wsSendRequest,
} from '/src/core/connection/wsClient.js';
import { on as busOn } from '/src/core/state/eventBus.js';
import { getAccountType } from '/src/core/state/accountPreference.js';

window.els = {
  connStatus: document.getElementById('connStatus'),
  balanceBox: document.getElementById('balanceBox'),

  symbol: document.getElementById('symbol'),
  stake: document.getElementById('stake'),
  duration: document.getElementById('duration'),

  martingaleToggle: document.getElementById('martingaleToggle'),
  martingaleMultiplier: document.getElementById('martingaleMultiplier'),
  stopLossToggle: document.getElementById('stopLossToggle'),
  stopLossValue: document.getElementById('stopLossValue'),
  takeProfitToggle: document.getElementById('takeProfitToggle'),
  takeProfitValue: document.getElementById('takeProfitValue'),

  strategyList: document.getElementById('strategyList'),
  btnStart: document.getElementById('btnStart'),
  btnStop: document.getElementById('btnStop'),

  statPL: document.getElementById('statPL'),
  statWins: document.getElementById('statWins'),
  statLosses: document.getElementById('statLosses'),
  statStrategy: document.getElementById('statStrategy'),

  log: document.getElementById('log'),
};

const els = window.els;

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------
const state = {
  connected: false,
  pipSize: 2,
  currentStake: 1,
  baseStake: 1,
  sessionPL: 0,
  wins: 0,
  losses: 0,
  tradeInProgress: false,
  botRunning: false,
  tickHistory: [],     // raw quote values
  activeStrategy: null, // 'M1' | 'M2' | 'M3' | 'M4' | null
  currentContractId: null,
};

// --------------------------------------------------------------------------
// Strategy definitions — M1 to M4 (UNCHANGED — core entry logic)
// Each strategy function receives the tick history array (numbers, oldest
// first) and returns 'CALL' (Rise), 'PUT' (Fall), or null (no signal yet).
// --------------------------------------------------------------------------
function ema(values, period) {
  const k = 2 / (period + 1);
  let emaPrev = values[0];
  for (let i = 1; i < values.length; i++) {
    emaPrev = values[i] * k + emaPrev * (1 - k);
  }
  return emaPrev;
}

function stddev(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, sd: Math.sqrt(variance) };
}

function rsi(values, period) {
  if (values.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

const STRATEGIES = {
  M1: {
    name: 'Bollinger + RSI Confirmation',
    desc: 'Price at outer Bollinger band AND RSI(14) confirms overbought/oversold — both must agree',
    minTicks: 20,
    fn(history) {
      // Sub-signal 1: Bollinger Reversion (original M2 logic, unchanged)
      const window = history.slice(-20);
      const { mean, sd } = stddev(window);
      const last = history[history.length - 1];
      const upper = mean + 2 * sd;
      const lower = mean - 2 * sd;
      let bollingerSignal = null;
      if (last >= upper) bollingerSignal = 'PUT';
      else if (last <= lower) bollingerSignal = 'CALL';

      // Sub-signal 2: RSI Extreme (original M4 logic, unchanged)
      const rsiValue = rsi(history, 14);
      let rsiSignal = null;
      if (rsiValue !== null) {
        if (rsiValue > 70) rsiSignal = 'PUT';
        else if (rsiValue < 30) rsiSignal = 'CALL';
      }

      // Only fire when both sub-signals agree on the same direction.
      if (bollingerSignal !== null && bollingerSignal === rsiSignal) {
        return bollingerSignal;
      }
      return null;
    },
  },
  M2: {
    name: 'EMA Regime Filter + Streak Exhaustion',
    desc: 'Streak-exhaustion signal only fires when the EMA crossover check finds no clear trend',
    minTicks: 21,
    fn(history) {
      // Regime gate: reuse the EMA crossover check (original M1 logic,
      // unchanged). A non-null result means a crossover is happening right
      // now — a clear trend — so we deliberately suppress the streak
      // signal in that case.
      const fast = ema(history.slice(-5), 5);
      const slow = ema(history.slice(-20), 20);
      const prevFast = ema(history.slice(-6, -1), 5);
      const prevSlow = ema(history.slice(-21, -1), 20);
      let emaSignal = null;
      if (prevFast <= prevSlow && fast > slow) emaSignal = 'CALL';
      else if (prevFast >= prevSlow && fast < slow) emaSignal = 'PUT';

      if (emaSignal !== null) {
        return null; // clear trend detected — do not fire the streak signal
      }

      // No clear trend ("ranging") — evaluate Streak Exhaustion
      // (original M3 logic, unchanged).
      const streakLen = 4;
      const recent = history.slice(-(streakLen + 1));
      let allUp = true, allDown = true;
      for (let i = 1; i < recent.length; i++) {
        if (recent[i] <= recent[i - 1]) allUp = false;
        if (recent[i] >= recent[i - 1]) allDown = false;
      }
      if (allUp) return 'PUT';
      if (allDown) return 'CALL';
      return null;
    },
  },
};

// --------------------------------------------------------------------------
// Strategy UI — render toggles, enforce single-active behavior (UNCHANGED)
// --------------------------------------------------------------------------
function renderStrategyList() {
  els.strategyList.innerHTML = '';
  Object.entries(STRATEGIES).forEach(([code, strat]) => {
    const row = document.createElement('div');
    row.className = 'strategy-item';
    row.innerHTML = `
      <span class="label"><span class="code">${code}</span>${strat.name}
        <span class="desc">${strat.desc}</span>
      </span>
      <label class="switch">
        <input type="checkbox" data-strategy="${code}" />
        <span class="slider"></span>
      </label>
    `;
    els.strategyList.appendChild(row);
  });

  els.strategyList.querySelectorAll('input[type="checkbox"]').forEach((box) => {
    box.addEventListener('change', (e) => {
      const code = e.target.dataset.strategy;
      if (e.target.checked) {
        // turn every other toggle off — only one strategy active at a time
        els.strategyList.querySelectorAll('input[type="checkbox"]').forEach((other) => {
          if (other !== e.target) other.checked = false;
        });
        state.activeStrategy = code;
        els.statStrategy.textContent = `${code} — ${STRATEGIES[code].name}`;
      } else {
        state.activeStrategy = null;
        els.statStrategy.textContent = '—';
      }
      updateStartButton();
    });
  });
}
renderStrategyList();

function updateStartButton() {
  els.btnStart.disabled = !(state.connected && state.activeStrategy && !state.botRunning);
}

// --------------------------------------------------------------------------
// Logging helper (UNCHANGED)
// --------------------------------------------------------------------------
function logLine(text, cls = 'info') {
  const line = document.createElement('div');
  line.className = cls;
  const ts = new Date().toLocaleTimeString();
  line.textContent = `[${ts}] ${text}`;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
}

// --------------------------------------------------------------------------
// CONNECTION — via platform OAuth session + shared wsClient
// (replaces the standalone bot's API-token form and auth endpoint entirely)
// --------------------------------------------------------------------------
async function startConnection() {
  if (!isAuthenticated()) {
    window.location.href = '/';
    return;
  }

  try {
    const token = getToken();
    await wsConnect(token, getAccountType());
    state.connected = true;
    els.connStatus.textContent = '● Connected';
    els.connStatus.classList.add('online');
    if (getAccountType() === 'real') {
      els.connStatus.style.color = '#ff2d55';
    }
    logLine('Connected.', 'info');

    wsSend({ balance: 1, subscribe: 1 });
    await preloadTickHistory(els.symbol.value);
    subscribeTicks(els.symbol.value);
    updateStartButton();
  } catch (err) {
    logLine(`Connection failed: ${err.message}`, 'loss');
  }
}

busOn('connection:close', () => {
  state.connected = false;
  els.connStatus.textContent = '● Disconnected';
  els.connStatus.classList.remove('online');
  updateStartButton();
  if (state.botRunning) stopBot();
});

busOn('connection:error', (err) => {
  logLine(`WebSocket error: ${err.message || err}`, 'loss');
});

busOn('balance', (balance) => {
  els.balanceBox.textContent = `${Number(balance.balance).toFixed(2)} ${balance.currency}`;
});

busOn('proposal', (proposal) => {
  if (proposal) buyContract(proposal.id);
});

busOn('buy', (buy) => {
  state.currentContractId = buy.contract_id;
  logLine(`Trade placed — contract ${buy.contract_id} (${state.activeStrategy})`, 'info');
  wsSend({ proposal_open_contract: 1, contract_id: buy.contract_id, subscribe: 1 });
});

busOn('contractUpdate', (contract) => {
  handleContractUpdate(contract);
});

busOn('tick', (tick) => {
  if (tick.symbol !== els.symbol.value) return; // symbol-filtered
  onTick(tick);
});

function subscribeTicks(symbol) {
  wsSend({ ticks: symbol, subscribe: 1 });
}

// --------------------------------------------------------------------------
// PRELOAD TICK HISTORY — fetches Deriv's own recent tick history so the
// strategies (especially M1's 21-tick EMA window) have real data to work
// with immediately, instead of starting empty and building live.
// --------------------------------------------------------------------------
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

    state.tickHistory = prices.slice(-200);
    logLine(`Loaded ${state.tickHistory.length} recent ticks from Deriv for ${symbol}.`, 'info');
  } catch (err) {
    console.error('Tick history preload failed:', err);
    logLine('Could not preload tick history — building live instead.', 'info');
  }
}

// --------------------------------------------------------------------------
// Tick handling + strategy evaluation (UNCHANGED)
// --------------------------------------------------------------------------
function onTick(tick) {
  // derive pip_size decimal formatting from the tick's quote precision
  const quoteStr = String(tick.quote);
  const decimals = quoteStr.includes('.') ? quoteStr.split('.')[1].length : 0;
  state.pipSize = decimals;

  state.tickHistory.push(tick.quote);
  if (state.tickHistory.length > 200) state.tickHistory.shift();

  if (!state.botRunning || state.tradeInProgress || !state.activeStrategy) return;

  const strat = STRATEGIES[state.activeStrategy];
  if (state.tickHistory.length < strat.minTicks) return;

  const signal = strat.fn.call(strat, state.tickHistory);
  if (signal) placeTrade(signal);
}

function placeTrade(direction) {
  state.tradeInProgress = true;
  const contractType = direction === 'CALL' ? 'CALL' : 'PUT';

  wsSend({
    proposal: 1,
    amount: Number(state.currentStake.toFixed(2)),
    basis: 'stake',
    contract_type: contractType,
    currency: 'USD',
    duration: Number(els.duration.value),
    duration_unit: 't',
    underlying_symbol: els.symbol.value,
  });
}

function buyContract(proposalId) {
  wsSend({ buy: proposalId, price: Number(state.currentStake.toFixed(2)) });
}

function handleContractUpdate(contract) {
  if (!contract.is_sold) return; // only act once the contract settles
  if (contract.contract_id !== state.currentContractId) return;

  state.tradeInProgress = false;
  const profit = Number(contract.profit);
  state.sessionPL += profit;

  if (profit >= 0) {
    state.wins++;
    logLine(`WIN  +${profit.toFixed(2)} (${state.activeStrategy})`, 'win');
    state.currentStake = state.baseStake; // reset stake on win
  } else {
    state.losses++;
    logLine(`LOSS ${profit.toFixed(2)} (${state.activeStrategy})`, 'loss');
    if (els.martingaleToggle.checked) {
      const mult = Number(els.martingaleMultiplier.value) || 2;
      state.currentStake = state.currentStake * mult;
    }
  }

  els.statPL.textContent = state.sessionPL.toFixed(2);
  els.statWins.textContent = state.wins;
  els.statLosses.textContent = state.losses;

  checkSessionLimits();
}

function checkSessionLimits() {
  if (els.stopLossToggle.checked) {
    const limit = Number(els.stopLossValue.value);
    if (state.sessionPL <= -Math.abs(limit)) {
      logLine(`Session stop-loss hit (${state.sessionPL.toFixed(2)}). Stopping bot.`, 'loss');
      stopBot();
      return;
    }
  }
  if (els.takeProfitToggle.checked) {
    const target = Number(els.takeProfitValue.value);
    if (state.sessionPL >= Math.abs(target)) {
      logLine(`Session take-profit hit (${state.sessionPL.toFixed(2)}). Stopping bot.`, 'win');
      stopBot();
    }
  }
}

// --------------------------------------------------------------------------
// Start / Stop controls (UNCHANGED)
// --------------------------------------------------------------------------
function startBot() {
  if (!state.activeStrategy) {
    logLine('Select a strategy (M1–M4) before starting.', 'loss');
    return;
  }
  state.botRunning = true;
  state.baseStake = Number(els.stake.value) || 1;
  state.currentStake = state.baseStake;
  state.sessionPL = 0;
  state.wins = 0;
  state.losses = 0;
  els.statPL.textContent = '0.00';
  els.statWins.textContent = '0';
  els.statLosses.textContent = '0';

  els.btnStart.disabled = true;
  els.btnStop.disabled = false;
  logLine(`Bot started with strategy ${state.activeStrategy} on ${els.symbol.value}.`, 'info');
}

function stopBot() {
  state.botRunning = false;
  els.btnStart.disabled = false;
  els.btnStop.disabled = true;
  logLine('Bot stopped.', 'info');
  updateStartButton();
}

// --------------------------------------------------------------------------
// Event wiring
// --------------------------------------------------------------------------
els.btnStart.addEventListener('click', startBot);
els.btnStop.addEventListener('click', stopBot);

els.martingaleToggle.addEventListener('change', () => {
  els.martingaleMultiplier.disabled = !els.martingaleToggle.checked;
});
els.stopLossToggle.addEventListener('change', () => {
  els.stopLossValue.disabled = !els.stopLossToggle.checked;
});
els.takeProfitToggle.addEventListener('change', () => {
  els.takeProfitValue.disabled = !els.takeProfitToggle.checked;
});

els.symbol.addEventListener('change', () => {
  if (state.connected) {
    state.tickHistory = [];
    wsSend({ forget_all: 'ticks' });
    preloadTickHistory(els.symbol.value).then(() => subscribeTicks(els.symbol.value));
  }
});

// --------------------------------------------------------------------------
// INIT
// --------------------------------------------------------------------------
startConnection();
