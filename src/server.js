import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';

const app = express();
const port = Number(process.env.PORT || 3000);
const apiKey = process.env.STEAM_API_KEY;
const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');
if (!apiKey || !baseUrl) { console.error('Missing STEAM_API_KEY or BASE_URL in .env'); process.exit(1); }

app.set('trust proxy', 1);
app.use(express.json());
app.use(cors());
app.use(rateLimit({windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false}));
const pending = new Map();

app.get('/health', (_, res) => res.json({ok:true, service:'mygame-steam-backend'}));

app.get('/auth/steam/start', (req,res) => {
  const scheme = String(req.query.returnScheme || 'mygame');
  if (!/^[a-z][a-z0-9+.-]*$/i.test(scheme)) return res.status(400).send('Invalid return scheme');
  const state = crypto.randomUUID();
  pending.set(state,{scheme,expires:Date.now()+10*60_000});
  const returnTo = `${baseUrl}/auth/steam/callback?state=${encodeURIComponent(state)}`;
  const q = new URLSearchParams({
    'openid.ns':'http://specs.openid.net/auth/2.0','openid.mode':'checkid_setup',
    'openid.return_to':returnTo,'openid.realm':baseUrl,
    'openid.identity':'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id':'http://specs.openid.net/auth/2.0/identifier_select'
  });
  res.redirect(`https://steamcommunity.com/openid/login?${q}`);
});

app.get('/auth/steam/callback', async (req,res) => {
  const state=String(req.query.state||''); const item=pending.get(state); pending.delete(state);
  if(!item || item.expires<Date.now()) return res.status(400).send('Steam login expired');
  try {
    const params=new URLSearchParams();
    for(const [k,v] of Object.entries(req.query)) if(k.startsWith('openid.')) params.set(k,String(v));
    params.set('openid.mode','check_authentication');
    const vr=await fetch('https://steamcommunity.com/openid/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:params});
    const text=await vr.text();
    if(!text.includes('is_valid:true')) throw new Error('OpenID verification failed');
    const claimed=String(req.query['openid.claimed_id']||'');
    const m=claimed.match(/\/id\/(\d{17})$/); if(!m) throw new Error('SteamID missing');
    const target=`${item.scheme}://steam/callback?steamId=${encodeURIComponent(m[1])}`;
    res.redirect(target);
  } catch(e) { res.redirect(`${item.scheme}://steam/callback?error=${encodeURIComponent(e.message||'login_failed')}`); }
});

app.get('/steam-games', async (req,res) => {
  const steamId=String(req.query.steamId||'').trim();
  if(!/^7656119\d{10}$/.test(steamId)) return res.status(400).json({error:'Invalid Steam ID'});
  try {
    const u=new URL('https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/');
    u.searchParams.set('key',apiKey);u.searchParams.set('steamid',steamId);u.searchParams.set('include_appinfo','true');u.searchParams.set('include_played_free_games','true');
    const r=await fetch(u);if(!r.ok) throw new Error(`Steam HTTP ${r.status}`);const data=await r.json();
    const games=(data.response?.games||[]).map(g=>({appid:g.appid,name:g.name,playtime_forever:g.playtime_forever||0})).sort((a,b)=>b.playtime_forever-a.playtime_forever);
    res.json({games,count:games.length});
  } catch(e){res.status(502).json({error:'Unable to fetch Steam library',detail:e.message});}
});

app.listen(port,()=>console.log(`MyGame Steam backend listening on :${port}`));
