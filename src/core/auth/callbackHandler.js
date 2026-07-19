import { STORAGE_KEYS } from './oauthClient.js';
import { saveToken } from './tokenManager.js';

/**
 * URL of your own backend endpoint that performs the code -> token exchange.
 * This must NEVER be done directly from the browser (client_secret-equivalent
 * trust boundary), so we hand off the code + verifier to our own server.
 */
const BACKEND_TOKEN_ENDPOINT = 'https://pipstrades-app.vercel.app/api/auth/token';

/**
 * Call this once, on the page your redirect_uri points to.
 * Reads ?code and ?state from the URL, validates state, and exchanges
 * the code for an access token via the backend.
 *
 * @returns {Promise<{accessToken: string, expiresIn: number}>}
 */
export async function handleOAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const returnedState = params.get('state');
  const error = params.get('error');

  if (error) {
    throw new Error(`Deriv OAuth error: ${error}`);
  }

  const expectedState = sessionStorage.getItem(STORAGE_KEYS.state);
  const codeVerifier = sessionStorage.getItem(STORAGE_KEYS.verifier);

  if (!code || !returnedState || !expectedState || !codeVerifier) {
    throw new Error('Missing OAuth parameters. Did the login flow start correctly?');
  }

  if (returnedState !== expectedState) {
    // Possible CSRF attempt — abort immediately.
    throw new Error('OAuth state mismatch. Aborting authentication.');
  }

  // Clean up one-time-use values immediately.
  sessionStorage.removeItem(STORAGE_KEYS.state);
  sessionStorage.removeItem(STORAGE_KEYS.verifier);

  const response = await fetch(BACKEND_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, codeVerifier }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Token exchange failed: ${detail}`);
  }

  const data = await response.json();
  saveToken(data.accessToken, data.expiresIn);

  return { accessToken: data.accessToken, expiresIn: data.expiresIn };
}
