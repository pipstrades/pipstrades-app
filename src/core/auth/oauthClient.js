import { generateCodeVerifier, generateCodeChallenge, generateState } from './pkce.js';

/**
 * Configure these for your registered Deriv application.
 * client_id and redirect_uri MUST exactly match what you registered
 * at developers.deriv.com -> Application Manager.
 */
const CONFIG = {
  clientId: '33Nc8mMej8uIxL3tnQbQW',
  redirectUri: 'https://pipstrades-app.vercel.app/callback',
  authEndpoint: 'https://auth.deriv.com/oauth2/auth',
  scope: 'trade account_manage',
};

const STORAGE_KEYS = {
  verifier: 'deriv_pkce_verifier',
  state: 'deriv_oauth_state',
};

/**
 * Starts the OAuth login flow: generates PKCE values, stores them,
 * and redirects the browser to Deriv's authorization page.
 */
export async function startLogin() {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateState();

  // Stored temporarily so the callback step can verify + complete the exchange.
  sessionStorage.setItem(STORAGE_KEYS.verifier, codeVerifier);
  sessionStorage.setItem(STORAGE_KEYS.state, state);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CONFIG.clientId,
    redirect_uri: CONFIG.redirectUri,
    scope: CONFIG.scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  window.location.href = `${CONFIG.authEndpoint}?${params.toString()}`;
}

export { CONFIG as oauthConfig, STORAGE_KEYS };
