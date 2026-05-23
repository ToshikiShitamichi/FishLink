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
// 5/12 #70/#72: 役割選択アイコン差し替え（fish.svg） + プロフィール拡張 → v80
// 5/13 追補：#74 ソート反映バグ修正 + #69 data-cache 導入 + 魚一覧ナビアイコンを fish.svg に → v81
// 5/13 追補2：#69 Storage 画像も SW キャッシュ対象に追加（動的 API のみスキップに変更） → v82
// 5/23 #75/#76: ダッシュボード棚順並び替え + 魚種カテゴリアイコン10種に差し替え → v83
// 5/23 #77: image-resize.js のエラー診断強化（Event→Error 正規化 + phase/code 付き wrap）→ v84
// 5/23 #78: 投稿完了/注文確定の location.href → location.replace 化（戻るボタン誤操作対策）— v84 に含む
const CACHE_NAME = 'fishlink-v84';

const PRECACHE_URLS = [
    '/',
    '/index.html',
    '/register.html',
    '/manifest.json',
    '/css/style.css',
    '/js/firebase-config.js',
    '/js/auth.js',
    '/js/i18n.js',
    '/js/province-utils.js',
    '/js/profile-utils.js',
    '/js/data-cache.js',
    '/js/image-resize.js',
    '/locales/ja.json',
    '/locales/en.json',
    '/locales/km.json',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/images/role-fish.svg',
    // 5/23 #76: 魚種カテゴリアイコン（CAA 10種）
    '/images/striped_snakehead.png',
    '/images/walking_catfish.png',
    '/images/red_tilapia.png',
    '/images/nile_tilapia.png',
    '/images/silver_barb.png',
    '/images/spot_pangasius.png',
    '/images/pangasius.png',
    '/images/giant_snakehead.png',
    '/images/climbing_perch.png',
    '/images/frog.png',
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

// 5/12 #69: フェッチ戦略を stale-while-revalidate に変更。
//   旧: cache-first（一度キャッシュされると更新が反映されにくかった）
//   新: キャッシュがあれば即時返す + 裏で最新版を取得して次回に備える。
//   → 体感の表示速度を向上（白画面・スピナー時間を短縮）しつつ、
//      ユーザの2回目アクセスで最新版に切り替わる。
//
// 5/13 追補2：スキップ対象を「動的データ API」に限定。Firebase Storage（画像）と
//   Firebase SDK の CDN は SW キャッシュを使う方向に変更（プロフィール写真等の
//   再表示を高速化）。
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    const host = url.hostname;

    // 動的API（リアルタイム性が必要・キャッシュすべきでない）
    const isDynamicApi =
        host === 'firestore.googleapis.com'
        || host === 'identitytoolkit.googleapis.com'
        || host === 'securetoken.googleapis.com'
        || host === 'logging.googleapis.com'
        || host === 'appcheck.googleapis.com'
        || host.includes('fcm.googleapis.com')
        || host.includes('fcmregistrations.googleapis.com');

    if (isDynamicApi || event.request.method !== 'GET') {
        return;
    }

    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(event.request);
        // 裏で最新版を取得しキャッシュ更新（失敗は無視）
        const networkPromise = fetch(event.request)
            .then((response) => {
                if (response && response.status === 200) {
                    cache.put(event.request, response.clone()).catch(() => {});
                }
                return response;
            })
            .catch(() => null);
        // キャッシュがあれば即時返す。なければネットワーク待ち。
        if (cached) return cached;
        const fresh = await networkPromise;
        return fresh || new Response('', { status: 504, statusText: 'offline' });
    })());
});
