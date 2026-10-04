'use strict';

async function registerSW() {
  if (!('serviceWorker' in navigator)) {
    throw new Error('Nomad’s in-page viewer requires a browser with service worker support.');
  }
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
}

