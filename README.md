# pipstrades — Clean Restart

This is a stripped-down, clean version of the platform — same working
OAuth code, no unused Express backend, no leftover domain confusion.

## What's in here
- `index.html` — login page ("Connect with Deriv")
- `callback.html` — OAuth callback handler page
- `src/core/auth/` — PKCE, OAuth client, token manager, callback logic
- `api/auth/token.js` — Vercel serverless function (token exchange)
- `vercel.json` — routes `/callback` to `callback.html`

## Before deploying, update these placeholders:
1. `src/core/auth/oauthClient.js` — set `clientId` and `redirectUri`
2. `src/core/auth/callbackHandler.js` — set `BACKEND_TOKEN_ENDPOINT`

Both should point to whatever your new Vercel URL turns out to be —
you won't know this until after the first deploy, so the first deploy
uses placeholder values, then you update and redeploy once.
