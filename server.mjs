import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { server as wisp, logging } from '@mercuryworkshop/wisp-js/server';
import { scramjetPath } from '@mercuryworkshop/scramjet/path';
import { libcurlPath } from '@mercuryworkshop/libcurl-transport';
import { baremuxPath } from '@mercuryworkshop/bare-mux/node';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);

function decodeEntities(value = '') {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function clean(value = '') {
  return decodeEntities(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function xmlValue(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? clean(match[1].replace(/^<!\[CDATA\[|\]\]>$/g, '')) : '';
}

function extractBingResults(xml) {
  const items = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];
  const results = [];
  for (const item of items) {
    const title = xmlValue(item, 'title');
    const url = decodeEntities(xmlValue(item, 'link'));
    const snippet = xmlValue(item, 'description');
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) continue;
      results.push({ title, url: parsed.href, snippet });
    } catch { /* ignore malformed provider entries */ }
  }
  return results;
}

function isWikiResult(result) {
  try {
    const host = new URL(result.url).hostname.toLowerCase();
    const wikiDomains = [
      'wikipedia.org', 'wikimedia.org', 'wiktionary.org', 'wikibooks.org',
      'wikiquote.org', 'wikisource.org', 'wikinews.org', 'wikiversity.org',
      'wikivoyage.org', 'fandom.com', 'wikia.com', 'miraheze.org', 'wiki.gg'
    ];
    return wikiDomains.some(domain => host === domain || host.endsWith(`.${domain}`));
  } catch { return false; }
}

function extractResults(markup) {
  const results = [];
  const blocks = markup.match(/<div class="result[^>]*>[\s\S]*?(?=<div class="result[^>]*>|$)/gi) || [];
  for (const block of blocks) {
    const link = block.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const snippet = block.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/i);
    let url = decodeEntities(link[1]);
    try {
      const parsed = new URL(url);
      const redirected = parsed.searchParams.get('uddg');
      if (redirected) url = redirected;
      new URL(url);
    } catch { continue; }
    results.push({ title: clean(link[2]), url, snippet: clean(snippet?.[1] || snippet?.[2] || '') });
  }
  return results;
}

logging.set_level(logging.NONE);
Object.assign(wisp.options, {
  allow_udp_streams: false,
  hostname_blacklist: [
    /^(?:localhost|.*\.localhost|.*\.local|.*\.internal)$/i,
    /^(?:127\.|10\.|192\.168\.|169\.254\.)/,
    /^172\.(?:1[6-9]|2\d|3[01])\./
  ],
  dns_servers: ['1.1.1.1', '1.0.0.1']
});

const allowedOrigins = new Set([
  process.env.PUBLIC_ORIGIN,
  'https://nomad-en95.onrender.com',
  'http://localhost:3000'
].filter(Boolean));
const desktopPaths = new Set(['/', '/desktop', '/nomad_io-games.html', '/search-embed']);
const fastify = Fastify({
  logger: false,
  serverFactory: handler => createServer()
    .on('request', (req, res) => {
      // The desktop page embeds SoundCloud and outside images, so it is not cross-origin isolated.
      const pathname = (req.url || '/').split('?')[0];
      if (!desktopPaths.has(pathname)) {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      }
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      handler(req, res);
    })
    .on('upgrade', (req, socket, head) => {
      if (req.url !== '/wisp/' || !allowedOrigins.has(req.headers.origin)) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      wisp.routeRequest(req, socket, head);
    })
});

const sendDesktop = async (_request, reply) => reply.type('text/html; charset=utf-8').sendFile('nomad_io-games.html');
fastify.get('/', sendDesktop);
fastify.get('/desktop', sendDesktop);
fastify.get('/search', async (_request, reply) => reply.type('text/html; charset=utf-8').sendFile('index.html'));
// Same page, served without COEP so the desktop (which is not isolated) can embed it in an iframe.
fastify.get('/search-embed', async (_request, reply) => reply.type('text/html; charset=utf-8').sendFile('index.html'));

// Live wallpaper videos: fetched by the server (no browser Referer) so motionbgs.com can't block them. Only motionbgs .mp4 links are allowed.
fastify.get('/wp-video', async (request, reply) => {
  let url;
  try { url = new URL(String(request.query.u || '')); } catch { return reply.code(400).send('Bad link'); }
  if (url.protocol !== 'https:' || !/^(www\.)?motionbgs\.com$/i.test(url.hostname) || !/\.mp4$/i.test(url.pathname)) {
    return reply.code(403).send('Not allowed');
  }
  const headers = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' };
  if (request.headers.range) headers.range = request.headers.range;
  try {
    const upstream = await fetch(url, { headers, redirect: 'follow' });
    if (!upstream.ok && upstream.status !== 206) return reply.code(502).send('Video unavailable');
    reply.code(upstream.status).header('content-type', upstream.headers.get('content-type') || 'video/mp4').header('cache-control', 'public, max-age=86400').header('accept-ranges', 'bytes');
    for (const h of ['content-length', 'content-range']) {
      const v = upstream.headers.get(h);
      if (v) reply.header(h, v);
    }
    return reply.send(Readable.fromWeb(upstream.body));
  } catch {
    return reply.code(502).send('Video unavailable');
  }
});
fastify.get('/api/search', async (request, reply) => {
  const query = String(request.query.q || '').trim();
  if (!query) return reply.code(400).send({ error: 'Enter a search query.' });
  if (query.length > 500) return reply.code(400).send({ error: 'Query is too long.' });
  const searchQuery = `${query} -site:wikipedia.org -site:wikimedia.org -site:wiktionary.org -site:fandom.com -site:wikia.com`;
  const providers = [
    {
      name: 'Bing',
      url: `https://www.bing.com/search?format=rss&q=${encodeURIComponent(searchQuery)}`,
      accept: 'application/rss+xml, application/xml, text/xml',
      parse: extractBingResults
    },
    {
      name: 'DuckDuckGo',
      url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`,
      accept: 'text/html',
      parse: extractResults
    }
  ];
  for (const provider of providers) {
    try {
      const upstream = await fetch(provider.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; NomadSearch/1.0)',
          Accept: provider.accept,
          'Accept-Language': 'en-US,en;q=0.8'
        },
        signal: AbortSignal.timeout(6000)
      });
      if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
      const results = provider.parse(await upstream.text()).filter(result => !isWikiResult(result));
      if (!results.length) throw new Error('provider returned no parseable results');
      return reply.header('cache-control', 'no-store').send({ query, results, provider: provider.name });
    } catch (error) {
      const cause = error.cause?.code || error.cause?.message;
      console.error(`[search] ${provider.name}: ${cause ? `${error.message} (${cause})` : error.message}`);
    }
  }
  return reply.code(502).send({ error: 'Search providers could not be reached. Try again in a moment.' });
});


// ---------- Nomad accounts (username + password) ----------
// Stored OUTSIDE the public folder. On free Render the disk resets on redeploy/restart, so accounts can be lost; set DATA_DIR to a persistent disk to keep them.
const dataDir = process.env.DATA_DIR || path.join(os.tmpdir(), 'nomad-data');
fs.mkdirSync(dataDir, { recursive: true });
const usersFile = path.join(dataDir, 'users.json');
let users = {};
try { users = JSON.parse(fs.readFileSync(usersFile, 'utf8')); } catch { /* first run */ }
const saveUsers = () => { const tmp = usersFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(users)); fs.renameSync(tmp, usersFile); };
const hashPassword = (password, salt) => new Promise((resolve, reject) => scryptCb(password, salt, 64, (err, key) => err ? reject(err) : resolve(key)));
const sessions = new Map();
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
function cookieValue(header = '', name) {
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}
function currentUser(request) {
  const sid = cookieValue(request.headers.cookie, 'nomad_sid');
  const session = sid && sessions.get(sid);
  if (!session || session.exp < Date.now()) { if (sid) sessions.delete(sid); return null; }
  return session.username;
}
function startSession(request, reply, username) {
  const sid = randomBytes(32).toString('hex');
  sessions.set(sid, { username, exp: Date.now() + SESSION_MS });
  const secure = request.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  reply.header('set-cookie', `nomad_sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure}`);
}
const attempts = new Map();
function tooMany(request) {
  const ip = String(request.headers['x-forwarded-for'] || request.ip).split(',')[0].trim();
  const now = Date.now();
  const recent = (attempts.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  recent.push(now);
  attempts.set(ip, recent);
  return recent.length > 20;
}
function readCredentials(request) {
  const body = request.body && typeof request.body === 'object' ? request.body : {};
  return { username: String(body.username || '').trim().toLowerCase(), password: String(body.password || '') };
}
fastify.post('/api/register', async (request, reply) => {
  if (tooMany(request)) return reply.code(429).send({ error: 'Too many tries. Wait a few minutes.' });
  const { username, password } = readCredentials(request);
  if (!/^[a-z0-9_]{3,20}$/.test(username)) return reply.code(400).send({ error: 'Username: 3-20 letters, numbers or _' });
  if (password.length < 6 || password.length > 100) return reply.code(400).send({ error: 'Password must be 6-100 characters.' });
  if (Object.keys(users).length >= 1000) return reply.code(503).send({ error: 'Sign-ups are full.' });
  if (Object.prototype.hasOwnProperty.call(users, username)) return reply.code(409).send({ error: 'That username is taken.' });
  const salt = randomBytes(16);
  users[username] = { salt: salt.toString('hex'), hash: (await hashPassword(password, salt)).toString('hex'), created: Date.now() };
  saveUsers();
  startSession(request, reply, username);
  return reply.header('cache-control', 'no-store').send({ username });
});
fastify.post('/api/login', async (request, reply) => {
  if (tooMany(request)) return reply.code(429).send({ error: 'Too many tries. Wait a few minutes.' });
  const { username, password } = readCredentials(request);
  const user = Object.prototype.hasOwnProperty.call(users, username) ? users[username] : null;
  const salt = user ? Buffer.from(user.salt, 'hex') : randomBytes(16);
  const attempt = await hashPassword(password, salt);
  const ok = user && timingSafeEqual(attempt, Buffer.from(user.hash, 'hex'));
  if (!ok) return reply.code(401).send({ error: 'Wrong username or password.' });
  startSession(request, reply, username);
  return reply.header('cache-control', 'no-store').send({ username });
});
fastify.post('/api/logout', async (request, reply) => {
  const sid = cookieValue(request.headers.cookie, 'nomad_sid');
  if (sid) sessions.delete(sid);
  reply.header('set-cookie', 'nomad_sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  return reply.send({ ok: true });
});
fastify.get('/api/me', async (request, reply) => {
  const username = currentUser(request);
  if (!username) return reply.code(401).header('cache-control', 'no-store').send({ error: 'Not logged in.' });
  return reply.header('cache-control', 'no-store').send({ username });
});
// Keep server code and config files from being downloaded through the static file handler.
fastify.addHook('onRequest', (request, reply, done) => {
  const pathname = decodeURIComponent((request.raw.url || '/').split('?')[0]);
  if (/^\/(server\.mjs|package(-lock)?\.json|node_modules|\.)/i.test(pathname)) { reply.code(404).send('Not found'); return; }
  done();
});

fastify.register(fastifyStatic, { root: here, decorateReply: true });
fastify.register(fastifyStatic, { root: scramjetPath, prefix: '/scram/', decorateReply: false });
fastify.register(fastifyStatic, { root: libcurlPath, prefix: '/libcurl/', decorateReply: false });
fastify.register(fastifyStatic, { root: baremuxPath, prefix: '/baremux/', decorateReply: false });

fastify.listen({ port, host: '0.0.0.0' }).then(() => {
  console.log(`Nomad is listening on port ${port}`);
}).catch(error => {
  console.error(error);
  process.exit(1);
});
