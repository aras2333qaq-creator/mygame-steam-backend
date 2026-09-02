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
    return res.redirect(302, `https://steamcommunity.com/openid/login?${q.toString()}`);
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

async function fetchJson(url, timeoutMs = 12_000) {
  const r = await fetchWithTimeout(url, {}, timeoutMs);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

// Steam 玩家成就 + 商店公开成就定义。
// 玩家接口负责已解锁状态/时间，商店接口负责中文名称、描述和图标。
// 任一接口不可用时仍尽可能返回已有数据，避免整个游戏库导入失败。
async function fetchAchievements(steamId, appid) {
  const empty = { achievement_unlocked: 0, achievement_total: 0, achievements: [] };
  if (!apiKey) return empty;

  let playerAchievements = [];
  try {
    const u = new URL('https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v0001/');
    u.searchParams.set('key', apiKey);
    u.searchParams.set('steamid', steamId);
    u.searchParams.set('appid', String(appid));
    u.searchParams.set('l', 'schinese');
    const data = await fetchJson(u, 10_000);
    playerAchievements = Array.isArray(data.playerstats?.achievements)
      ? data.playerstats.achievements : [];
  } catch (_) {
    // 私有资料、无成就或 Steam 临时失败都不阻断游戏库导入。
    return empty;
  }

  const unlocked = playerAchievements.filter(a => Number(a.achieved) === 1).length;
  const byApiName = new Map();
  for (const a of playerAchievements) byApiName.set(String(a.apiname || a.name || ''), a);

  let definitions = [];
  try {
    // Store API 不需要 Steam Web API Key，可提供图标/名称/描述。
    const storeUrl = new URL('https://store.steampowered.com/api/appdetails');
    storeUrl.searchParams.set('appids', String(appid));
    storeUrl.searchParams.set('l', 'schinese');
    const storeData = await fetchJson(storeUrl, 10_000);
    const appData = storeData?.[String(appid)]?.data;
    definitions = Array.isArray(appData?.achievements?.highlighted)
      ? appData.achievements.highlighted : [];

    // highlighted 只返回部分成就，因此优先再请求完整 Schema。
    if (definitions.length < playerAchievements.length) {
      const schemaUrl = new URL('https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/');
      schemaUrl.searchParams.set('key', apiKey);
      schemaUrl.searchParams.set('appid', String(appid));
      schemaUrl.searchParams.set('l', 'schinese');
      const schema = await fetchJson(schemaUrl, 10_000);
      const schemaAchievements = schema.game?.availableGameStats?.achievements;
      if (Array.isArray(schemaAchievements) && schemaAchievements.length) definitions = schemaAchievements;
    }
  } catch (_) {
    // 后续会退回 API 名称，确保状态至少可以导入。
  }

  const meta = new Map();
  for (const d of definitions) {
    const key = String(d.name || d.apiname || '');
    if (key) meta.set(key, d);
  }

  const achievements = playerAchievements.map((a, index) => {
    const key = String(a.apiname || a.name || '');
    const d = meta.get(key) || {};
    const achieved = Number(a.achieved) === 1;
    const unlockUnix = Number(a.unlocktime || 0);
    return {
      id: key || `achievement_${index}`,
      name: String(d.displayName || d.name || a.name || a.apiname || '未知成就'),
      description: String(d.description || ''),
      icon: String(d.icon || d.iconClosed || ''),
      unlocked: achieved,
      achieved: achieved ? 1 : 0,
      unlockTime: unlockUnix > 0 ? new Date(unlockUnix * 1000).toISOString() : null
    };
  });

  return {
    achievement_unlocked: unlocked,
    achievement_total: playerAchievements.length,
    achievements
  };
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
    // Steam 官方最后运行时间优先级：GetOwnedGames -> GetRecentlyPlayedGames -> null。
    // 绝不使用 App 导入时间或 createdAt 伪造最后运行时间。
    const recentMap = new Map((recentData.response?.games || []).map(g => [g.appid, {
      playtime_2weeks: Number(g.playtime_2weeks || 0),
      rtime_last_played: Number(g.rtime_last_played || 0) || null,
    }]));
    const baseGames = (ownedData.response?.games || []).map(g => {
      const recent = recentMap.get(g.appid) || {};
      const ownedLastPlayed = Number(g.rtime_last_played || 0);
      const recentLastPlayed = Number(recent.rtime_last_played || 0);
      const rtime_last_played = ownedLastPlayed > 0
        ? ownedLastPlayed
        : (recentLastPlayed > 0 ? recentLastPlayed : null);
      return {
        appid: g.appid,
        name: g.name,
        playtime_forever: Number(g.playtime_forever || 0),
        playtime_2weeks: Number(recent.playtime_2weeks || 0),
        rtime_last_played,
        last_played_source: ownedLastPlayed > 0 ? 'owned' : (recentLastPlayed > 0 ? 'recent' : 'steam_unavailable'),
      };
    });
    // Achievements are intentionally concurrent but bounded so Railway does not stall on large libraries.
    const games = await mapWithConcurrency(baseGames, 6, async g => ({ ...g, ...await fetchAchievements(steamId, g.appid) }));
    games.sort((a, b) => b.playtime_forever - a.playtime_forever);
    return res.json({ games, count: games.length, achievementsSynced: true });
  } catch (e) {
    return res.status(502).json({ error: 'Unable to fetch Steam library', detail: e.message || 'Unknown error' });
  }
});

app.get('/debug-steam-last-played', async (req, res) => {
  const steamId = String(req.query.steamId || '').trim();
  if (!/^7656119\d{10}$/.test(steamId)) return res.status(400).json({ error: 'Invalid Steam ID' });
  if (!requireSteamKey(res)) return;
  try {
    const ownedUrl = new URL('https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/');
    ownedUrl.searchParams.set('key', apiKey); ownedUrl.searchParams.set('steamid', steamId);
    ownedUrl.searchParams.set('include_appinfo', 'true'); ownedUrl.searchParams.set('include_played_free_games', 'true');
    const recentUrl = new URL('https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v0001/');
    recentUrl.searchParams.set('key', apiKey); recentUrl.searchParams.set('steamid', steamId);
    const [ownedResp, recentResp] = await Promise.all([fetchWithTimeout(ownedUrl, {}, 25000), fetchWithTimeout(recentUrl, {}, 25000)]);
    const ownedData = ownedResp.ok ? await ownedResp.json() : {};
    const recentData = recentResp.ok ? await recentResp.json() : {};
    const ownedGames = ownedData.response?.games || [];
    const recentGames = recentData.response?.games || [];
    const ownedWithLastPlayed = ownedGames.filter(g => Number(g.rtime_last_played || 0) > 0);
    const recentWithLastPlayed = recentGames.filter(g => Number(g.rtime_last_played || 0) > 0);
    const ownedMap = new Map(ownedGames.map(g => [g.appid, g]));
    const recentMap = new Map(recentGames.map(g => [g.appid, g]));
    const summarize = g => ({ appid:g.appid, name:g.name, rtime_last_played:g.rtime_last_played ?? null, keys:Object.keys(g) });
    const crossSamples = recentGames.slice(0, 20).map(r => {
      const o = ownedMap.get(r.appid) || {};
      return { appid:r.appid, name:r.name || o.name, owned_rtime_last_played:o.rtime_last_played ?? null, recent_rtime_last_played:r.rtime_last_played ?? null, owned_keys:Object.keys(o), recent_keys:Object.keys(r) };
    });
    return res.json({
      steamId,
      owned: { httpStatus: ownedResp.status, count: ownedGames.length, withRtimeLastPlayed: ownedWithLastPlayed.length, samplesWithRtimeLastPlayed: ownedWithLastPlayed.slice(0, 20).map(summarize), samplesWithoutRtimeLastPlayed: ownedGames.filter(g => !Number(g.rtime_last_played || 0)).slice(0, 10).map(summarize) },
      recent: { httpStatus: recentResp.status, count: recentGames.length, withRtimeLastPlayed: recentWithLastPlayed.length, samplesWithRtimeLastPlayed: recentWithLastPlayed.slice(0, 20).map(summarize), samplesWithoutRtimeLastPlayed: recentGames.filter(g => !Number(g.rtime_last_played || 0)).slice(0, 10).map(summarize) },
      crossSamples,
      interpretation: (ownedWithLastPlayed.length || recentWithLastPlayed.length) ? 'steam_returned_rtime_last_played' : 'steam_did_not_return_rtime_last_played'
    });
  } catch (e) { return res.status(502).json({ error:'Steam diagnostic failed', detail:e.message || 'Unknown error' }); }
});

app.listen(port, '0.0.0.0', () => console.log(`MyGame Steam backend listening on :${port}`));
