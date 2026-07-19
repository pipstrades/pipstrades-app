/**
 * PKCE (Proof Key for Code Exchange) utilities.
 * Used to secure the OAuth Authorization Code flow against interception attacks.
 */

const CHARSET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

/**
 * Generates a cryptographically random code_verifier.
 * @returns {string}
 */
export function generateCodeVerifier() {
  const array = crypto.getRandomValues(new Uint8Array(64));
  return Array.from(array)
    .map((v) => CHARSET[v % CHARSET.length])
    .join('');
}

/**
 * Derives the code_challenge from a code_verifier using SHA-256 + base64url.
 * @param {string} codeVerifier
 * @returns {Promise<string>}
 */
export async function generateCodeChallenge(codeVerifier) {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(codeVerifier)
  );
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Generates a random state string for CSRF protection.
 * @returns {string}
 */
export function generateState() {
  const array = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(array)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
