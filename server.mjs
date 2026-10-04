import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const html = await readFile(path.join(here, 'index.html'));
const maxPageBytes = 8 * 1024 * 1024;

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

function publicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split('.').map(Number);
    const value = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
    const blocked = [
      [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
      [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
      [0xc0586300, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24],
      [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4]
    ];
    return !blocked.some(([network, bits]) => (value >>> (32 - bits)) === (network >>> (32 - bits)));
  }
  if (family === 6) {
    const host = address.toLowerCase().split('%')[0];
    return host !== '::' && host !== '::1' && !host.startsWith('::ffff:') &&
      !/^f[cd]/.test(host) && !/^fe[89ab]/.test(host) && !host.startsWith('ff') && !host.startsWith('2001:db8:');
  }
  return false;
}

async function resolvePublicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.test')) {
    throw new Error('This address is not publicly reachable.');
  }
  const records = isIP(host) ? [{ address: host, family: isIP(host) }] : await dnsLookup(host, { all: true, verbatim: true });
  if (!records.length || records.some(record => !publicAddress(record.address))) {
    throw new Error('This address is not publicly reachable.');
  }
  return records;
}

function requestPublicPage(url, records) {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = transport({
      protocol: url.protocol,
      hostname: host,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      servername: isIP(host) ? undefined : host,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NomadViewer/1.0)',
        'Accept': 'text/html,application/xhtml+xml,text/css,application/javascript,image/*,font/*,*/*;q=0.8',
        'Accept-Encoding': 'identity'
      },
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, records);
        else callback(null, records[0].address, records[0].family);
      }
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxPageBytes) request.destroy(new Error('Page is larger than Nomad can display.'));
        else chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status: response.statusCode || 502,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    request.setTimeout(9000, () => request.destroy(new Error('Destination took too long to respond.')));
    request.on('error', reject);
    request.end();
  });
}

async function fetchPublicPage(startUrl) {
  let current = new URL(startUrl);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (!['http:', 'https:'].includes(current.protocol)) throw new Error('Only public HTTP and HTTPS pages can be opened.');
    const records = await resolvePublicHost(current.hostname);
    const response = await requestPublicPage(current, records);
    const location = response.headers.location;
    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      current = new URL(location, current);
      continue;
    }
    return { ...response, url: current };
  }
  throw new Error('Too many redirects.');
}

function proxyPath(url) {
  return `/browse?url=${encodeURIComponent(url)}`;
}

function rewriteCss(css, baseUrl) {
  return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (whole, quote, raw) => {
    try {
      const url = new URL(raw.trim(), baseUrl);
      return ['http:', 'https:'].includes(url.protocol) ? `url("${proxyPath(url.href)}")` : whole;
    } catch { return whole; }
  }).replace(/@import\s+(['"])(.*?)\1/gi, (whole, quote, raw) => {
    try {
      const url = new URL(raw, baseUrl);
      return ['http:', 'https:'].includes(url.protocol) ? `@import "${proxyPath(url.href)}"` : whole;
    } catch { return whole; }
  });
}

function rewriteHtml(markup, pageUrl) {
  const declaredBase = markup.match(/<base\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>/i);
  let baseUrl = pageUrl;
  try { if (declaredBase) baseUrl = new URL(declaredBase[2], pageUrl); } catch { /* use page URL */ }
  let rewritten = markup.replace(/<base\b[^>]*>/gi, '');
  rewritten = rewritten.replace(/\s(href|src|action|poster|data-src|data-href)\s*=\s*(["'])(.*?)\2/gi, (whole, name, quote, raw) => {
    const value = raw.trim();
    if (!value || value.startsWith('#') || /^(?:data:|blob:|javascript:|mailto:|tel:|about:)/i.test(value)) return whole;
    try {
      const url = new URL(value, baseUrl);
      if (!['http:', 'https:'].includes(url.protocol)) return whole;
      return ` ${name}=${quote}${proxyPath(url.href)}${quote}`;
    } catch { return whole; }
  });
  rewritten = rewritten.replace(/\sstyle\s*=\s*(["'])(.*?)\1/gi, (whole, quote, css) => ` style=${quote}${rewriteCss(css, baseUrl)}${quote}`);
  rewritten = rewritten.replace(/<a\b(?![^>]*\btarget\s*=)/gi, '<a target="_self"');
  return rewritten.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (_whole, attrs, css) => `<style${attrs}>${rewriteCss(css, baseUrl)}</style>`);
}

async function serveBrowse(url, res) {
  try {
    const destination = new URL(url);
    const response = await fetchPublicPage(destination.href);
    const contentType = String(response.headers['content-type'] || 'application/octet-stream');
    let body = response.body;
    if (/^(text\/html|application\/xhtml\+xml)/i.test(contentType)) {
      body = Buffer.from(rewriteHtml(body.toString('utf8'), response.url));
    } else if (/^text\/css/i.test(contentType)) {
      body = Buffer.from(rewriteCss(body.toString('utf8'), response.url));
    }
    res.writeHead(response.status, {
      'content-type': contentType,
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'content-security-policy': "default-src * data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' data: blob:; style-src * 'unsafe-inline' data: blob:; img-src * data: blob:; font-src * data: blob:; connect-src * data: blob:; frame-src * data: blob:; form-action *; base-uri 'self'"
    });
    res.end(body);
  } catch (error) {
    console.error(`[viewer] ${error.message}`);
    const message = error.message.includes('publicly reachable') ? error.message : 'Nomad could not load this page. Try opening the original site.';
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><meta charset="utf-8"><style>body{font:16px system-ui;background:#07111f;color:#eaf2ff;padding:28px}a{color:#6caeff}</style><p>${message}</p>`);
  }
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
  if (req.method === 'GET' && url.pathname === '/browse') {
    const destination = url.searchParams.get('url');
    if (!destination) return sendJson(res, 400, { error: 'Missing page URL.' });
    return serveBrowse(destination, res);
  }
  if (req.method === 'GET' && url.pathname === '/api/search') {
    const query = (url.searchParams.get('q') || '').trim();
    if (!query) return sendJson(res, 400, { error: 'Enter a search query.' });
    if (query.length > 500) return sendJson(res, 400, { error: 'Query is too long.' });
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
