import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';

const app = express();
const port = Number(process.env.PORT || 3000);
const apiKey = (process.env.STEAM_API_KEY || '').trim();
const configuredBaseUrl = (process.env.BASE_URL || '').trim().replace(/\/$/, '');

app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(cors());
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));

// IMPORTANT: do not terminate the Railway process when an environment variable is missing.
// This keeps /health reachable and makes deployment/configuration errors visible.
const pending = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of pending) if (value.expires < now) pending.delete(key);
}, 60_000).unref();

function requestBaseUrl(req) {
  if (configuredBaseUrl) return configuredBaseUrl;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
  if (!host) throw new Error('Unable to determine public backend URL');
  return `${proto}://${host}`.replace(/\/$/, '');
}

function requireSteamKey(res) {
  if (apiKey) return true;
  res.status(503).json({ error: 'Steam backend is not configured', detail: 'Missing STEAM_API_KEY environment variable' });
  return false;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

app.get('/', (_, res) => {
  res
    .status(200)
    .type('html')
    .send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MyGame Steam Backend</title>
</head>
<body>
  <h1>MyGame Steam Backend</h1>
  <p>Backend is running successfully.</p>
  <p><a href="/health">Health Check</a></p>
</body>
</html>`);
});
app.get('/health', (_, res) => res.status(200).json({ ok: true, service: 'mygame-steam-backend', steamConfigured: Boolean(apiKey), baseUrlConfigured: Boolean(configuredBaseUrl) }));

app.get('/auth/steam/start', (req, res) => {
  try {
    const scheme = String(req.query.returnScheme || 'mygame');
    if (!/^[a-z][a-z0-9+.-]*$/i.test(scheme)) return res.status(400).send('Invalid return scheme');
    const baseUrl = requestBaseUrl(req);
    const state = crypto.randomUUID();
    pending.set(state, { scheme, expires: Date.now() + 10 * 60_000 });
    const returnTo = `${baseUrl}/auth/steam/callback?state=${encodeURIComponent(state)}`;
    const q = new URLSearchParams({
      'openid.ns': 'http://specs.openid.net/auth/2.0',
      'openid.mode': 'checkid_setup',
      'openid.return_to': returnTo,
      'openid.realm': baseUrl,
      'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
      'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select'
    });
    return res.redirect(`https://steamcommunity.com/openid/?${q}`);
  } catch (e) {
    return res.status(500).send(`Steam login setup failed: ${e.message || 'unknown error'}`);
  }
});

app.get('/auth/steam/callback', async (req, res) => {
  const state = String(req.query.state || '');
  const item = pending.get(state);
  pending.delete(state);
  if (!item || item.expires < Date.now()) return res.status(400).send('Steam login expired');
  try {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query)) if (k.startsWith('openid.')) params.set(k, String(v));
    params.set('openid.mode', 'check_authentication');
    const vr = await fetchWithTimeout('https://steamcommunity.com/openid/login', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params
    }, 20_000);
    const text = await vr.text();
    if (!text.includes('is_valid:true')) throw new Error('OpenID verification failed');
    const claimed = String(req.query['openid.claimed_id'] || '');
    const m = claimed.match(/\/id\/(\d{17})$/);
    if (!m) throw new Error('SteamID missing');
    return res.redirect(`${item.scheme}://steam/callback?steamId=${encodeURIComponent(m[1])}`);
  } catch (e) {
    return res.redirect(`${item.scheme}://steam/callback?error=${encodeURIComponent(e.message || 'login_failed')}`);
  }
});

async function fetchAchievements(steamId, appid) {
  try {
    const u = new URL('https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v0001/');
    u.searchParams.set('key', apiKey); u.searchParams.set('steamid', steamId); u.searchParams.set('appid', String(appid));
    const r = await fetchWithTimeout(u, {}, 10_000);
    if (!r.ok) return { achievement_unlocked: 0, achievement_total: 0 };
    const data = await r.json();
    const achievements = data.playerstats?.achievements;
    if (!Array.isArray(achievements)) return { achievement_unlocked: 0, achievement_total: 0 };
    return { achievement_unlocked: achievements.filter(a => Number(a.achieved) === 1).length, achievement_total: achievements.length };
  } catch (_) { return { achievement_unlocked: 0, achievement_total: 0 }; }
}

async function mapWithConcurrency(items, limit, mapper) {
  const out = new Array(items.length); let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) { const i = next++; if (i >= items.length) break; out[i] = await mapper(items[i]); }
  });
  await Promise.all(workers); return out;
}

app.get('/steam-games', async (req, res) => {
  const steamId = String(req.query.steamId || '').trim();
  if (!/^7656119\d{10}$/.test(steamId)) return res.status(400).json({ error: 'Invalid Steam ID' });
  if (!requireSteamKey(res)) return;
  try {
    const ownedUrl = new URL('https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/');
    ownedUrl.searchParams.set('key', apiKey); ownedUrl.searchParams.set('steamid', steamId); ownedUrl.searchParams.set('include_appinfo', 'true'); ownedUrl.searchParams.set('include_played_free_games', 'true');
    const recentUrl = new URL('https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v0001/');
    recentUrl.searchParams.set('key', apiKey); recentUrl.searchParams.set('steamid', steamId);
    const [ownedResp, recentResp] = await Promise.all([fetchWithTimeout(ownedUrl, {}, 25_000), fetchWithTimeout(recentUrl, {}, 25_000)]);
    if (!ownedResp.ok) throw new Error(`Steam HTTP ${ownedResp.status}`);
    const ownedData = await ownedResp.json();
    const recentData = recentResp.ok ? await recentResp.json() : {};
    const recentMap = new Map((recentData.response?.games || []).map(g => [g.appid, g.playtime_2weeks || 0]));
    const baseGames = (ownedData.response?.games || []).map(g => ({ appid: g.appid, name: g.name, playtime_forever: g.playtime_forever || 0, playtime_2weeks: recentMap.get(g.appid) || 0 }));
    // Achievements are intentionally concurrent but bounded so Railway does not stall on large libraries.
    const games = await mapWithConcurrency(baseGames, 4, async g => ({ ...g, ...await fetchAchievements(steamId, g.appid) }));
    games.sort((a, b) => b.playtime_forever - a.playtime_forever);
    return res.json({ games, count: games.length, achievementsSynced: true });
  } catch (e) {
    return res.status(502).json({ error: 'Unable to fetch Steam library', detail: e.message || 'Unknown error' });
  }
});

app.listen(port, '0.0.0.0', () => console.log(`MyGame Steam backend listening on :${port}`));
