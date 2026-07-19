/**
 * REST helpers for Deriv's 2026 Options API two-step connection flow:
 *   1. List the user's trading accounts (need the account_id to proceed).
 *   2. Request a one-time password (OTP) for a chosen account — the response
 *      contains a ready-to-use WebSocket URL with the OTP embedded.
 *
 * Both calls require the Deriv-App-ID header and a Bearer access token
 * (the one obtained from the OAuth flow in tokenManager.js).
 */

const APP_ID = '33Nc8mMej8uIxL3tnQbQW';
const API_BASE = 'https://api.derivws.com/trading/v1/options';

/**
 * Fetches the list of trading accounts belonging to the authenticated user.
 * @param {string} accessToken
 * @returns {Promise<Array<{account_id: string, account_type: 'demo'|'real', balance: number, currency: string, status: string}>>}
 */
export async function fetchAccounts(accessToken) {
  const response = await fetch(`${API_BASE}/accounts`, {
    method: 'GET',
    headers: {
      'Deriv-App-ID': APP_ID,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Failed to fetch accounts: ${detail}`);
  }

  const { data } = await response.json();
  return data;
}

/**
 * Requests a one-time WebSocket URL for a specific account.
 * The OTP is short-lived — call this immediately before connecting.
 * @param {string} accountId
 * @param {string} accessToken
 * @returns {Promise<string>} the full wss:// URL, ready to connect to
 */
export async function requestWebSocketUrl(accountId, accessToken) {
  const response = await fetch(`${API_BASE}/accounts/${accountId}/otp`, {
    method: 'POST',
    headers: {
      'Deriv-App-ID': APP_ID,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Failed to get connection URL: ${detail}`);
  }

  const { data } = await response.json();
  return data.url;
}

export { APP_ID };
