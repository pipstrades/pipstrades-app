/**
 * Tracks whether the user wants to trade on their Demo or Real account.
 * Stored in sessionStorage so it's remembered across pages in this tab,
 * but resets when the browser session ends (same lifetime as the OAuth
 * token in tokenManager.js).
 */

const STORAGE_KEY = 'deriv_account_type';
const DEFAULT_TYPE = 'demo';

/**
 * @returns {'demo'|'real'}
 */
export function getAccountType() {
  const stored = sessionStorage.getItem(STORAGE_KEY);
  return stored === 'real' ? 'real' : DEFAULT_TYPE;
}

/**
 * @param {'demo'|'real'} type
 */
export function setAccountType(type) {
  sessionStorage.setItem(STORAGE_KEY, type === 'real' ? 'real' : 'demo');
}

export function isRealAccount() {
  return getAccountType() === 'real';
}
