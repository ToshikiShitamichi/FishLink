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
// 5/24 #82 Phase 3 枠組み先行 → v100
//   - pages/admin/referral.html（運営設定画面）新設。settings/referral ドキュメントの
//     enabled / restaurantCouponKhr / farmerBonusKhr / couponValidDays /
//     maxReferralsPerUser / couponPriority を編集可能に。
//   - 各 admin ページの navigation に navReferral リンク追加。
//   - i18n に admin.navReferral / admin.referral.* キーを 3 言語追加。
//   - Phase 2（特典自動付与）実装前の枠組みのみ。クーポン発行・農家ボーナス計算は未実装。
// 5/24 #82 Phase 2 Chunk 1 完了 → v101
//   - 5/24 クライアント仕様確定：紹介コード入力場所を cart.html → register.html に移管
//   - cart.html から referral input block / appliedReferralCode 変数 / setupReferralInput
//     IIFE / order doc への appliedReferralCode 書き込み / validateReferralCode import を削除
//   - register.html に「紹介コード（任意）」入力欄を追加。blur 時インライン検証 +
//     submit 時の最終検証で users/{uid}.pendingReferralCode を保存
//   - js/auth.js register() に pendingReferralCode パラメータ追加
//   - pages/admin/referral.html から couponPriority セクションを削除
//     （5/24 仕様確定：クーポン優先固定のため設定不要）
//   - i18n 3 言語：referral.codeInput* / codeOk 追加、cart 専用キー削除、
//     admin.referral.priority* / ruleSection 削除、文言を register 入力前提に更新
// 5/24 #82 Phase 2 Chunk 2 完了 → v102
//   - functions/index.js に紹介クーポン処理を追加：
//     - MESSAGES に referralCouponIssued / referralBonusEarned / referralBonusApplied 追加
//     - generateCouponCode / issueCouponToRestaurant（衝突回避 5 回リトライ）
//     - grantReferralReward（受け取る側のロール → クーポン or pendingFarmerBonus++）
//     - confirmReferralForUser（pendingReferralCode → referredBy 昇格 + referralCount++・冪等）
//     - consumeFarmerBonusForOrder（取引完了時に pendingFarmerBonus を 1 消費 + order に上乗せ）
//     - processReferralAndBonus（エントリーポイント）
//   - onOrderUpdated の status='completed' 分岐内で processReferralAndBonus を呼び出し
//   - firestore.rules に match /coupons/{couponCode} 追加：
//     - read: 所有者 or admin / create: false（CF のみ）
//     - update: 所有者の usedAt + usedOrderId のみ・未使用時のみ / delete: false
//   - SW PRECACHE 変更なし（バックエンド変更のみ）。版番号バンプは旧 SW 強制更新用
// 5/24 #82 Phase 2 Chunk 3 完了 → v103
//   - js/referral.js に validateCouponCode を追加（doc ID = code 文字列で直接 getDoc・
//     形式・存在・所有者・未使用・期限内をチェック）
//   - pages/restaurant/cart.html confirm ステージに「クーポンコード」入力欄を追加
//   - renderConfirm: クーポン適用時に effectiveCampaignActive=false でレストラン側
//     キャンペーン割引を抑制 + grand total から discount を差し引き表示
//     + 「キャンペーン無効」注意書きを条件表示
//   - placeOrders: クーポンは最大 totalAmount の order draft に集約して適用
//     （usedOrderId 単一性確保 + 差額破棄ルールで cap）。同一 batch 内で
//     coupons/{code}.usedAt + usedOrderId を書き込み（Rules で二重使用ガード）
//   - i18n 3 言語に coupon.* キー 14 個追加
//   - SW PRECACHE 変更なし（既存 referral.js は既に PRECACHE 済）
// 5/24 #82 Phase 2 Chunk 4 完了 → v104
//   - pages/restaurant/account.html に「使えるクーポン一覧」セクション追加
//     where ownerUid==self + クライアント側で未使用 / 期限内フィルタ
//     コード文字列・割引額・有効期限・発行元（紹介者 or 被紹介）表示 + コピーボタン
//   - pages/farmer/account.html に「紹介ボーナス枠」カード追加
//     settings/referral.enabled+farmerBonusKhr>0 のときのみ表示
//     pendingFarmerBonus の残数 + 1 チケットあたりの金額を案内
//   - i18n 3 言語に myCoupons.* + bonus.farmer* キー追加（合計約 16 個）
//   - SW PRECACHE 変更なし（HTML 変更のみ・no-cache 配信で即反映）
// 5/24 #82 Phase 3 不正対策 enforcement 完了 → v105
//   - functions/index.js confirmReferralForUser に 3 つのガードを追加：
//     1. maxReferralsPerUser enforcement（settings.maxReferralsPerUser > 0 のとき
//        紹介者の referralCount が上限到達済みなら付与スキップ + pendingReferralCode クリア）
//     2. 招待ネットワーク循環検知（1-hop A→B→A · 多段は Phase 3 対象外）
//     3. トランザクション内で並行確定時の上限再チェック
//   - 構造化ログ「[referral-skip] {reason, uid, code, ...extra}」を導入
//     reason 語彙: orphan_code / self_code / max_referrals_exceeded /
//     max_referrals_race / cycle_1hop
//   - SW PRECACHE 変更なし（functions 変更のみ・バックエンドデプロイで反映）
// 5/24 #82 Phase 2 Chunk 4 hot-fix → v106
//   - pages/restaurant/account.html loadCoupons から orderBy を撤去
//     where('ownerUid','==',uid) のみで取得し、issuedAt 降順は client-side sort で実施
//   - 理由: where + orderBy の組み合わせは複合 index が必要となり、
//     初回アクセス時に「インデックスを作成してください」エラーで停止するため
//   - 件数は通常 数件〜数十件 オーダーで client sort で十分
//   - 併せて firestore.rules に追加した coupons ルールは Firebase Console で
//     手動反映が必要（本プロジェクトの運用：Console が source of truth）
// 5/25 #83-#92 リリース: 基本情報編集 / レビュー件数表示 / 距離不整合修正 / 新着フィルタ統一 /
//   カート UI 改善 / 注文承認画面強調 + 10分前通知 / post.html / 運営チャット 読込改善 +
//   カテゴリ選択（Phase 1+運営側カテゴリ表示）
// 5/25 #91/#92 拡張: render-cache を全 31 ページに展開（編集系・admin・cart・comments 含む）。
//   render-cache.js に serializeTimestamps / reviveTimestamps ヘルパー追加。
// 5/27 #100: voice-message.js の MIME mp4 優先化 + voiceUploadStatus 追加（受信者側に再生不可状態を見せない）
// 5/27 #93: image-cache.js に空 blob ガード + Safari 用 onerror フォールバック
// 5/27 #94: cart.html にカレンダーローカライズ用 flatpickr 導入
// 5/27 #96: GAqP 認証バッジ機能（profile-utils.gaqpBadgeHtml 追加・admin/users.html・farmer.html・order.html・fish-list.html・dashboard.html）
// 5/27 #97: dashboard 農家ブロックを更に省スペース化
// 5/27 #98: レビュー件数とコメント付きレビュー件数を別表示（farmer.html / restaurant.html）
// 5/27 #99: 質問・返信の多段スレッド化（parentReplyId 追加・comments.html / functions onCommentCreated）
// 5/27 #101: 紹介クーポン明細表示（restaurant/payment.html・purchases.html / farmer/orders.html・payment.html・sales.html）
// 5/27 admin-chat: 白画面回避 defensive fix（initI18n 直後に app-ready セット）
// 5/27 cart: 言語切替で再描画
// 5/27 #97 v2: dashboard card を 2 段構成（上=写真+情報、下=農家）に再設計、幅 280px
// 5/27 #99 修正: 重複返信ボタン削除、質問者本人にも取消ボタン
// 5/27 farmer/orders: 新規注文を onSnapshot で監視
// 5/27 fish-list: 過去注文フィルタ追加
// 5/27 admin-chat: </style> 閉じタグ欠落の致命バグ修正（全 body コンテンツ不可視→可視化）
//   + カテゴリ未選択時に入力欄を disabled に
// 5/27 cart: 内臓処理チップ 2 段化（「+xxx KHR/kg」改行）で削除ボタン横並び維持
// 5/27 order.html: フッターを translateX 方式に変更（DevTools モバイル表示で fixed が
//   消える環境差を回避）
// 5/27 #99 修正2: 「もっと見る」を location.reload から renderQA() 即時再描画に変更
//   （expandedThreads がメモリ Set なので reload で消えていた）
// 5/30 #102/#103: Home / 魚一覧 デザインリニューアル → v112
//   - dashboard.html（#102 5セクション構成・注文ステッパー・横スクロール棚）刷新
//   - fish-list.html（#103 2列グリッド・絞り込みボトムシート・ソートDD・検索サジェスト・売切れ末尾固定・戻り時状態保持）刷新
//   - locales 3言語に home.* / fishlist.* 名前空間を追加 → PRECACHE 再取得のため版番号バンプ
//   - 色は既存DS（css/style.css）に準拠、寸法はモック正本。構成/状態/遷移は spec 遵守
// 5/31 #104-#107: 農家投稿一覧/出品フォーム新設 + Home/魚一覧 spec改訂 → v113
//   - #105 post.html: 配送設定を farmer 単位（users/{uid}.farmerDelivery）へ移行。初回3欄/2回目サマリー＋変更ボトムシート。
//     listing には配送を書かず、買い手側は order-utils.resolveDelivery で農家docを参照（旧フィールドはfallback）。価格/CTAを青(primary)統一。
//   - #104 dashboard.html(farmer): 投稿一覧（販売中/売切れ・要補充/出品停止のグルーピング・状態別アクション・停止グレーアウト・GAqP・在庫補充ショートカット）
//   - #107 fish-list.html: 距離スライダー廃止/配達範囲外は完全非表示/送料3param(農家doc)/価格0〜25000固定/「その他」チップ/評価0=「新規」/送料無料表示
//   - #106 dashboard.html(restaurant): キャンペーンバナー（検索バー直下・率はデータ化）/魚タイル11種目「その他」/評価0=「新規」
//   - cart.html / restaurant dashboard の配送計算を resolveDelivery 経由に移行。locales 3言語にキー追加 → 版番号バンプ
// 6/1 #108-#113: クライアントレビュー修正6件 → v114
//   - #113 魚種マスタ 10→11種（バラマンディ追加）: FISH_TYPES 5箇所 / locales fish.barramundi / post.html select / CAA / タイル・チップ・サジェストは配列由来で自動反映
//     ・CAA-OCR(functions): プロンプト列マッピングに ត្រីឆ្ពង់→barramundi（11列）を追加。さらにバラマンディ値は Kampot 行のみのため CAA対応州に Kampot(កំពត) を追加（functions PROVINCES / caa.html PROVINCES / post.html PROVINCE_MAP）
//   - #108 Home: GAqPバッジ「✓ GAqP」短縮（gaqp.badge）/ キャンペーンバナーに終了日 campaignEndDate（admin/settings 新設・表示条件 今日≤終了日）/ 割引文言「魚代から」
//   - #109 魚一覧: キャンペーンバナー削除（Homeのみ表示）/ GAqPバッジ短縮
//   - #110 商品詳細(order.html): spec全面更新（ヘッダー=魚名/★%/CTA青(カートに入れる主・今すぐ注文副)/GAqP緑ボックス見出し「GAqP 認証農家」/取引条件ブロック/説明→Q&Aの順/他の出品サイズ表示・現出品除外）
//   - #111 カート: 内臓処理トグル中立グレー+ヒント直下/単価に(内臓処理あり/なし)併記/削除右上/CTA青/明細「魚代」/配送料注記+送料無料/最低注文量C案/整数kg/最短リードタイム8h(運営値leadTimeHours)でスロットグレーアウト/配送料節約提案を非表示/確認画面サイズ・内臓処理全項目明示・納品日時強調
//   - #112 農家注文: 手数料は通常率満額表示+キャンペーン割引で戻す/評価★%（小数廃止・0件は新規）/CTA青(orders・delivery)/魚単価と内臓処理を分解表示/承認確認は自前モーダル/レビューは完了後のみ/到着メッセージ文言更新/(内臓処理あり)フル表記
//   - CSS: --color-cta/-dk/-lt（青）を DS に新設（CTA=青・緑=GAqP/成功/送料無料・赤=danger 専用に役割分離）
//   - settings/campaign に campaignEndDate / farmerCampaignEndDate / leadTimeHours を追加。locales 3言語にキー追加 → 版番号バンプ
const CACHE_NAME = 'fishlink-v114';

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
