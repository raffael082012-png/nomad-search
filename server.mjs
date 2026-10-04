import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const html = await readFile(path.join(here, 'index.html'));

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
    return host.includes('wiki') || ['fandom.com', 'wikia.com', 'miraheze.org'].some(domain => host === domain || host.endsWith(`.${domain}`));
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/api/search') {
    const query = (url.searchParams.get('q') || '').trim();
    if (!query) return sendJson(res, 400, { error: 'Enter a search query.' });
    if (query.length > 500) return sendJson(res, 400, { error: 'Query is too long.' });
    const providers = [
      {
        name: 'Bing',
        url: `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`,
        accept: 'application/rss+xml, application/xml, text/xml',
        parse: extractBingResults
      },
      {
        name: 'DuckDuckGo',
        url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
        accept: 'text/html',
        parse: extractResults
      }
    ];
    const errors = [];
    for (const provider of providers) {
      try {
        const upstream = await fetch(provider.url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; NomadSearch/1.0)',
            'Accept': provider.accept,
            'Accept-Language': 'en-US,en;q=0.8'
          },
          signal: AbortSignal.timeout(6000)
        });
        if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
        const results = provider.parse(await upstream.text()).filter(result => !isWikiResult(result));
        if (!results.length) throw new Error('provider returned no parseable results');
        return sendJson(res, 200, { query, results, provider: provider.name });
      } catch (error) {
        const cause = error.cause?.code || error.cause?.message;
        const detail = cause ? `${error.message} (${cause})` : error.message;
        console.error(`[search] ${provider.name}: ${detail}`);
        errors.push(`${provider.name}: ${detail}`);
      }
    }
    return sendJson(res, 502, { error: 'Search providers could not be reached. Try again in a moment.' });
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(html);
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

server.listen(port, '0.0.0.0', () => console.log(`Nomad is listening on port ${port}`));
