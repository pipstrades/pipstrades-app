import { getAllTrades, clearLog, exportCsv } from '/src/core/state/tradeLog.js';

const els = {
  botFilter: document.getElementById('botFilter'),
  marketFilter: document.getElementById('marketFilter'),
  directionFilter: document.getElementById('directionFilter'),
  content: document.getElementById('content'),
  exportBtn: document.getElementById('exportBtn'),
  clearBtn: document.getElementById('clearBtn'),
};

let allTrades = [];

function init() {
  allTrades = getAllTrades();
  populateFilters();
  render();
}

function populateFilters() {
  const bots = [...new Set(allTrades.map((t) => t.bot))].sort();
  const markets = [...new Set(allTrades.map((t) => t.market))].sort();
  const directions = [...new Set(allTrades.map((t) => t.direction))].sort();

  fillSelect(els.botFilter, bots, 'All bots');
  fillSelect(els.marketFilter, markets, 'All markets');
  fillSelect(els.directionFilter, directions, 'All directions');
}

function fillSelect(select, values, defaultLabel) {
  const current = select.value;
  select.innerHTML = `<option value="">${defaultLabel}</option>` +
    values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  if (values.includes(current)) select.value = current;
}

function getFiltered() {
  return allTrades.filter((t) =>
    (!els.botFilter.value || t.bot === els.botFilter.value) &&
    (!els.marketFilter.value || t.market === els.marketFilter.value) &&
    (!els.directionFilter.value || t.direction === els.directionFilter.value)
  );
}

function render() {
  const trades = getFiltered();

  if (allTrades.length === 0) {
    els.content.innerHTML = `<div class="empty-state">No trades logged yet. Once your bots start placing and settling trades, results will show up here automatically.</div>`;
    return;
  }

  if (trades.length === 0) {
    els.content.innerHTML = `<div class="empty-state">No trades match the current filters.</div>`;
    return;
  }

  const summary = summarize(trades);

  els.content.innerHTML = `
    <div class="summary-grid">
      <div class="summary-card"><div class="summary-label">Trades</div><div class="summary-value neutral">${summary.total}</div></div>
      <div class="summary-card"><div class="summary-label">Wins</div><div class="summary-value win">${summary.wins}</div></div>
      <div class="summary-card"><div class="summary-label">Losses</div><div class="summary-value loss">${summary.losses}</div></div>
      <div class="summary-card"><div class="summary-label">Win Rate</div><div class="summary-value neutral">${summary.winRate}%</div></div>
      <div class="summary-card"><div class="summary-label">Net P/L</div><div class="summary-value ${summary.netPnl >= 0 ? 'win' : 'loss'}">${summary.netPnl >= 0 ? '+' : ''}$${summary.netPnl.toFixed(2)}</div></div>
      <div class="summary-card"><div class="summary-label">Total Staked</div><div class="summary-value neutral">$${summary.totalStaked.toFixed(2)}</div></div>
    </div>

    <section class="breakdown">
      <h2>Cumulative P/L (chronological)</h2>
      <div class="sparkline-wrap">${renderSparkline(trades)}</div>
    </section>

    <section class="breakdown">
      <h2>By Bot</h2>
      ${renderTable(groupBy(trades, 'bot'))}
    </section>

    <section class="breakdown">
      <h2>By Market</h2>
      ${renderTable(groupBy(trades, 'market'))}
    </section>

    <section class="breakdown">
      <h2>By Direction</h2>
      ${renderTable(groupBy(trades, 'direction'))}
    </section>

    <section class="breakdown">
      <h2>By Strategy Label</h2>
      ${renderTable(groupBy(trades, 'strategyLabel'))}
    </section>
  `;
}

function summarize(trades) {
  const wins = trades.filter((t) => t.win).length;
  const losses = trades.length - wins;
  const netPnl = trades.reduce((sum, t) => sum + t.profit, 0);
  const totalStaked = trades.reduce((sum, t) => sum + t.stake, 0);
  return {
    total: trades.length,
    wins,
    losses,
    winRate: trades.length ? ((wins / trades.length) * 100).toFixed(1) : '0.0',
    netPnl,
    totalStaked
  };
}

function groupBy(trades, key) {
  const groups = {};
  trades.forEach((t) => {
    const k = t[key] || '(none)';
    if (!groups[k]) groups[k] = [];
    groups[k].push(t);
  });
  return Object.entries(groups)
    .map(([label, group]) => ({ label, ...summarize(group) }))
    .sort((a, b) => b.total - a.total);
}

function renderTable(rows) {
  return `
    <table>
      <thead>
        <tr><th>${''}</th><th class="num">Trades</th><th class="num">Wins</th><th class="num">Losses</th><th class="num">Win Rate</th><th class="num">Net P/L</th></tr>
      </thead>
      <tbody>
        ${rows.map((r) => `
          <tr>
            <td>${escapeHtml(r.label)}</td>
            <td class="num">${r.total}</td>
            <td class="num">${r.wins}</td>
            <td class="num">${r.losses}</td>
            <td class="num">${r.winRate}%</td>
            <td class="num ${r.netPnl >= 0 ? 'pos' : 'neg'}">${r.netPnl >= 0 ? '+' : ''}$${r.netPnl.toFixed(2)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderSparkline(trades) {
  const sorted = [...trades].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  let cumulative = 0;
  const points = sorted.map((t) => { cumulative += t.profit; return cumulative; });

  if (points.length < 2) {
    return `<div style="color:var(--text-dim); font-size:12px;">Need at least 2 trades to draw a trend line.</div>`;
  }

  const width = 600, height = 120, pad = 8;
  const min = Math.min(0, ...points);
  const max = Math.max(0, ...points);
  const range = (max - min) || 1;

  const toX = (i) => pad + (i / (points.length - 1)) * (width - pad * 2);
  const toY = (v) => height - pad - ((v - min) / range) * (height - pad * 2);
  const zeroY = toY(0);

  const pathD = points.map((v, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(v).toFixed(1)}`).join(' ');
  const finalPositive = points[points.length - 1] >= 0;

  return `
    <svg viewBox="0 0 ${width} ${height}" style="width:100%; height:auto; display:block;">
      <line x1="${pad}" y1="${zeroY.toFixed(1)}" x2="${width - pad}" y2="${zeroY.toFixed(1)}" stroke="#1c2740" stroke-width="1" stroke-dasharray="4 4" />
      <path d="${pathD}" fill="none" stroke="${finalPositive ? '#39ff14' : '#ff2d55'}" stroke-width="2" />
    </svg>
    <div style="font-family:'JetBrains Mono',monospace; font-size:11px; color:var(--text-dim); margin-top:4px;">
      ${sorted.length} trades · start ${new Date(sorted[0].timestamp).toLocaleDateString()} → latest ${new Date(sorted[sorted.length - 1].timestamp).toLocaleDateString()}
    </div>
  `;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

[els.botFilter, els.marketFilter, els.directionFilter].forEach((select) => {
  select.addEventListener('change', render);
});

els.exportBtn.addEventListener('click', () => {
  const csv = exportCsv();
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pipstrades-trade-log-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

els.clearBtn.addEventListener('click', () => {
  const confirmed = window.confirm(
    'Permanently delete the entire trade log?\n\n' +
    'This removes every logged trade from this browser and cannot be undone. ' +
    'Export a CSV backup first if you want to keep the data.'
  );
  if (!confirmed) return;
  clearLog();
  init();
});

init();
