'use strict';

const form = document.querySelector('#search-form');
const input = document.querySelector('#query');
const button = document.querySelector('#submit');
const status = document.querySelector('#status');
const results = document.querySelector('#results');
const count = document.querySelector('#count');
const searchUi = document.querySelector('#search-ui');
const viewer = document.querySelector('#viewer');
const viewerUrl = document.querySelector('#viewer-url');
const original = document.querySelector('#open-original');
const proxyMount = document.querySelector('#proxy-mount');
const connection = new BareMux.BareMuxConnection('/baremux/worker.js');
const { ScramjetController } = $scramjetLoadController();
const scramjet = new ScramjetController({
  files: {
    wasm: '/scram/scramjet.wasm.wasm',
    all: '/scram/scramjet.all.js',
    sync: '/scram/scramjet.sync.js'
  }
});
scramjet.init();

let proxyFrame;
form.addEventListener('submit', event => {
  event.preventDefault();
  const query = input.value.trim();
  if (!query) return;
  const next = new URL(location.href);
  next.searchParams.set('q', query);
  next.hash = '';
  history.replaceState({}, '', next);
  runSearch(query);
});

async function showViewer(raw) {
  let target;
  try { target = new URL(raw); } catch { return; }
  if (!['http:', 'https:'].includes(target.protocol)) return;

  viewerUrl.textContent = target.href;
  original.href = target.href;
  searchUi.hidden = true;
  viewer.hidden = false;
  window.scrollTo(0, 0);

  try {
    await registerSW();
    const wispUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/wisp/`;
    if ((await connection.getTransport()) !== '/libcurl/index.mjs') {
      await connection.setTransport('/libcurl/index.mjs', [{ websocket: wispUrl }]);
    }
    if (!proxyFrame) {
      proxyFrame = scramjet.createFrame();
      proxyFrame.frame.id = 'proxy-frame';
      proxyMount.append(proxyFrame.frame);
    }
    proxyFrame.go(target.href);
  } catch (error) {
    status.textContent = `Nomad couldn’t open this site in the viewer: ${error.message}`;
    viewer.hidden = true;
    searchUi.hidden = false;
  }
}

document.querySelector('#back-results').addEventListener('click', () => {
  proxyFrame?.frame.remove();
  proxyFrame = undefined;
  proxyMount.replaceChildren();
  viewer.hidden = true;
  searchUi.hidden = false;
  history.replaceState({}, '', `${location.pathname}${location.search}`);
  window.scrollTo(0, 0);
});

async function runSearch(query) {
  button.disabled = true;
  status.textContent = 'Searching the web…';
  results.replaceChildren();
  count.textContent = '';
  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Search failed');
    count.textContent = `${data.results.length} results via ${data.provider}`;
    status.textContent = data.results.length ? '' : `No results found for “${query}”.`;
    for (const item of data.results) {
      const article = document.createElement('article');
      article.className = 'result';
      const heading = document.createElement('h2');
      const link = document.createElement('a');
      link.href = item.url;
      link.textContent = item.title || item.url;
      link.addEventListener('click', event => {
        event.preventDefault();
        history.replaceState({}, '', `${location.pathname}${location.search}#view=${encodeURIComponent(item.url)}`);
        showViewer(item.url);
      });
      heading.append(link);
      const address = document.createElement('div');
      address.className = 'url';
      address.textContent = item.url;
      const snippet = document.createElement('p');
      snippet.className = 'snippet';
      snippet.textContent = item.snippet;
      article.append(heading, address, snippet);
      results.append(article);
    }
  } catch (error) {
    status.textContent = error.message;
    count.textContent = '';
  } finally {
    button.disabled = false;
  }
}

const params = new URLSearchParams(location.search);
if (params.has('q')) {
  input.value = params.get('q');
  runSearch(input.value);
}
const initialView = new URLSearchParams(location.hash.slice(1)).get('view');
if (initialView) showViewer(initialView);

