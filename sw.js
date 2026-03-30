const CACHE_NAME = 'fishlink-v1';

// インストール時にキャッシュするファイル一覧
const PRECACHE_URLS = [
    '/',
    '/index.html',
    '/register.html',
    '/manifest.json',
    '/css/style.css',
    '/js/firebase-config.js',
    '/js/auth.js',
    '/js/i18n.js',
    '/locales/ja.json',
    '/locales/en.json',
    '/locales/km.json',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
];

// インストール：キャッシュに追加
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
    );
    self.skipWaiting();
});

// アクティベート：古いキャッシュを削除
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    .filter((key) => key !== CACHE_NAME)
                    .map((key) => caches.delete(key))
            )
        )
    );
    self.clients.claim();
});

// フェッチ：キャッシュファースト戦略
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Firebase・Google Maps はネットワーク優先（キャッシュしない）
    if (
        url.hostname.includes('firebase') ||
        url.hostname.includes('googleapis') ||
        url.hostname.includes('gstatic') ||
        event.request.method !== 'GET'
    ) {
        return;
    }

    // それ以外はキャッシュファースト
    event.respondWith(
        caches.match(event.request).then((cached) => {
            if (cached) return cached;
            return fetch(event.request).then((response) => {
                if (!response || response.status !== 200) return response;
                const cloned = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
                return response;
            });
        })
    );
});