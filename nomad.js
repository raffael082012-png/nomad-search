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
const fullscreenButton = document.querySelector('#fullscreen-viewer');
const particleCanvas = document.querySelector('#particles');
const particleContext = particleCanvas.getContext('2d');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
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
let particleFrame = 0;
let particleWidth = 0;
let particleHeight = 0;
let particles = [];

function resizeParticles() {
  cancelAnimationFrame(particleFrame);
  particleFrame = 0;
  const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
  particleWidth = window.innerWidth;
  particleHeight = window.innerHeight;
  particleCanvas.width = Math.round(particleWidth * ratio);
  particleCanvas.height = Math.round(particleHeight * ratio);
  particleContext.setTransform(ratio, 0, 0, ratio, 0, 0);
  const count = Math.min(72, Math.max(28, Math.round(particleWidth / 20)));
  particles = Array.from({ length: count }, () => ({
    x: Math.random() * particleWidth,
    y: Math.random() * particleHeight,
    radius: 0.7 + Math.random() * 1.2,
    speedX: (Math.random() - 0.5) * 0.22,
    speedY: -0.12 - Math.random() * 0.22,
    alpha: 0.16 + Math.random() * 0.38
  }));
  drawParticles();
}

function drawParticles() {
  particleFrame = 0;
  if (particleCanvas.hidden || document.hidden) return;
  particleContext.clearRect(0, 0, particleWidth, particleHeight);
  for (const particle of particles) {
    particleContext.beginPath();
    particleContext.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
    particleContext.fillStyle = `rgba(117, 184, 255, ${particle.alpha})`;
    particleContext.fill();
    if (!reduceMotion.matches) {
      particle.x += particle.speedX;
      particle.y += particle.speedY;
      if (particle.y < -4) {
        particle.y = particleHeight + 4;
        particle.x = Math.random() * particleWidth;
      }
      if (particle.x < -4) particle.x = particleWidth + 4;
      if (particle.x > particleWidth + 4) particle.x = -4;
    }
  }
  if (!reduceMotion.matches) particleFrame = requestAnimationFrame(drawParticles);
}

function updateFullscreenButton() {
  const active = document.fullscreenElement === viewer;
  fullscreenButton.textContent = active ? '⛶ Exit fullscreen' : '⛶ Fullscreen';
  fullscreenButton.title = active ? 'Exit fullscreen' : 'Enter fullscreen';
  fullscreenButton.setAttribute('aria-label', fullscreenButton.title);
}

fullscreenButton.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement === viewer) await document.exitFullscreen();
    else await viewer.requestFullscreen();
  } catch {
    fullscreenButton.title = 'Fullscreen is unavailable in this browser';
    fullscreenButton.setAttribute('aria-label', fullscreenButton.title);
  }
});
document.addEventListener('fullscreenchange', updateFullscreenButton);
window.addEventListener('resize', resizeParticles, { passive: true });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelAnimationFrame(particleFrame);
    particleFrame = 0;
  } else if (!particleCanvas.hidden && !reduceMotion.matches && !particleFrame) {
    particleFrame = requestAnimationFrame(drawParticles);
  }
});
reduceMotion.addEventListener?.('change', () => {
  cancelAnimationFrame(particleFrame);
  particleFrame = 0;
  drawParticles();
});
resizeParticles();

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
  particleCanvas.hidden = true;
  cancelAnimationFrame(particleFrame);
  particleFrame = 0;
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
  if (document.fullscreenElement === viewer) document.exitFullscreen().catch(() => {});
  viewer.hidden = true;
  particleCanvas.hidden = false;
  drawParticles();
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

