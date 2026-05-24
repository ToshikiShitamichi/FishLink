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
// 5/23 #80: 商品ページ Q&A（コメント→質問へリブランド + 1問1答スレッド + プレビュー + FCM通知）→ v85
//   - i18n locales (comments.* / order.comment) 更新あり → PRECACHE 更新のため版番号バンプ
// 5/23 #81: 取引チャット ボイスメッセージ機能（録音/プレビュー/Storage保存/FCM通知 + 30日自動削除）→ v86
//   - js/voice-message.js を新規 PRECACHE 対象に追加。locales に voice.* キー追加。
// 5/23 #82 Phase 1: 紹介クーポン機能（招待コード生成・表示・シェア + 注文時コード入力の記録のみ）→ v87
//   - js/referral.js を新規 PRECACHE 対象に追加。locales に referral.* キー追加。
// 5/23 #69 改善（Phase A）: メモリ画像キャッシュ（dashboard / fish-list / order 適用）→ v88
//   - js/image-cache.js を新規 PRECACHE 対象に追加。
//   - 一度フェッチした画像を blob URL で memory 保持し、画面遷移時のフラッシュを解消。
//     SW のディスクキャッシュとは別レイヤー（同セッション内に閉じる）。
// 5/23 #69 改善（Phase B）: image-cache + data-cache を残画面に展開 → v89
//   - 画像キャッシュ適用：farmer.html / restaurant.html / cart.html / delivery.html / farmer dashboard / orders / comments / account profile
//   - data-cache 拡張：fish-list / order / cart / farmer.html / restaurant.html / comments の users/fishListings 取得を getCachedUser/getCachedListing 経由に
//   - cart.html の stock 検証は引き続き直接 getDoc（最新値が必要）
// 5/23 #69 改善（Phase C）: JS 実行前の白画面対策 → v90
//   - style.css の .loading-overlay デフォルトを display:none → display:flex に反転。
//     HTML パース直後からスピナーが表示される。
//   - body.app-ready が立った時点で .show 制御に切り替え（旧挙動互換）。
//   - i18n.js に 10秒 failsafe を追加（ページが個別に app-ready を立てない場合の保険）。
//   - 主要画面の loading.classList.remove('show') の直後に document.body.classList.add('app-ready') を追加。
// 5/23 #69 改善（Phase D）: IndexedDB 永続画像キャッシュ → v91
//   - image-cache.js に IDB 層追加：prefetch / revalidate で取得した Blob を IndexedDB に保存し、
//     起動時に最新の N 件（200件）を memory に preload して描画前に warm-up。
//   - タブ間・セッション間で画像キャッシュを共有。LRU eviction（上限 500 件）。
//   - auth.js logout で IndexedDB を clearAll（プライバシー保護）。
// 5/23 #69 改善（Phase E）: quota 監視 + CORS 見える化 → v92
//   - navigator.storage.estimate() ベースで 80% 超過時に強制 eviction。30 件書込み毎にチェック。
//   - QuotaExceededError 発生時にも即 forceEvictIDB（aggressive eviction）。
//   - fetch 失敗をページに 1 回だけ console.warn（CORS 設定不足の早期発見用）。
// 5/23 #69 改善（Phase F）: admin 配下 + post.html 仕上げ → v92 ステイ（HTML 変更のみ）
//   - admin/reports.html / order.html に image-cache 適用
//   - admin 計 6 ページに app-ready 付与（reports/order/users/index/settings/caa）
//   - farmer/post.html の CAA 価格データ取得を data-cache 経由に
// 5/23 #69 改善（Phase G）: 実機ログ受けて 2 件修正 → v93
//   - REGRESSION 修正：index.html / register.html に app-ready を追加（10秒 failsafe 待ちを解消）
//   - prefetch を 800ms 遅延 + SW キャッシュ優先取得で二重ネットワーク要求を回避（cold start 改善）
// 5/23 #69 改善（Phase H）: HEAD revalidate を 60秒 → 1時間 に延長 → v94
//   - Firebase Storage の download URL は token 含めて immutable。同一 URL の HEAD ETag 確認は不要。
//   - 実機ログ（本番）で 20件キャッシュ × 毎分 HEAD = 約 20リクエスト/分 が削減対象だった。
//   - Cambodia 4G の帯域・LCP 改善のための調整。
// 5/23 #69 改善（Phase I）: LCP 改善 — fetchpriority="high" を上半分の画像に付与 → v95
//   - asCachedImgAttrs に priority オプション追加。
//   - dashboard.html の shelf-newest[0] / fish-list.html の items[0] / order.html のヒーロー画像に付与。
// 5/23 #69 改善（Phase J）: ページレベル stale-while-revalidate → v96
//   - js/render-cache.js を新規 PRECACHE 対象に追加。sessionStorage で画面描画状態を保存。
//   - dashboard.html: 2 回目以降の訪問で cached を即時描画 → スピナーなしで表示 → 裏で fresh fetch + silent update
//   - auth.js logout で render-cache もクリア（プライバシー保護）
// 5/23 #69 改善（Phase J 改2）: 実機ログ受けて 2 件修正 → v97
//   - render-cache を sessionStorage → localStorage に変更（タブ閉じても永続）＋ TTL 24時間
//   - dashboard.html の cached render を initI18n 直後（waitForUserData の前）に移動
//     → spinner 表示時間が ~1500ms → ~200-300ms に短縮（currentUserData 待ち不要に）
//   - cache に myLoc も保存（render 時の距離表示用）
// 5/23 #69 改善（Phase J 拡張）: render-cache を 4 画面に展開 → v98
//   - fish-list.html / order.html (listing 単位) / farmer.html (farmer 単位) / restaurant.html (restaurant 単位) / farmer/dashboard.html
//   - 各画面で fetch から render を分離 → cached / fresh 両方から同じ render 関数を呼ぶ
//   - Timestamp は toMillis 化で JSON 化（fmtDate は Number/Timestamp 両対応）
// 5/24 ドキュメント整理リリース → v99
//   - CLAUDE.md の #81（ボイスメッセージ）/ #82（紹介クーポン）の完了・未完了範囲を
//     クライアント要望ベースで再整理。ソース変更なし・PRECACHE 変更なし。
//   - 既存セッションへの再配信を促すため版番号のみバンプ（旧 SW 強制更新）。
const CACHE_NAME = 'fishlink-v99';

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
    '/js/voice-message.js',
    '/js/referral.js',
    '/js/image-cache.js',
    '/js/render-cache.js',
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
