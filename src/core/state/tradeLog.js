// =========================================================================
// SHARED TRADE LOG — persists every settled trade to localStorage so
// strategy performance can be judged over hundreds of trades, across
// page reloads and sessions, instead of only the current in-memory
// session stats (which reset on reload).
//
// Scope note: this is per-browser/per-device storage, not a synced
// backend — it won't follow you to a different phone or browser, but it
// survives reloads and normal browsing on the device it was recorded on.
// =========================================================================

const STORAGE_KEY = 'pipstrades_trade_log_v1';
const MAX_ENTRIES = 5000; // oldest entries drop once this cap is hit

function readLog() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('Trade log read failed:', err);
    return [];
  }
}

function writeLog(entries) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    return true;
  } catch (err) {
    console.error('Trade log write failed:', err);
    return false;
  }
}

/**
 * Append one settled trade to the persistent log.
 * @param {Object} record
 * @param {string} record.bot          e.g. 'overunder-manual', 'overunder-ai'
 * @param {string} record.market       e.g. 'R_75'
 * @param {string} record.direction    'OVER' | 'UNDER'
 * @param {number} record.barrier      barrier digit used
 * @param {number} record.stake
 * @param {number} record.profit       positive on win, negative on loss
 * @param {boolean} record.win
 * @param {string|number} [record.contractId]
 * @param {string} [record.strategyLabel] free-text label for the specific
 *   strategy/mode that placed the trade (e.g. 'AI Auto', 'Manual OVER 2')
 */
export function logTrade(record) {
  const entries = readLog();
  entries.push({
    timestamp: new Date().toISOString(),
    bot: record.bot || 'unknown',
    market: record.market || 'unknown',
    direction: record.direction || 'unknown',
    barrier: record.barrier !== undefined ? record.barrier : null,
    stake: Number(record.stake) || 0,
    profit: Number(record.profit) || 0,
    win: !!record.win,
    contractId: record.contractId || null,
    strategyLabel: record.strategyLabel || ''
  });
  // Cap growth — drop oldest entries first once over the limit.
  const trimmed = entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries;
  writeLog(trimmed);
}

/** Return every logged trade (oldest first). */
export function getAllTrades() {
  return readLog();
}

/** Permanently clear the entire persistent log. */
export function clearLog() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch (err) {
    console.error('Trade log clear failed:', err);
    return false;
  }
}

/** Build a CSV string of the full log, for download/backup. */
export function exportCsv() {
  const entries = readLog();
  const header = ['timestamp', 'bot', 'market', 'direction', 'barrier', 'stake', 'profit', 'win', 'contractId', 'strategyLabel'];
  const rows = entries.map((e) => [
    e.timestamp, e.bot, e.market, e.direction, e.barrier, e.stake, e.profit, e.win, e.contractId, e.strategyLabel
  ].map((v) => {
    const str = v === null || v === undefined ? '' : String(v);
    return str.includes(',') || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
  }).join(','));
  return [header.join(','), ...rows].join('\n');
}
