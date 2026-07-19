import { isAuthenticated, getToken } from '/src/core/auth/tokenManager.js';
import {
  connect as wsConnect,
  send as wsSend,
  getCurrentAccountId,
} from '/src/core/connection/wsClient.js';
import { on as busOn } from '/src/core/state/eventBus.js';
import { getAccountType } from '/src/core/state/accountPreference.js';

let lastUpdateTime = null;
let currentBalance = null;
let currentCurrency = 'USD';

const els = {
  totalBalance: document.getElementById('totalBalance'),
  updatedText: document.getElementById('updatedText'),
  refreshBtn: document.getElementById('refreshBtn'),
  optionsBalance: document.getElementById('optionsBalance'),
  optionsCurrency: document.getElementById('optionsCurrency'),
  accountTypeLabel: document.getElementById('accountTypeLabel'),
  accountIdLabel: document.getElementById('accountIdLabel'),
  avatarInitials: document.getElementById('avatarInitials'),
  depositBtn: document.getElementById('depositBtn'),
};

if (!isAuthenticated()) {
  window.location.href = '/';
} else {
  const accountType = getAccountType();
  els.accountTypeLabel.textContent = accountType === 'real' ? 'Real Account' : 'Demo Account';
  els.avatarInitials.textContent = accountType === 'real' ? 'R' : 'D';
  startConnection();
}

async function startConnection() {
  try {
    const token = getToken();
    await wsConnect(token, getAccountType());
    els.accountIdLabel.textContent = getCurrentAccountId() || '—';
    wsSend({ balance: 1, subscribe: 1 });
  } catch (err) {
    console.error('Connection failed:', err);
    els.updatedText.textContent = 'Connection failed';
  }
}

busOn('balance', (balance) => {
  currentBalance = Number(balance.balance);
  currentCurrency = balance.currency || 'USD';
  renderBalance();
  markUpdated();
});

function renderBalance() {
  if (currentBalance === null) return;
  const formatted = currentBalance.toFixed(2);
  els.totalBalance.textContent = `${formatted} ${currentCurrency}`;
  els.optionsBalance.textContent = formatted;
  els.optionsCurrency.textContent = currentCurrency;
}

function markUpdated() {
  lastUpdateTime = Date.now();
  updateTimestampText();
}

function updateTimestampText() {
  if (!lastUpdateTime) return;
  const elapsedMs = Date.now() - lastUpdateTime;
  const elapsedMin = Math.floor(elapsedMs / 60000);

  if (elapsedMin < 1) {
    els.updatedText.textContent = 'Updated just now';
  } else if (elapsedMin === 1) {
    els.updatedText.textContent = 'Updated 1 minute ago';
  } else {
    els.updatedText.textContent = `Updated ${elapsedMin} minutes ago`;
  }
}

// Recalculate the relative "Updated X ago" text every 30 seconds.
setInterval(updateTimestampText, 30000);

// Refresh button — request a fresh balance read and show a brief
// spinning state so the action feels responsive, even though the
// balance is already streaming live in the background.
els.refreshBtn.addEventListener('click', () => {
  els.refreshBtn.classList.add('spinning');
  wsSend({ balance: 1 });

  setTimeout(() => {
    els.refreshBtn.classList.remove('spinning');
    markUpdated();
  }, 1200);
});

els.depositBtn.addEventListener('click', () => {
  alert('Deposits are managed directly through your Deriv account, not through pipstrades.');
});
