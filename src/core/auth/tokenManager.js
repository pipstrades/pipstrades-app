/**
 * Manages the Deriv access token in memory + sessionStorage.
 * Note: sessionStorage is used here for simplicity/demo purposes.
 * For production, weigh the XSS exposure of storing tokens in web storage
 * vs. an httpOnly cookie issued by your backend.
 */

const TOKEN_KEY = 'deriv_access_token';
const EXPIRY_KEY = 'deriv_token_expiry';

/**
 * Saves the access token and computes its absolute expiry time.
 * @param {string} accessToken
 * @param {number} expiresInSeconds
 */
export function saveToken(accessToken, expiresInSeconds) {
  const expiryTimestamp = Date.now() + expiresInSeconds * 1000;
  sessionStorage.setItem(TOKEN_KEY, accessToken);
  sessionStorage.setItem(EXPIRY_KEY, String(expiryTimestamp));
}

/**
 * Returns the current access token, or null if missing/expired.
 * @returns {string|null}
 */
export function getToken() {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const expiry = Number(sessionStorage.getItem(EXPIRY_KEY));

  if (!token || !expiry) return null;

  // 30-second safety buffer before actual expiry.
  if (Date.now() > expiry - 30_000) {
    clearToken();
    return null;
  }

  return token;
}

export function isAuthenticated() {
  return getToken() !== null;
}

export function clearToken() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(EXPIRY_KEY);
}
