'use strict';

// PWA用サービスワーカー。
// 対戦はSocket.IOでのリアルタイム通信が前提なので、オフラインで遊べるようにはしない。
// 目的は「ホーム画面から起動したときにアプリの外枠（HTML/CSS/JS/アイコン）を素早く出すこと」と
// 「インストール要件を満たすこと」。常にネットワーク優先で、更新がすぐ反映されるようにする。
// 静的ファイルを変更したら CACHE_NAME のバージョンを上げると、古いキャッシュが確実に破棄される。
const CACHE_NAME = 'daifugo-shell-v4';
const SHELL_FILES = [
  '/',
  '/index.html',
  '/style.css',
  '/main.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 他オリジン（アイコン写真など）と Socket.IO 通信には一切介入しない
  if (url.origin !== self.location.origin || url.pathname.startsWith('/socket.io/')) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        if (req.mode === 'navigate') {
          const shell = await caches.match('/index.html');
          if (shell) return shell;
        }
        return Response.error();
      })
  );
});
