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
// 6/2 #114-#115: 農家側2画面の追加修正（横断ルール「CTA・価格＝青／緑＝GAqP専用」の徹底）→ v115
//   - #114 投稿一覧(dashboard.html): 価格 .pl-price 緑→青(--color-cta) / 再開・補充 .pl-act.primary 緑→青 / カードの内臓処理表記の先頭「＋」除去（dashboard.gutPrice「内臓処理」を新設・post.gutPrice はフォームラベル用に「＋内臓処理」を温存）。販売中バッジの緑は成功色として維持
//   - #115 出品フォーム(post.html): ①魚単価未入力時の価格ボックスを「0」→空状態「魚単価を入力してください」(post.priceEmpty) ②魚単価 placeholder「5,500」除去→「例：5,000」(post.priceUnitPlaceholder)・内臓処理500プリフィルは維持 ③CTA「投稿する」/シート「保存して全出品に反映」/販売価格表示/式 を緑→青 ④商品の説明に虚偽注意 warn-note 追加(post.descriptionWarn) ⑤必須未入力をインラインエラー方式に（各欄直下に赤メッセージ＋枠赤・最初のエラー欄へスクロール・トップは総括のみ・写真も必須化）
//   - locales 3言語に post.priceEmpty/priceUnitPlaceholder/errorPhoto/errorDeliverableRadius/errorDeliveryFee/errorRequiredSummary/descriptionWarn + dashboard.gutPrice を追加 → 版番号バンプ
// 6/3 #116-#121: 6/3 クライアントレビュー修正6件 → v116
//   - #116 カート/注文確認: 合計の金額を青(--color-cta)/数量入力ボックス幅を3〜4桁に拡張/キャンペーン割引行をカートと注文確認で同じ軽い強調(🏷+オレンジ・うっすらamber)に統一/納品日を曜日付き「6/4（木）」表記に(カート・注文確認・Home進行中注文)
//   - #117 商品詳細(order.html): メイン価格・他の出品カード価格を青に統一/Q&A teaser はスレッドの元の質問(root)を主に表示(+最新返信)
//   - #118 生産者ページ(farmer.html): ヘッダー★%=取引満足度・0件は新規/出品中の魚=標準商品カード(価格は画像下・青・買い手向け単一の正=手数料込み)・農家フッター省略・売切れグレーアウト末尾固定/養殖環境・一言は未登録ならセクション非表示/GAqPは認証情報ボックスに一本化(ヘッダー下compactバッジ廃止)/レビューコメント最新3件+もっと見る
//   - #119 公開Q&A(comments.html): 返信権限ゲート(農家=全スレ/質問者=自スレのみ/他は閲覧のみ注記)/ヘッダー価格を買い手向け単一の正/質問する・返信する=青/質問起点の取り消し=スレッドごと削除(server cascade)/Q&A通知+未回答は農家やることリスト(farmer_qa)
//   - #120 連絡先マスク: js/contact-mask.js 新設(電話/SNS/URL検知→伏字+警告)。comments.html・farmer/restaurant delivery・admin-chat に適用。functions でサーバ側再検知(バイパス防止)
//   - #121 モデレーション: トラブル報告に「公開質問（要確認）」(qa_contact)カテゴリ追加。マスク発動投稿を自動レポート化→admin reports.html で「投稿を非表示にする」(ソフト削除)
//   - 追加: 農家/レストラン基本情報編集(account/basic.html)に「現在地を使う」ボタン(初期登録と同じ挙動)
//   - Firestore Rules: comments update に sender本人・admin を追加（⚠️ Console 手動公開が必要）
//   - locales 3言語に comments.*(emptySub/viewOnlyNote/confirmDeleteThread/maskWarning/maskedContact) / profile.reviewsMore / todos.farmer_qa / admin.reports.*(qa_contact系) を追加 → 版番号バンプ
// 6/4 #122-#126: 6/4 クライアントレビュー修正5件 → v117
//   - #122 Home(dashboard.html): 価格・進行中合計・「他の農家を探す」CTAを緑→青/辞退カード消去ルール(代替注文で自動クリア＋手動×・辞退済み履歴はFirestoreに残る)。バナーは既にHome実装済・admin設定文を「Home画面の上部に」へ修正・GAqPバッジは商品/農家とも同一コンパクトピルで対応済
//   - #123 魚一覧(fish-list.html): カード価格を緑→青(全画面横断スイープ＝価格は青で統一)。「もっと見る」=初期10件/+10件は実装済を確定
//   - #124 農家注文確認(orders.html): 受取予定額を青/キャンペーン割引をamber/納品日を曜日付き「6/5（金）」。承認待ち詳細レイアウト=魚名・FL番号を見出しに集約(本文重複削除)・魚代の内訳ラベル化・注文内容/金額ブロックに整理
//   - #125 配送管理チャット レストラン側(delivery.html): 新デザイン(共有 js/chat-timeline.js)。システム行/日付区切り/時刻のみバブル/画像サムネのみ/買い手5段の言葉/📍距離のみ(地図リンクなし)。入口導線は既存
//   - #126 配送管理チャット 農家側(delivery.html): システム行(線画アイコン・遅延amber)/日付区切り/音声プレイヤー/画像ラベル廃止/ステータス送信ボタンの緩い誘導(次=青/送信済=取消線/遅延=amber)/CTA青/配送完了の自前モーダル。承認時に「注文が承認されました」システム行を生成
//   - 共通: css/style.css に .tl-chat/.tl-sys/.tl-datesep/.quick-status状態/.chat-modal を追加。js/chat-timeline.js 新設(両アプリ鏡像レンダリング)。locales 3言語に home.dismissDecline / orders.section*・deliveryLabel / delivery.completeModal*・statusSendHint・statusApprovedMsg を追加
//   - functions 変更なし(ステータス送信は type:'chat'+statusKind を維持し既存通知経路を保全)。Firestore Rules/インデックス変更なし
// 6/5 #125/#126 レビュー反映(チャットヘッダー統一・距離計算) → v118
//   - 配送管理チャットのヘッダーをモック chat-head に統一(両画面)：相手名＋右肩ステータスバッジ／魚種・数量・納品(曜日付き)・FL の1行／📍距離(買い手のみ)・📍地区＋地図を見る(農家のみ)。css/style.css に .ch-top/.ch-name/.ch-status/.ch-sub/.ch-loc/.ch-dist を追加
//   - 買い手チャットの📍距離: 注文ドキュメントに distKm が無いため、レストラン位置↔農家位置から haversine で都度計算(農家側 orders.html と同一ロジック)
// 6/5 #128/#129: 6/5 クライアントレビュー修正2件 → v119
//   - #128 相互レビュー入力(restaurant/farmer review.html): アイコン絵文字👍👎→線画スマイリー(sentiment_satisfied/dissatisfied・未選択グレー・良かった緑/残念赤)・送信ボタン青・問題報告を削除・3軸を1カード区切り線・上部ガイド・実名＋FL番号・見出し1つ・インラインバリデーション(未選択軸赤枠＋「選択してください」＋最初の未選択へスクロール・下部総括・ボタン無効化しない)・「残念だった」でコメント促し・コメント連絡先マスク(rawComment/masked/hidden)。
//   - #128 モデレーション: functions onReviewCreated でサーバ側再マスク(バイパス防止)＋マスク発動レビューを reports type:'review_contact'(新カテゴリ)へ自動上げ。admin/reports.html に専用カード＋「非表示にする」(review.hidden=true)。生産者ページ farmer.html は hidden を公開から除外。firestore.rules: reviews サブコレクションに admin の update を許可。
//   - #129 精算フロー: restaurant/payment.html=金額青/割引amber/確認ボタン「支払い完了」青/自前モーダル/金額をコピー/レビュー導線は支払い後のみ/FL番号。farmer/payment.html=受取予定額青/手数料を「-1,875＋キャンペーン割引+938」分解(承認画面と統一)/手数料・送料を中立グレー(±)/「確認中(問題報告)」状態追加/レビュー導線は支払い確認後のみ/FL番号。
//   - #129 admin: index.html=「未払い(期限超過)」フィルタ＋赤件数バッジ。order.html=入金控え(振込元名義＋メモ＋入金スクショ)/「送金額をコピー」＋送金スクショ/問題報告の保留通知＋保留解除/FL番号。restaurant/report.html=問題報告で paymentProblemHold=true。
//   - locales 3言語: review.*(guide/errorAxis/errorSummary/commentPromptBad) / payment.*(copyAmount/copied/reviewAfterPay/reviewAfterConfirm/modal*/receiveAmountHold/statusProblemHold*/remittanceHoldDesc) / admin.tx.tabOverdue・statusOverdue / admin.order.*(hold*/depositProof*/payerName/copyRemitAmount/remitProof*) / admin.reports.typeReview_contact。functions REPORT_TYPE_LABELS に review_contact。
//   ⚠️ Firestore Rules 変更あり(reviews update=admin) → Console 手動公開が必要。
// 6/6 #131/#132 認証クラスタ（v121・6/9 追補込み）:
//   - 識別子をログインID→電話番号に変更。Firebase は email/password のまま、正規化した電話番号から
//     合成メール {phone}@fishlink.local を生成して内部ID化（js/firebase-config.js: normalizePhone/
//     isValidCambodiaPhone/formatPhoneDisplay、js/auth.js: register/login）。ログインはハイブリッド解決＝
//     入力が電話番号形式なら電話メール、それ以外は旧 {loginId}@fishlink.local にフォールバック（既存/admin救済）。
//   - index.html: 電話番号入力＋「パスワードをお忘れですか？」(/recover.html)＋CTA青＋友好的エラー(error.invalidCredentials)。
//   - register.html: ログインID欄削除／PWA設定ボックス撤去→onboarding／暗黙同意(規約/プラポリリンク)／CTA青／
//     インラインバリデーション(#115/#128方式)／登録後 onboarding.html へ／地図言語をアプリ言語に同期(language=)。
//   - 新規: onboarding.html(④ ホーム追加/通知/音＋農家送金先・端末自動判別)、recover.html(⑤⑥⑦・SMS_OTP_ENABLED=false で
//     運営手動リセット暫定・#133確定後にSMS-OTP差込)、terms.html/privacy.html(暗黙同意リンク先・現行ドラフト)。
//   - #132: post.html 出品ゲートバナー 赤→amber＋CTA青。farmer/account/payment.html=送金先(⑨⑩)に名義一致amber注意／
//     名義必須＋(QRリンク or QR画像)いずれか必須／payway形式チェック／CTA青／インライン検証。
//   - locales 3言語: login.phone/phonePlaceholder/forgotPassword、register.consent*/termsLink/privacyLink、
//     error.phoneInvalid/phoneTaken/invalidCredentials/network/requiredSummary、account.nameMatchNotice/error*/qrEitherHint、
//     新namespace onboarding.* / recover.* / legal.* / terms.* / privacy.*。functions変更なし。Firestore Rules変更なし。
//   ⚠️ 既存アカウントは Firestore/Auth とも削除しない（ハイブリッドで旧IDログイン継続）。電話番号ベースへの完全移行は別途。
//   - 6/9 追補：terms.html/privacy.html は register から target="_blank"（新規タブ）で開くため history.back() で
//     戻れない → 「戻る」をタブを閉じる（不可なら history.back / register へフォールバック）に修正。v120 は未デプロイのため v121 に統合。
// 6/7 #134/#135 紹介クーポン（リファラル）UI修正＋整合バグ（v122・hosting のみ）:
//   - #134A プロフィール：account.html×2 の紹介コードカードを緑→ソフトブルー（GAqP緑と区別・--color-cta系）／
//     シェアボタン青／基本情報ヒント「ログインID…」→「電話番号…」(menuHintBasic)／レストランのクーポンは
//     コード/コピーを撤去し「カートで使えます」導線(myCoupons.useInCart)に（ウォレット1タップへ統一）。
//   - #134B シェア：referral.shareText を /register.html?ref={{code}} 自動入力リンク＋コードは文中に小さく残す。
//     register.html は URL ?ref= を読んで紹介コード欄へ自動入力＋インライン検証（✓有効…）まで実行。
//   - #134C カート：コード入力欄を撤廃→ウォレットから1タップ適用（confirm で coupon-wallet-block 表示）。
//     明細・合計のクーポン割引を赤→amber。案Z（クーポン使用中はキャンペーン割引を出さない）は既存ロジック踏襲。
//   - #135 整合：admin/order.html=入金確認に「紹介クーポン -」行(referralDiscountAmount)／農家送金に「紹介ボーナス +」行
//     (referralBonusAmount)・amber。farmer/orders.html=承認画面＋承認モーダルに保留ボーナス(pendingFarmerBonus×settings)
//     のプレビュー行「+5,000（取引完了時に加算）」＋受取予定額に込み。settings farmerBonusHint「紹介元のみ」→「双方」。
//   - locales 3言語: myCoupons.useInCart、coupon.wallet*(Title/TapHint/CampaignNote/Applied/Apply)、orders.bonusOnComplete、
//     referral.shareText 改、admin.account.menuHintBasic 改、admin.settings.referral.farmerBonusHint 改。
//   ⚠️ functions / Firestore Rules / インデックスの変更なし（hosting のみ）。付与ロジックは #82 Phase2 のまま（本番未稼働）。
// 6/10 #137/#138 レストランページ修正＋生産者ページ波及（v123）:
//   - #137 レストランページ（pages/farmer/restaurant.html）を全面改修：カバー1枚→アイコン円形＋お店の様子の2枠／
//     信頼ブロックのメタ行「📍地区 ・ 取引N件 ・ YYYY/M〜」追加（“率”は出さない）／3軸メトリクスをニュートラル統一／
//     ★非赤＋`★N%（件数）`・0件=新規／お店の紹介（未記入は非表示）／レビューコメント=最新3件＋もっと見る・線画スマイリー／
//     自己プレビューは編集ボタン廃止→案内バナー（profile.selfPreviewNote）。地図は常時表示（農家向け＝配達先）。
//   - #138 生産者ページ（pages/restaurant/farmer.html）：レビューの👍👎絵文字→線画スマイリー／信頼ブロックに「取引N件」追加。
//   - js/review-card.js を新規 PRECACHE 対象に追加（両ページ共通のレビューコメント描画＝sentiment_satisfied/dissatisfied）。
//   - locales 3言語に profile.tradeCount / viewReviews / shopIntro / shopIntroFrom / shopScene / selfPreviewNote
//     / selfPreviewNoteProducer / previewPublicPage を追加。
//   - 6/11 導線修正（案A・#137 §10）：マイページ「レストラン情報」「生産者ページ」を編集画面(account/profile.html)直リンクに
//     変更し、編集画面に「公開ページをプレビュー」リンクを追加。生産者ページ(restaurant/farmer.html)の編集ボタンを撤去し
//     自己プレビューバナーへ（レストランページ#137 §9 と対称）。対象=account.html×2・account/profile.html×2・restaurant/farmer.html。
//   - 6/11 §6/§2：レストランのプロフィール編集(restaurant/account/profile.html)に「店のアイコン(avatarUrl)」のアップロード/削除と
//     「お店の紹介文(restaurantMessage・textarea)」の編集を追加（農家編集と同方式・公開ページに反映）。既存ギャラリーのラベルを
//     「レストラン写真」→「お店の様子」に統一。locales に profile.shopIcon / shopIntroPlaceholder 追加。
//   ⚠️ functions 変更あり（onOrderUpdated 完了遷移で users.tradeCount を +1／callable backfillTradeCount 追加）＝バックエンドデプロイ要。
//      既存完了注文は admin/settings.html「取引数を集計」ボタン（callable）で一度だけバックフィル。Firestore Rules / インデックス変更なし。
// 6/14 #144/#145 運営チャット（サポート）再設計＋FAQ管理（v126）:
//   - #144 FAQ基盤：新コレクション faq（{category,i18n{km,en,ja}{question,answer},images[],published,order,createdAt}）。
//     新規 admin/faq.html（カテゴリDD・編集言語タブ・追加/編集/削除・公開非公開トグル・ドラッグ並べ替え・画像複数）。
//     新規 js/faq-display.js（ユーザー側 公開FAQ ロード＋アコーディオン描画＝振り分け②に埋め込む）を PRECACHE 追加。
//     firestore.rules に faq ルール追加（published==true は public read／admin write）→ Console 手動公開が必要。
//     ユーザー側クエリは where(category==X, published==true)（equality×2・orderByなし）＝複合インデックス不要。
//     併せて adminChats ルールを厳格化（レビュー反映）：親doc write を admin 限定（user が自分の
//     supportStatus を書いて未対応を隠せないように）／messages create は本人=senderRole'user' or
//     'system'&&type'separator' のみ（管理者なりすまし・任意system行偽装を封鎖）／本人 update は isRead のみ。
//   - #145 運営チャット再設計：pages/admin-chat.html を ①カテゴリ選択→②振り分け（FAQ＋ロール別窓口＋エスカレ）→
//     ③青の往復チャット（自分=青右/運営=白左・件の区切り「— カテゴリ —」system行・画像複数添付・日付/時刻）に全面再設計。
//     pages/admin/users.html 管理側＝青の往復・件区切り・画像表示／未対応/対応済（supportStatus）＋未対応フィルタ/バッジ＋
//     「対応済にする」／評価 79.00→★79%(件数)・0件=新規／毎メッセージのカテゴリバッジ廃止。
//     全 admin 7ページのナビに「FAQ」追加。
//   ⚠️ functions 変更あり（onAdminChatMessage：separator/system は通知・サマリ対象外／supportStatus 設定／
//      返信 push url を ?view=chat に／画像のみメッセージのプレビュー／ユーザー発言のサーバ側連絡先
//      マスク再検知＝#120 バイパス防止）＝バックエンドデプロイ要。
//   - css/style.css に .sup-*（青往復バブル/件区切り/日付区切り）＋ .faqd-*（FAQアコーディオン）を追加。
//   - locales 3言語に adminChat.*（catSelectTitle/faqSectionTitle/deskSectionTitle/escalate*/desk*/existing*/categoryReferral 等）／
//     admin.faq.*／admin.navFaq／admin.users.*（statusTodo/statusDone/markDone/filterTodo/ratingNew）を追加。
//     categoryPayment を「支払い・送金について」に変更。Storage は既定 auth ルール（faq/{id}/・adminChats/{uid}/ ＝専用ルール不要）。
// 6/16 #146/#147 魚一覧アクティブ絞り込みチップ＋0件出し分け／農家一覧 新設（v127・hosting のみ）:
//   - #146 fish-list.html: アクティブ絞り込みチップ行（適用中のみ・ソート/絞り込みバーの下・✕で個別解除・2行折り返し・
//     チップ数＝適用数バッジと一致）／0件の見出し出し分け（魚種フィルタ単独→「本日◯◯の出品はありません」＋サブ／
//     他条件混在→「条件に合う魚がありません」）＋青「すべての魚を見る」（全フィルタ＋検索を外す・ソート維持）／
//     0件では「もっと見る」を非表示。locales fishlist.emptyTitleSpecies/emptySubSpecies/emptyViewAll/removeFilter 追加。
//   - #147 farmer-list.html 新設（おすすめ農家「もっと見る」の着地）: Home農家カード流用・縦1列・評価/距離ソート・
//     魚種チップ単一選択（fishKinds で絞り込み・該当タグ青強調）・配達範囲外は非表示・新規は末尾だが隠さない。
//     dashboard.html のおすすめ農家「もっと見る」を fish-list.html?sort=rating → farmer-list.html に張り替え。
//     データは既存（fishListings active + users public read）をクライアント集計＝hosting-only。locales farmerlist.* 追加。
//   - ⚠️ functions / Firestore Rules / インデックス変更なし。新規HTML（pages/restaurant/farmer-list.html）は
//     他の pages/ 同様 PRECACHE には入れず stale-while-revalidate でランタイムキャッシュ＝版番号バンプで反映。
// 6/17 #148〜#152 レストラン/生産者ページ追加修正・問題を報告・SMS-OTP・地図衛星（v128）:
//   - #148/#149 公開ページ（farmer/restaurant.html・restaurant/farmer.html）＝お店の様子/養殖環境を横スワイプ
//     カルーセル＋ドット化／在庫を価格下メタ行へ／一言ボックス中立グレー／GAqP薄緑ボックス／登録時期 YYYY年M月／
//     0件レビュー一本化（レストラン）。編集ページ（profile.html×2）の編集/保存ボタンを青・キャンセルをグレー。
//   - #150 問題を報告（report.html×2 再設計＝タイトル統一/カテゴリ青/送信青/ノート灰/写真複数/送信後青）＋
//     入口出し分け（report-window.js 新規＝配送完了＋N時間の期限内のみ表示・「報告済み・対応中」・締切注記）を
//     restaurant orders/payment・farmer orders に追加。admin/settings.html に「報告受付時間」追加（settings/campaign）。
//     js/report-window.js を新規 PRECACHE 対象に追加。
//   - #151 SMS-OTP（Firebase Phone Auth）= recover.html / register.html に flag-gated で実装（既定OFF）。
//     functions に resetPasswordWithPhone callable 追加。Firebase Console（Phone Auth有効化等）は手動・要デプロイ後+855実機テスト。
//   - #152 地図 航空写真（衛星）切替＝register / basic×2 は mapTypeControl:true、farmer/restaurant.html（埋め込み iframe）は
//     地図/航空写真トグル（&t=k）。生産者ページは地図なし＝対象外。
//   - ⚠️ functions（callable）＋ Firebase Console 設定あり。Firestore Rules 変更なし（settings/reports とも既存ルールで足りる）。
// 6/17 追補（v129）: 敵対的レビュー確定3件の修正＋SMS-OTP フラグON。
//   - blocker: order.completedAt が未書き込み＝#150 報告期限が全死 → functions の completed 分岐で completedAt 追記
//     ＋ report-window.js に paymentDeadline(-10分) フォールバック（既存注文も hosting だけで機能）。
//   - low: 生産者ページ 一言ボックスの else 欠落（再描画で消し漏れ）修正／recover「再送する」ハンドラ追加。
//   - #151 SMS-OTP を ON（recover SMS_OTP_ENABLED / register REGISTER_OTP_ENABLED ＝ true）。
//     ⚠️ 本番hostingに出す前に Firebase Console（Phone Auth 有効化等）＋ +855 実SMS到達テストが必須。
//        REGISTER_OTP_ENABLED=true は全新規登録に OTP 必須＝+855 不達のまま本番ONにすると登録不能になる。
//        日本の動作確認は Console「テスト用電話番号」（実SMSなし・固定コード）で。
// 6/20 (v131): #153-156 の実機QA修正＝買い手キャンセル確認BSの z-index（ボトムナビに隠れていた）／
//   農家 問題報告入口を SPEC準拠（配送完了＋Nh の窓内のみ・進行中カードでは出さない）／
//   納品日の曜日表示（6/19（金））を全画面で統一（deliveryDateIso 優先）。
// 6/20 (v132): #157-160 ＝ 農家投稿一覧（出品する ナビ 緑→青/グレー・削除確認 中央モーダル・💬質問 未回答[要返信]バッジ）／
//   Q&A 農家ビュー権限ゲート（質問コンポーザー非表示・空状態文言・取り消し確認 中央モーダル）／
//   農家一覧（もっと見る[初期8件+8]・魚種チップ 12種＋その他）／確認系ダイアログを横断で中央モーダルに統一（#160）。
// 6/20 (v133): 買い手 注文状況＝辞退の「同じ魚を再注文」を、以前の出品が今も購入可能（販売中・在庫あり・未削除）なら商品詳細へ直行／無ければ魚一覧[同魚種・別農家]へフォールバック。
// 6/22 (v134): #161-163 実装再レビュー修正（hosting-only）＝
//   #161 出品フォーム（post.html）：配送サマリー緑→青系・魚単価placeholder汎用化・必須/任意バッジ・最低注文量と初回配送3欄のプリフィル撤去＋placeholder・数値スピナー非表示＋inputmode=numeric・送料無料ヘルプ グレー＋おすすめ文言・セクション白カード化・投稿成功の完了画面（中央モーダル・緑✓）＋送信中ボタン無効化。
//   #162 商品詳細（order.html）：農家行アバター（avatarUrl・未設定は人型）。Q&A teaser件数は #153① で roots.length 済（確認のみ）。
//   #163 カート（cart.html / order-utils.js）：キャンペーン割引の基準を買い手「魚代」（fishPrice+serviceFee）に（農家側 farmerCampaignDiscount は不変）・内臓処理ヒントをトグル直下にグループ化・削除確認 中央モーダル・注文確認の納品日に「納品」ラベル＋🕐。トグル中立グレー/クーポンウォレットは既存（確認のみ）。
//   locales 3言語にキー追加・変更（post.required/optional placeholders/success*・cart.deleteConfirm 等）。
// 6/22 (v135): #164-170 束A（プロフィール/アカウント）＋運営チャット再レビュー＝
//   #E 共有トースト js/toast.js（✓保存しました・precache 追加）。
//   #164 マイページ top 再構成（並び順・アバター・@ハンドル非表示・紹介1行メニュー＋専用ページ・公開ページサブ文言・ログアウト中立グレー・農家 配送設定 行・FishLink→FISHLINK）。
//   #165 基本情報（表示名 公開ヘルプ・農家 保存ボタン青・位置住所 読み取り専用注記・1項目ずつ編集）。
//   #166 電話番号 自己変更 OTP（secondary app で OTP→callable changePhoneWithOtp が updateUser(email)＋重複チェック＋Firestore 更新）。
//   #167 送金先（必須/いずれか1つ必須バッジ＋──または──・キャンセル中立グレー・placeholder）／返金先（買い手 新規 refundAccount・任意・空状態・amber警告・説明・マイページ「未登録」）。
//   #168 配送設定 独立画面（farmer/account/delivery.html・farmerDelivery 共有・全出品共通の警告 0件出し分け）。
//   #169 運営チャット（運営に送る＝副次グレー枠・注文/配送窓口1ボタン統合）／FAQ（保存トースト＋フォーム閉じ・失敗インライン）。
//   #170 FAQ画像保存 失敗の診断強化＋インラインエラー（Storage ルールは Console 手動）。
// 6/22 (v136): #166 実機修正＝電話番号変更OTPの reCAPTCHA "already rendered" 解消（送信ごとに
//   recaptcha-container を作り直す `freshRecaptcha()`）。＋#170 の Storage ルールを `storage.rules` に
//   version-controlled 化（faq＋adminChats＋settlements・Console 手動公開）。
// 6/22 (v137): 実機UI修正＝#168 配送設定のラベルと入力欄のバランス（グローバル select/input[number]{width:100%}
//   に勝つよう `.fb-iw .fb-input` で幅を上書き＋ラベル flex:1＝CJKの1文字縦折り返しを解消）／
//   #169 C9 FAQ 画面言語セレクタが全幅だった真因＝`#lang-selector` に `width:auto` 欠落（他 admin 画面と同じく追加）。
// 6/26+6/27 (v138): #171-184 案B（前払い＋ウォレット）精算作り直し＋束B紹介＋実機不具合3件。
//   #171 backend: wallets コレクション（残高+台帳・CFのみ書込）／onOrderCreated でウォレットデビット／
//     onOrderUpdated で辞退・キャンセル→即ウォレット返金（複数農家クーポン按分・全額返金でクーポン復活）／
//     autoCompleteTrades（配送完了+Nh で取引完了自動確定・旧督促を前払いはスキップ）／consumeFarmerBonus で
//     referralBonusTotalKhr（#177獲得合計）／requestWalletWithdrawal callable（出金申請→残高即減算→運営チャット）。
//     firestore.rules に wallets 追加（Console 手動公開要）。
//   #172 cart.html: 前払い（注文内容確認→ウォレット充当→KHQR）ステージ＋#178 クーポン期限近い順に自動適用。
//   #174 restaurant/orders.html: 注文状況を案B再構成（お支払い確認中/農家確認中+キャンセル/お届け済み/辞退→ウォレット返金行）。
//   #183 restaurant/payment.html: read-only 購入詳細化（受取時払いフロー撤去・✓お支払い済み(前払い)）。
//   #173 restaurant/wallet.html 新規（残高・履歴4種・返金申請）＋#176 マイページ💰ウォレット行。
//   #175 farmer/orders.html: ✓支払い済み(前払い)バッジ/帯・承認/辞退モーダル文言。
//   #182 farmer/payment.html: 送金待ち/確認中/送金済（FISHLINK預かり）。#184 farmer/delivery.html 配送完了モーダル文言。
//   #177 referral.html×2: 紹介専用ページ（2段階タイミング・運営値・ロール別報酬・獲得合計・空状態）。
//   #179 image-resize.js: リサイズ/デコード失敗時は原画像フォールバック（QR登録ブロッカー解消）。
//   #180 recover/register: reCAPTCHA を試行ごと作り直し＋リトライ（カンボジア回線の誤エラー抑止）。
//   #181 全 app HTML に viewport-fit=cover（下部ナビ env(safe-area) を有効化）＋固定フッター safe-area。
//   locales 3言語に 113 キー追加/改。functions・firestore.rules デプロイ要。
// 6/28 (v139): #176 実機修正＝ウォレット返金申請カードに「返金先QR」が出ない不具合。
//   requestWalletWithdrawal callable が本文テキストのみ投稿していた → refundAccount.qrImage を imageUrls で添付
//   （admin-chat.html / admin/users.html とも m.imageUrls を描画）＋ qrLink は本文に記載。
//   onAdminChatMessage は type==='withdraw_request' を連絡先マスク対象外に（返金先リンク/名義を潰さない）。
//   ＝functions のみの修正（hosting 変更なし）だが、旧SW強制更新のため版番号バンプ。
// 6/29+6/30 (v140): #185-188 プッシュ通知 設計一式＋レビュー修正＋セキュリティ文書。
//   #185 functions（配送3ステータスのみpush・prepare_start除外／前払い「お届け」／取引完了レビュー誘導／
//        問題報告→農家／お支払い未確認／クーポン期限3日前リマインド[新schedule]／辞退返金の遷移先を注文状況へ／
//        送金完了・成長系の deep-link 見直し）＋ notifMessages/pushOptin/review i18n。
//   #186 client（登録直後の自動OS許可を廃止→自前ソフト確認[js/push-optin.js 新規]の〔オンにする〕押下時のみ
//        enablePush・〔あとで〕は初回注文/初回出品後に再度／フォアグラウンド抑制＝開いている会話は出さない）。
//   #187 レビュー送信完了ボタン 青＋実遷移ラベル／コメントplaceholder中立化。#188 はドキュメント（デプロイ外）。
// 7/2 (v141): #185-188 の自己プレビュー ロゴ修正を同梱（v140 未デプロイのため v141 に統合）＝
//   pages/farmer/restaurant.html（レストラン公開ページ）・pages/restaurant/farmer.html（生産者ページ）の
//   ヘッダーロゴを、閲覧者ロール（currentUserData.role）自身のダッシュボードへ出し分け（自己プレビュー中に
//   相手アプリのダッシュボードへ飛ぶ不具合の修正・戻る矢印 history.back() は不変）。hosting-only 2ページ。
// 7/4-5 (v142): #189-193 バッチ＝規約同意フロー導線＋FISHLINK表記統一（#189）／規約・プラポリ管理編集＋
//   Firestore駆動ページ（#190・js/legal-display.js 新規 PRECACHE 追加・terms/privacy 書き換え・firestore.rules legal）／
//   KHR 100リエル単位 切り捨て（#191・order-utils.js）／農家 売上・取引 確認中反映（#192）／買い手 注文状況 確認中＋
//   購入・取引 履歴除外（#193）。locales 3言語に #190/#192/#193 キー追加＋FishLink→FISHLINK。
// 7/8 (v143→v144): #194-198 バッチ＝出品フォーム 内臓処理 する/しないトグル・100リエル検証（#194）／
//   丸魚のみ（gutPrice=null）波及（#195）／納品日時ルール＋承認期限 注文+1.5h・夜間(21-5時)リセット
//   （#196・js/approval-deadline.js 新規 PRECACHE 追加・functions deadline ベース化）／レビュー待ち導線（#197）／
//   プロフィール編集 小修正（#198）。locales 3言語に post.*/order.*/dashboard.*/cart.*/orders.review*/profile.* 追加。
//   実装 v143 → 実機スクショのモック整合＋クライアント指示反映（内臓処理見出し・レビュー待ち入口2行・入力ラベルレス等）で v144 に再bump。
// 7/9-13 (v146): #199-202 動画・リール機能（案C一括）。基盤＝reel_videos データモデル／firestore.rules+storage.rules
//   （reel_videos + reels/{uid}/**・Console 手動公開）／js/video-cache.js（206/Range 対策＝Blob全取得+IDB）・
//   js/reel-utils.js（SPEC準拠 クライアント自動圧縮 mp4 + アップロード/検証/照会/削除/鮮度表記）・
//   js/reel-ui.js（共有カード/全画面プレーヤー/🎬バッジ・CSS自己注入）＝新規3 PRECACHE 追加／
//   functions（保持N=10 onReelVideoCreated・完全削除の道連れ物理削除 onFishListingDeletedCascade）。
//   画面＝農家 post/dashboard/reel-post[新規]/reel-videos[新規]・買い手 home/order/producer。タップ再生・先読みなし・端末キャッシュ。
//   ⚠ v144 は #194-198。v145 実装 → 実機スクショで新規2ページのヘッダー縦書き圧縮（#147同根・flex:1）を修正し v146 に再bump。
// 7/10 (v147): #203/#204 案B 前払い決済の実運用化。買い手 前払いKHQR画面（cart.html 受取Joint口座明示・金額なし警告・
//   ABAアプリ/QR保存の2ボタン・受取名告知・お支払い控え添付[paymentProofs/{uid}/]）／注文状況 orders.html（お支払い未確認カード
//   2ボタン・確認中キャンセルは即返金と約束しない）／運営 admin/order.html 入金照合UI（入金確認済/お支払い未確認[理由必須]の2択・控え照合）。
//   backend＝functions（未確認キャンセルは即返金しない・入金確認で deferred 返金／paymentUnconfirmed 通知は既存）＋storage.rules（paymentProofs・Console 手動公開）。
//   ⚠ v147 実装 → 実機で〔もう一度支払う〕が空カートに飛ぶバグ（注文は発注済み＝カートは空）を修正し v148 に再bump。
//   〔もう一度支払う〕→ cart.html?repay=<orderId>＝再支払いモード（既存注文の KHQR画面を直接表示・支払いましたで paymentUnconfirmed 解除）。hosting のみ（cart.html/orders.html）。
// 7/15 (v149): #205-208 リール実機レビュー改善（hosting＋storage.rules）。
//   #205 動画1コマ サムネ＆poster（reel-utils.captureVideoThumbnail→reels/{uid}/{listingId}/{id}_thumb.jpg・
//        storage.rules で reels/ に image 許可・Console 手動公開要）／🔇ミュートトグル・上限30秒表記／投稿の進捗％。
//   #206 全画面リール＝ストーリーズ型セグメント廃止→細い再生バー1本／下部ボタン〔👁この魚を見る〕1本に集約
//        （詳細›・カート削除・農家の距離›は残す）／新着ピル=24h／0本 空状態を短く（reel-ui.js・reel-videos.html）。
//   #207 生産者ポートフォリオ カードは農家名を外し青「販売中」バッジ（reelCardHtml hideFarmer）／〔すべて見る〕→
//        別グリッド画面（farmer.html #reel-grid-view）／出品フォーム nudge 文言（i18n）。
//   #208 買い手表示価格の 100リエル切り捨てを共通関数 buyerDisplayUnitPrice（order-utils.js）で全カードに統一
//        （dashboard/fish-list/order/farmer/comments/cart）＋PC オーバーレイ最大幅（低）。
//   locales 3言語に reel.mute/unmute/emptySub/farmerVideosTitle/gridNote 追加＋videoTapAdd(30秒)/nudge 改。
//   ⚠ storage.rules（reels/ の image 許可）を Console 手動公開。functions も変更あり（レビュー指摘＝サムネ _thumb.jpg の
//   道連れ物理削除＝reel doc に thumbStoragePath 保存＋保持N超過/道連れ削除の2経路で thumb も削除）。Firestore Rules/インデックス変更なし。
// 2026-07-19 #209/#210/#211（7/17 リール取りこぼし＋丸め残差分＋前払い画面表示面）→ v150
//   #209 全画面リール＝ミュート自動再生（旧タップ再生・spec §4 2026-07-15変更）／ループ継ぎ目の黒フラッシュを
//        JS制御で解消（loop属性を外し rAF で終端手前に seek）／次の1本だけ先読み（再生開始後・saveData/2g は不可）／
//        再生バーを画面最上部→〔この魚を見る〕直上へ／poster が video の不透明背景に隠れていた既存バグを修正
//        （z-index＝#205④ の poster は一度も見えていなかった＝⑦「タップ直後に真っ黒」の一因）／
//        Home新着リールの sizeLabel に単位（8 head/kg）＝spec §8。
//   #210 カート「表示単価×数量＝小計」の整合（serviceFee を buyerDisplayUnitPrice からの逆算に）／
//        内臓処理ヒントを2つの表示単価の差分に（旧＝gutPrice単体×料率で一般にはズレる）／
//        ウォレット手入力のパース穴（"50.750"→50.75→0）と cap の100丸め／
//        桁区切りの表記ゆれ（41.000）＝toLocaleString をページ内18箇所すべて 'en-US' 明示に。
//   #211 ステージ別ヘッダータイトル（カート／注文内容の確認／お支払い）／KHQR の長い説明を削除し
//        ⚠ボックス・ボタンのサブ文言・※ノートへ再配置／控え添付の✕削除。
//   ⚠ hosting のみ（functions / Firestore Rules / インデックス / Storage ルール変更なし）。
// 2026-07-19 #209⑦（最優先・機能の生命線）実機で全画面リールが「なかなか出てこない／黒いまま」→ v151
//   原因は3つ揃わないと直らない＝今回の3点セット。
//   ⑦-1 投稿時に MP4 を faststart 化（moov atom を先頭へ）＝js/mp4-faststart.js を新規 PRECACHE 追加。
//        moov が末尾だと、再生開始前にファイル全体のダウンロードが必要＝激遅だった。
//   ⑦-2 全画面リールの再生を「全DL待ち」から progressive 再生へ（js/reel-ui.js / js/video-cache.js）。
//        ⚠ ⑦-1 だけ入れても速くならない：従来は video-cache が fetch でファイル全体を Blob 化してから
//        <video src=blobURL> に渡していた（＝SW が 206 をキャッシュできない問題を回避するための #199 設計）ため、
//        moov を先頭に置いても全部落とすまで待っていた。
//   ⑦-3 SW が動画リクエストに手を出さない（下の fetch ハンドラ・詳細はそこのコメント参照）。
//        従来は全 GET を横取りしており、ブラウザ本来の Range/206 progressive 再生を邪魔していた。
// 2026-07-19 実機修正：前払い画面「お支払いの控えを添付」が反応しない → v152
//   ① トリガー方式を統一：この行だけ <label> が hidden な file input を暗黙に activate する方式だったが、
//      iOS Safari 等では display:none の input が label クリックで開かないことがある。
//      → label の既定動作を preventDefault で止め、input.click() を明示的に呼ぶ（post.html 等と同方式）。
//   ② 失敗を可視化：アップロード失敗時に console.warn だけで無言リセットしていたため、
//      「押しても何も起きない」と区別がつかなかった（Storage ルール未公開＝permission-denied も同じ見え方）。
//      → payment.attachProofFailed のトーストを出す（3言語・locales は PRECACHE なので版バンプが必須）。
// 7/22 (v153→v154): #212-215 バッチ。運営管理画面の2軸ステータス（js/status-axes.js 新規＝配送軸/入金軸を
//   既存 order フィールドから導出）＋取引一覧の2軸列/フィルタ・KPI成立ベース・買い手支払い列/返金済タグ・
//   期間未選択ガード（admin/index.html）／分析タブ新設（admin/analytics.html＝クライアント集計）／
//   注文管理詳細の2軸・手数料透明化・入金確認整理・送金メモ・QRボタン（admin/order.html）／
//   出品フォーム・配送設定の単価/送料 100リエル最寄りスナップ（post.html / account/delivery.html）／
//   リール：投稿ハング統一＋フレーム抽出再修正（reel-utils.js / reel-videos.html）・ドラッグシーク＋PC中央（reel-ui.js / farmer.html）・
//   既存動画 faststart 遡及（functions/mp4-faststart.js 新規＋callable faststartReelBackfill＋admin/settings.html）。
//   ⚠ v154（再bump）＝敵対的レビュー確定6件を反映（faststart callable の timeoutSeconds:540/memory＋documentId
//     ページング／status-axes の onHold〔問題報告中〕入金軸状態＝誤送金防止／手数料KPIを運営取り分ベースに是正／
//     分析の期間終端 .999＋createdAt欠損の span 汚染ガード）。precached の status-axes.js・locales を触ったため再bump。
const CACHE_NAME = 'fishlink-v154';

const PRECACHE_URLS = [
    '/',
    '/index.html',
    '/register.html',
    '/onboarding.html',
    '/recover.html',
    '/terms.html',
    '/privacy.html',
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
    '/js/chat-timeline.js',
    '/js/review-card.js',
    '/js/faq-display.js',
    '/js/legal-display.js',
    '/js/report-window.js',
    '/js/toast.js',
    '/js/push-optin.js',
    '/js/approval-deadline.js',
    // 7/22 #212/#213: 運営管理画面の2軸ステータス導出（admin index/order/analytics が import）。
    '/js/status-axes.js',
    '/js/video-cache.js',
    '/js/reel-utils.js',
    '/js/reel-ui.js',
    // 🎬 #209⑦-1: 投稿時に MP4 の moov atom を先頭へ移す（faststart 化）。
    //   reel-utils.js から import されるため、同じ扱いで precache する。
    '/js/mp4-faststart.js',
    '/locales/ja.json',
    '/locales/en.json',
    '/locales/km.json',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/images/role-fish.svg',
    // 5/23 #76 / #141: 魚種カテゴリアイコン（固定12種＝CAA11種＋オニテナガエビ prawn）
    '/images/striped_snakehead.png',
    '/images/walking_catfish.png',
    '/images/red_tilapia.png',
    '/images/nile_tilapia.png',
    '/images/silver_barb.png',
    '/images/spot_pangasius.png',
    '/images/pangasius.png',
    '/images/giant_snakehead.png',
    '/images/barramundi.png',
    '/images/climbing_perch.png',
    '/images/frog.png',
    '/images/prawn.png',
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
//
// 🎬 2026-07-19 #209⑦-3 追補：メディア（動画・音声）はスキップ対象に追加＝下記 isMediaRequest。

// 🎬 #209⑦-3: URL が動画・音声ファイルかを拡張子で判定する。
//   Firebase Storage の download URL はパスが URL エンコードされている
//   （例 /v0/b/<bucket>/o/reels%2F<uid>%2F<listingId>%2F<id>.mp4?alt=media&token=…）ので、
//   デコードしてから末尾の拡張子を見る。クエリ（?alt=media&token=…）は pathname に含まれない。
//   ⚠ 「パスに reels を含む」だけで判定してはいけない：reels/ 配下には #205 のサムネ
//      （{id}_thumb.jpg）も同居しており、それまで SW キャッシュ対象外になってしまう。
//      サムネは poster＝黒画面対策の要なのでキャッシュを効かせたい。だから拡張子で見る。
//   ・voice/{orderId}/{msgId}.{webm|mp4|m4a}（ボイスメッセージ）も一致するが、これは正しい：
//     <audio> も Range で取りに行くため同じ 206 問題を抱えており、素通しが正解。
function isMediaUrl(url) {
    let path = url.pathname;
    try {
        path = decodeURIComponent(path);
    } catch (e) {
        // 不正なエスケープシーケンスはデコードせずそのまま判定（拡張子が拾えないだけ）
    }
    return /\.(mp4|m4v|mov|webm|ogv|m4a)$/i.test(path);
}

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

    // 🎬 #209⑦-3: 動画（メディア）は SW を素通りさせ、ブラウザに直接ネットワークへ行かせる。
    //   なぜ：<video> の progressive 再生でブラウザは Range ヘッダ付きで要求し、
    //   サーバは 206 Partial Content を返す。ところが下の stale-while-revalidate は
    //     ・206 をキャッシュしない（status === 200 のときだけ cache.put）＝毎回ネットワーク
    //     ・cache.match(request) は Range ヘッダを見ないため、過去に 200 で入ったフル
    //       レスポンスを Range 要求に返してしまう＝シークや再生が壊れる
    //   ＝ブラウザ本来の部分取得を SW が邪魔していた（#209⑦「黒いまま止まって見える」の一因）。
    //   早期 return すれば Range/206 がネイティブに効き、moov 先頭化（⑦-1）が初めて生きる。
    //   ⚠ 画像・JSON・HTML を巻き込まないこと（誤って除外するとオフライン動作や #69 の
    //     画像キャッシュ戦略が壊れる）。端末差があるので 1 つの判定に頼らず OR で見る。
    const isMediaRequest =
        event.request.destination === 'video'    // <video> 由来（主要ブラウザで利用可）
        || event.request.headers.has('range')    // Range 付き＝部分取得（destination 未対応端末の保険）
        || isMediaUrl(url);                      // 拡張子で判定（サムネ .jpg は対象外＝キャッシュ継続）

    if (isDynamicApi || isMediaRequest || event.request.method !== 'GET') {
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
