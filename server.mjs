import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
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
const fastify = Fastify({
  logger: false,
  serverFactory: handler => createServer()
    .on('request', (req, res) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      // Allow nomad.io (or any page) to embed Nomad in an iframe.
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Content-Security-Policy', 'frame-ancestors *');
      res.removeHeader('X-Frame-Options');
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

fastify.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').sendFile('index.html'));
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
