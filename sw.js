// ── FCM（Firebase Cloud Messaging）──────────────────────────
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

const firebaseConfig = {
    apiKey: "AIzaSyCVFFieinYqc3pqbigeQuhJ8KdVs6as9DU",
    authDomain: "fishlink-t-shitamichi.firebaseapp.com",
    projectId: "fishlink-t-shitamichi",
    storageBucket: "fishlink-t-shitamichi.firebasestorage.app",
    messagingSenderId: "54443009365",
    appId: "1:54443009365:web:a531106e41c4397ace7bdc"
};

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

// data-only ペイロードを受信して自前で通知表示（iOS PWA安定化のため）
messaging.onBackgroundMessage((payload) => {
    const title = payload.data?.title || 'FishLink';
    const body = payload.data?.body || '';
    const orderId = payload.data?.orderId || '';
    const url = payload.data?.url || '/';
    self.registration.showNotification(title, {
        body,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: `fishlink-${orderId}`,
        data: { url },
    });
});

// ── 通知タップ時 ────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = event.notification.data?.url || '/';
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
            // 既存タブがあればそこにナビゲート
            for (const client of windowClients) {
                if ('navigate' in client) {
                    client.navigate(targetUrl);
                    return client.focus();
                }
            }
            // なければ新しいウィンドウを開く
            if (clients.openWindow) return clients.openWindow(targetUrl);
        })
    );
});

// ── PWAキャッシュ ────────────────────────────────────────────
// デプロイごとにバージョンを上げる → 旧キャッシュが自動削除される
const CACHE_NAME = 'fishlink-v70';

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

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
    );
    self.skipWaiting();
});

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

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    if (
        url.hostname.includes('firebase') ||
        url.hostname.includes('googleapis') ||
        url.hostname.includes('gstatic') ||
        event.request.method !== 'GET'
    ) {
        return;
    }

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
