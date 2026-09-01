# MyGame Steam Backend

## Required environment

Copy `.env.example` to `.env` and set:

- `BASE_URL`: public HTTPS URL of this backend (required by Steam OpenID).
- `STEAM_API_KEY`: Steam Web API key. Keep it on the server only.

## Run

```bash
npm install
npm start
```

The Flutter app opens `/auth/steam/start?returnScheme=mygame`. Steam authenticates in the browser, this server verifies OpenID with Steam, extracts the 64-bit SteamID, then redirects to `mygame://steam/callback?steamId=...`.

For local development, Steam OpenID callback must still be reachable at the public `BASE_URL`; use a secure public HTTPS tunnel if necessary.
