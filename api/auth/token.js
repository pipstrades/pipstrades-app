/**
 * Vercel Serverless Function: POST /api/auth/token
 *
 * Same job as backend/auth/tokenExchange.js, adapted to Vercel's
 * (req, res) function signature so it deploys automatically —
 * no separate server/hosting needed.
 *
 * Environment variables required (set in Vercel dashboard -> Settings -> Environment Variables):
 *   DERIV_CLIENT_ID
 *   DERIV_REDIRECT_URI
 */

const CONFIG = {
  clientId: process.env.DERIV_CLIENT_ID,
  redirectUri: process.env.DERIV_REDIRECT_URI,
  tokenEndpoint: 'https://auth.deriv.com/oauth2/token',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { code, codeVerifier } = req.body || {};

  if (!code || !codeVerifier) {
    return res.status(400).json({ error: 'Missing code or codeVerifier' });
  }

  if (!CONFIG.clientId || !CONFIG.redirectUri) {
    console.error('Missing DERIV_CLIENT_ID or DERIV_REDIRECT_URI env vars');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CONFIG.clientId,
      code,
      code_verifier: codeVerifier,
      redirect_uri: CONFIG.redirectUri,
    });

    const derivResponse = await fetch(CONFIG.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!derivResponse.ok) {
      const errorDetail = await derivResponse.text();
      console.error('Deriv token exchange failed:', errorDetail);
      return res.status(502).json({ error: 'Token exchange with Deriv failed' });
    }

    const data = await derivResponse.json();

    return res.status(200).json({
      accessToken: data.access_token,
      expiresIn: data.expires_in,
    });
  } catch (err) {
    console.error('Unexpected error during token exchange:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
