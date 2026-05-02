const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

initializeApp();
const db = getFirestore();

// ── やることリスト ヘルパー ─────────────────────────────────────
// todos/{uid}/items/{autoId} に open 状態で作成。type+orderId で重複回避。
async function createTodo(uid, type, orderId) {
  if (!uid || !type) return;
  // 既に同じ type + orderId の open があればスキップ
  const existing = await db.collection(`todos/${uid}/items`)
    .where('type', '==', type)
    .where('orderId', '==', orderId || null)
    .where('status', '==', 'open')
    .limit(1)
    .get();
  if (!existing.empty) return;
  const admin = require("firebase-admin/firestore");
  await db.collection(`todos/${uid}/items`).add({
    type,
    orderId: orderId || null,
    status: 'open',
    createdAt: admin.FieldValue.serverTimestamp(),
  });
  console.log('Todo created:', uid, type, orderId);
}

// 指定 type + orderId の open な todo を completed に
async function clearTodo(uid, type, orderId) {
  if (!uid || !type) return;
  const snap = await db.collection(`todos/${uid}/items`)
    .where('type', '==', type)
    .where('orderId', '==', orderId || null)
    .where('status', '==', 'open')
    .get();
  const admin = require("firebase-admin/firestore");
  const batch = db.batch();
  snap.forEach(d => batch.update(d.ref, {
    status: 'completed',
    completedAt: admin.FieldValue.serverTimestamp(),
  }));
  if (!snap.empty) {
    await batch.commit();
    console.log('Todos cleared:', uid, type, orderId, snap.size);
  }
}

// orderId で関連する open todo をすべて clear（役割別）
async function clearOrderTodos(uid, types, orderId) {
  for (const type of types) {
    await clearTodo(uid, type, orderId);
  }
}

// 指定 orderId に紐づく open な todo を type 問わず全て clear（辞退・完了時のクリーンアップ用）
async function clearAllTodosForOrder(uid, orderId) {
  if (!uid || !orderId) return;
  const snap = await db.collection(`todos/${uid}/items`)
    .where('orderId', '==', orderId)
    .where('status', '==', 'open')
    .get();
  if (snap.empty) return;
  const admin = require("firebase-admin/firestore");
  const batch = db.batch();
  snap.forEach(d => batch.update(d.ref, {
    status: 'completed',
    completedAt: admin.FieldValue.serverTimestamp(),
  }));
  await batch.commit();
  console.log('All todos cleared for order:', uid, orderId, snap.size);
}

// 管理者UID取得（全管理者）
// 4/29: コスト削減のため `settings/adminUids.uids[]` をキャッシュとして使用
//       キャッシュが存在しない場合のみ users をスキャンしてキャッシュを生成
let _adminUidsCache = null;
let _adminUidsCacheAt = 0;
const ADMIN_CACHE_TTL_MS = 10 * 60 * 1000; // 10分

async function getAdminUids() {
  // メモリキャッシュ（同じプロセス内）
  if (_adminUidsCache && Date.now() - _adminUidsCacheAt < ADMIN_CACHE_TTL_MS) {
    return _adminUidsCache;
  }
  // Firestore キャッシュ
  try {
    const cacheSnap = await db.doc('settings/adminUids').get();
    if (cacheSnap.exists) {
      const uids = Array.isArray(cacheSnap.data()?.uids) ? cacheSnap.data().uids : null;
      if (uids && uids.length > 0) {
        _adminUidsCache = uids;
        _adminUidsCacheAt = Date.now();
        return uids;
      }
    }
  } catch (e) { /* fallthrough to user scan */ }

  // フォールバック: users をスキャン
  const snap = await db.collection('users').where('role', '==', 'admin').get();
  const uids = snap.docs.map(d => d.id);
  // キャッシュを保存
  try {
    await db.doc('settings/adminUids').set({ uids, updatedAt: new Date() });
  } catch (e) { /* ignore */ }
  _adminUidsCache = uids;
  _adminUidsCacheAt = Date.now();
  return uids;
}

// ── 通知履歴 ヘルパー ─────────────────────────────────────────
// notifications/{uid}/items/{autoId} に履歴を保存。
// FCM 送信も同時に行う（token があれば）。クライアントはここから購読して表示。
// msgKey/vars を渡すと、クライアント側で言語切替時に動的に翻訳表示できる。
async function notifyUser(uid, { type, title, body, url, orderId, lang, msgKey, vars }) {
  if (!uid || !title) return;
  const admin = require("firebase-admin/firestore");

  // Firestore に保存（title/bodyは保存時点の言語で固定されるがフォールバック用）
  // msgKey/vars があれば、クライアントは言語切替に追従可能
  await db.collection(`notifications/${uid}/items`).add({
    type: type || 'general',
    title,
    body: body || '',
    msgKey: msgKey || null,
    vars: vars || null,
    url: url || null,
    orderId: orderId || null,
    read: false,
    createdAt: admin.FieldValue.serverTimestamp(),
  });

  // FCM 送信
  // 5/2: 複数端末対応 — fcmTokens（配列）+ レガシー fcmToken（単一）両方読んで重複排除
  try {
    const userSnap = await db.doc(`users/${uid}`).get();
    const data = userSnap.data() || {};
    const tokenSet = new Set();
    if (Array.isArray(data.fcmTokens)) {
      for (const t of data.fcmTokens) if (t) tokenSet.add(t);
    }
    if (data.fcmToken) tokenSet.add(data.fcmToken);
    const tokens = Array.from(tokenSet);
    if (tokens.length === 0) return;

    const messaging = getMessaging();
    const response = await messaging.sendEachForMulticast({
      tokens,
      data: {
        title, body: body || '',
        type: type || 'general',
        orderId: orderId || '',
        url: url || '',
      },
    });

    // 無効トークンを自動クリーンアップ（端末アンインストール・トークンローテーション後など）
    const invalidTokens = [];
    response.responses.forEach((r, i) => {
      if (!r.success && r.error) {
        const code = r.error.code || '';
        if (code === 'messaging/registration-token-not-registered'
          || code === 'messaging/invalid-registration-token'
          || code === 'messaging/invalid-argument') {
          invalidTokens.push(tokens[i]);
        }
      }
    });
    if (invalidTokens.length > 0) {
      const updates = {
        fcmTokens: admin.FieldValue.arrayRemove(...invalidTokens),
      };
      // レガシー単一フィールドが無効化されていればクリア
      if (data.fcmToken && invalidTokens.includes(data.fcmToken)) {
        updates.fcmToken = null;
      }
      try {
        await db.doc(`users/${uid}`).update(updates);
        console.log('Removed invalid FCM tokens:', uid, invalidTokens.length);
      } catch (e) { /* ignore — クリーンアップ失敗は致命的でない */ }
    }
  } catch (e) {
    console.error('notifyUser FCM failed:', uid, type, e);
  }
}

// ── 多言語メッセージ ──────────────────────────────────────────
// 各テンプレの title にも送信者名を含める（複数注文時の識別用）
const MESSAGES = {
  newOrder: {
    ja: { title: "{{restaurant}} から新しい注文", body: "{{fish}} {{qty}}kg\n納品：{{date}} {{time}}\n承認期限：{{deadline}}" },
    en: { title: "New order from {{restaurant}}", body: "{{fish}} {{qty}}kg\nDelivery: {{date}} {{time}}\nDeadline: {{deadline}}" },
    km: { title: "ការបញ្ជាទិញថ្មីពី {{restaurant}}", body: "{{fish}} {{qty}}kg\nដឹកជញ្ជូន: {{date}} {{time}}\nកំណត់ពេល: {{deadline}}" },
  },
  approved: {
    ja: { title: "{{farmer}} が注文を承認", body: "{{fish}} {{qty}}kg\n納品：{{date}} {{time}}" },
    en: { title: "{{farmer}} approved your order", body: "{{fish}} {{qty}}kg\nDelivery: {{date}} {{time}}" },
    km: { title: "{{farmer}} យល់ព្រមបញ្ជាទិញ", body: "{{fish}} {{qty}}kg\nដឹកជញ្ជូន: {{date}} {{time}}" },
  },
  declined: {
    ja: { title: "注文が辞退されました", body: "{{farmer}} {{fish}} {{qty}}kg\n別の魚を選んで再注文してください" },
    en: { title: "Your order was declined", body: "{{farmer}} {{fish}} {{qty}}kg\nPlease choose another fish and order again" },
    km: { title: "ការបញ្ជាទិញត្រូវបានបដិសេធ", body: "{{farmer}} {{fish}} {{qty}}kg\nសូមជ្រើសរើសត្រីផ្សេងទៀតដើម្បីបញ្ជាទិញម្ដងទៀត" },
  },
  expiredDeclinedFarmer: {
    ja: { title: "{{restaurant}} の注文が期限切れ辞退", body: "{{fish}} {{qty}}kg" },
    en: { title: "Order from {{restaurant}} auto-declined (expired)", body: "{{fish}} {{qty}}kg" },
    km: { title: "បញ្ជាទិញពី {{restaurant}} ហួសកំណត់ពេល", body: "{{fish}} {{qty}}kg" },
  },
  expiredDeclinedRestaurant: {
    ja: { title: "承認期限切れで注文が辞退されました", body: "{{farmer}} {{fish}} {{qty}}kg\n別の魚を選んで再注文してください" },
    en: { title: "Your order was auto-declined (expired)", body: "{{farmer}} {{fish}} {{qty}}kg\nPlease choose another fish and order again" },
    km: { title: "ការបញ្ជាទិញត្រូវបានបដិសេធដោយស្វ័យប្រវត្តិ (ហួសកំណត់ពេល)", body: "{{farmer}} {{fish}} {{qty}}kg\nសូមជ្រើសរើសត្រីផ្សេងទៀតដើម្បីបញ្ជាទិញម្ដងទៀត" },
  },
  statusUpdate: {
    ja: { title: "{{farmer}} 注文ステータス更新", body: "ステータス: {{status}}" },
    en: { title: "{{farmer}} order status updated", body: "Status: {{status}}" },
    km: { title: "{{farmer}} ស្ថានភាពបញ្ជាទិញបានផ្លាស់ប្ដូរ", body: "ស្ថានភាព: {{status}}" },
  },
  deliveryReminder: {
    ja: { title: "{{farmer}} の納品は明日", body: "{{fish}} {{qty}}kg\n納品：{{date}} {{time}}" },
    en: { title: "Delivery from {{farmer}} is tomorrow", body: "{{fish}} {{qty}}kg\nDelivery: {{date}} {{time}}" },
    km: { title: "ការដឹកជញ្ជូនពី {{farmer}} នៅថ្ងៃស្អែក", body: "{{fish}} {{qty}}kg\nដឹកជញ្ជូន: {{date}} {{time}}" },
  },
  adminReport: {
    ja: { title: "新しいトラブル報告", body: "{{fromRole}} → {{type}}\n{{reporter}}" },
    en: { title: "New trouble report", body: "{{fromRole}} → {{type}}\n{{reporter}}" },
    km: { title: "របាយការណ៍បញ្ហាថ្មី", body: "{{fromRole}} → {{type}}\n{{reporter}}" },
  },
  paymentDeadlineSet: {
    ja: { title: "{{farmer}} 配送完了。お支払いをお願いします", body: "{{deadline}}までにお支払いください" },
    en: { title: "Delivery completed by {{farmer}}. Please pay now", body: "Please pay by {{deadline}}" },
    km: { title: "{{farmer}} ដឹកជញ្ជូនរួចរាល់។ សូមបង់ប្រាក់", body: "សូមបង់ប្រាក់មុន {{deadline}}" },
  },
  paymentDeadlineExpired: {
    ja: { title: "支払期限が過ぎました", body: "{{farmer}} {{fish}} {{qty}}kg ({{orderNo}})\nお支払いをお願いします" },
    en: { title: "Payment deadline has passed", body: "{{farmer}} {{fish}} {{qty}}kg ({{orderNo}})\nPlease complete the payment" },
    km: { title: "ហួសកំណត់ពេលបង់ប្រាក់", body: "{{farmer}} {{fish}} {{qty}}kg ({{orderNo}})\nសូមបញ្ចប់ការបង់ប្រាក់" },
  },
  remitDone: {
    ja: { title: "ご入金がありました", body: "{{restaurant}} の注文 {{fish}} {{qty}}kg" },
    en: { title: "Payment received", body: "Order from {{restaurant}}: {{fish}} {{qty}}kg" },
    km: { title: "បានទទួលប្រាក់", body: "ការបញ្ជាទិញពី {{restaurant}}: {{fish}} {{qty}}kg" },
  },
  adminChat: {
    ja: { title: "運営からのメッセージ", body: "{{text}}" },
    en: { title: "Message from admin", body: "{{text}}" },
    km: { title: "សារពីរដ្ឋបាល", body: "{{text}}" },
  },
  adminChatFromUser: {
    ja: { title: "{{name}} からの問い合わせ", body: "{{text}}" },
    en: { title: "Inquiry from {{name}}", body: "{{text}}" },
    km: { title: "សំណើពី {{name}}", body: "{{text}}" },
  },
};

const REPORT_TYPE_LABELS = {
  shortage:      { ja: "数量不足", en: "Shortage", km: "បរិមាណខ្វះ" },
  quality:       { ja: "品質",     en: "Quality",  km: "គុណភាព" },
  delay:         { ja: "配送遅延", en: "Delay",    km: "យឺត" },
  reception:     { ja: "受取対応", en: "Reception", km: "ការទទួល" },
  communication: { ja: "やり取り", en: "Communication", km: "ទំនាក់ទំនង" },
  other:         { ja: "その他",   en: "Other",    km: "ផ្សេងទៀត" },
};
const REPORTER_ROLE_LABELS = {
  restaurant: { ja: "レストラン", en: "Restaurant", km: "ភោជនីយដ្ឋាន" },
  farmer:     { ja: "農家",       en: "Farmer",     km: "កសិករ" },
};

function getMessage(type, lang, vars) {
  const msgs = MESSAGES[type];
  const msg = msgs[lang] || msgs.en;
  let title = msg.title;
  let body = msg.body;
  for (const [key, val] of Object.entries(vars)) {
    title = title.replace(`{{${key}}}`, val);
    body = body.replace(`{{${key}}}`, val);
  }
  return { title, body };
}

// ── 取引番号採番（カンボジア時間 UTC+7 ベースの YYMMDD で日次カウンター）──
async function assignOrderNumber(orderRef, createdAtMs) {
  const admin = require("firebase-admin/firestore");
  // カンボジア時間（UTC+7）の YYMMDD
  const khm = new Date((createdAtMs || Date.now()) + 7 * 60 * 60 * 1000);
  const yy = String(khm.getUTCFullYear()).slice(-2);
  const mm = String(khm.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(khm.getUTCDate()).padStart(2, '0');
  const dateKey = `${yy}${mm}${dd}`;
  const counterRef = db.doc(`counters/orderNumber_${dateKey}`);

  let seq;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    seq = (snap.data()?.count || 0) + 1;
    tx.set(counterRef, { count: seq });
  });
  const orderNumber = `FL-${dateKey}-${String(seq).padStart(3, '0')}`;
  await orderRef.update({ orderNumber });
  return orderNumber;
}

// ── 注文作成時 → 農家に通知 ──────────────────────────────────
exports.onOrderCreated = onDocumentCreated(
  {
    document: "orders/{orderId}",
    region: "asia-southeast1",
    database: "(default)",
  },
  async (event) => {
    const order = event.data.data();
    const admin = require("firebase-admin/firestore");

    // 取引番号を採番（FL-YYMMDD-NNN）
    const createdAtMs = order.createdAt?.toMillis?.() || Date.now();
    const orderNumber = await assignOrderNumber(event.data.ref, createdAtMs);
    console.log("Order number assigned:", event.params.orderId, orderNumber);

    // 在庫減算：items[] があれば各item毎に、なければ legacy の listingId/quantity で
    const items = Array.isArray(order.items) && order.items.length > 0
      ? order.items
      : (order.listingId ? [{ listingId: order.listingId, quantity: order.quantity }] : []);
    for (const it of items) {
      if (!it.listingId || !it.quantity) continue;
      await db.doc(`fishListings/${it.listingId}`).update({
        stock: admin.FieldValue.increment(-it.quantity),
      });
      console.log("Stock decremented:", it.listingId, "-", it.quantity);
    }

    // 農家のやることリストに「承認・辞退」を追加
    await createTodo(order.farmerId, 'farmer_approve', event.params.orderId);

    const farmerSnap = await db.doc(`users/${order.farmerId}`).get();
    const farmerData = farmerSnap.data() || {};
    const restSnap = await db.doc(`users/${order.restaurantId}`).get();
    const restName = restSnap.data()?.displayName || "Restaurant";
    const lang = farmerData.lang || "en";

    // 魚種名・数量（複数itemなら1件目＋他n件を表記）
    let fishName = "";
    let qtyLabel = "";
    if (items.length > 0) {
      const first = items[0];
      fishName = first.snapFishType || "";
      if (!fishName && first.listingId) {
        const listingSnap = await db.doc(`fishListings/${first.listingId}`).get();
        fishName = listingSnap.data()?.fishType || "";
      }
      qtyLabel = String(first.quantity || "");
      if (items.length > 1) {
        qtyLabel += ` 他${items.length - 1}件`;
      }
    }

    // 承認期限（注文時刻 + 1時間、カンボジア時間UTC+7で表示）
    const createdAt = order.createdAt?.toDate?.() || new Date();
    const deadlineDate = new Date(createdAt.getTime() + 60 * 60 * 1000);
    const khmDeadline = new Date(deadlineDate.getTime() + 7 * 60 * 60 * 1000);
    const deadline = `${khmDeadline.getUTCHours()}:${String(khmDeadline.getUTCMinutes()).padStart(2, '0')}`;

    const vars = {
      restaurant: restName,
      fish: fishName,
      qty: qtyLabel,
      date: order.deliveryDate || "",
      time: order.deliveryTime || "",
      deadline,
    };
    const { title, body } = getMessage("newOrder", lang, vars);

    await notifyUser(order.farmerId, {
      type: "new_order",
      title, body,
      msgKey: "newOrder",
      vars,
      url: `/pages/farmer/orders.html#order-${event.params.orderId}`,
      orderId: event.params.orderId,
    });

    console.log("Notification sent to farmer:", order.farmerId, "lang:", lang);
  }
);

// ── 注文ステータス更新時 → レストランに通知 ────────────────────
exports.onOrderUpdated = onDocumentUpdated(
  {
    document: "orders/{orderId}",
    region: "asia-southeast1",
    database: "(default)",
  },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();
    const orderId = event.params.orderId;
    const admin = require("firebase-admin/firestore");

    const statusChanged = before.status !== after.status;
    const paymentChanged = before.paymentStatus !== after.paymentStatus;
    const adminChanged = before.adminStatus !== after.adminStatus;

    // ── やることリスト：ステータス遷移に応じて作成/解消 ──
    if (statusChanged) {
      // 承認 → 農家の承認待ち解消＋準備開始todo
      if (after.status === "approved") {
        await clearTodo(after.farmerId, 'farmer_approve', orderId);
        await createTodo(after.farmerId, 'farmer_prepare', orderId);
      }
      // 辞退 → 農家・レストラン側の関連todoを全て解消
      if (after.status === "declined") {
        await clearAllTodosForOrder(after.farmerId, orderId);
        await clearAllTodosForOrder(after.restaurantId, orderId);
      }
      // 準備中 → 準備todo解消＋配送todo作成
      if (after.status === "preparing") {
        await clearTodo(after.farmerId, 'farmer_prepare', orderId);
        await createTodo(after.farmerId, 'farmer_deliver', orderId);
      }
      // 配送中 → 配送todo解消＋配送完了todo作成
      if (after.status === "delivering") {
        await clearTodo(after.farmerId, 'farmer_deliver', orderId);
        await createTodo(after.farmerId, 'farmer_complete_delivery', orderId);
      }
      // 配送完了（completed）→ 農家todo解消＋レストラン支払todo作成＋支払期限設定＋通知
      // 4/28: delivered ステータスを廃止。農家の「配送完了」で直接 completed に遷移
      // 通知は2本: ①paymentDeadlineSet（即時・「HH:MMまでに支払って」）+
      //          ②paymentDeadlineExpired（期限超過後・「期限が過ぎました」）
      if (after.status === "completed") {
        await clearTodo(after.farmerId, 'farmer_complete_delivery', orderId);
        // 5/2: 配送完了後はチャット入力が UI 上隠れるため、
        // 「メッセージが届いています」reply todo は両者ともクリア（残り続けるバグ修正）
        await clearTodo(after.farmerId, 'farmer_reply', orderId);
        await clearTodo(after.restaurantId, 'rest_reply', orderId);
        await createTodo(after.restaurantId, 'rest_pay', orderId);

        // paymentDeadline = 配送完了時刻 + 10分（既にセット済みならスキップ）
        if (!after.paymentDeadline) {
          const now = new Date();
          const deadline = new Date(now.getTime() + 10 * 60 * 1000);
          await event.data.after.ref.update({
            paymentDeadline: deadline,
            paymentReminderSent: false,
          });

          // ①即時通知：「HH:MMまでにお支払いください」（カンボジア時間 UTC+7）
          const khm = new Date(deadline.getTime() + 7 * 60 * 60 * 1000);
          const deadlineStr = `${khm.getUTCHours()}:${String(khm.getUTCMinutes()).padStart(2, '0')}`;
          const restSnap2 = await db.doc(`users/${after.restaurantId}`).get();
          const lang2 = restSnap2.data()?.lang || "en";
          const farmerSnap2 = await db.doc(`users/${after.farmerId}`).get();
          const farmerName2 = farmerSnap2.data()?.displayName || "Farmer";
          const payVars = { deadline: deadlineStr, farmer: farmerName2 };
          const { title, body } = getMessage("paymentDeadlineSet", lang2, payVars);
          await notifyUser(after.restaurantId, {
            type: "payment_deadline_set",
            title, body,
            msgKey: "paymentDeadlineSet", vars: payVars,
            url: `/pages/restaurant/payment.html?id=${orderId}`,
            orderId,
          });
        }
      }
    }

    if (paymentChanged && after.paymentStatus === "paid") {
      // 支払todo解消＋管理者「入金確認」todo作成
      await clearTodo(after.restaurantId, 'rest_pay', orderId);
      const adminUids = await getAdminUids();
      for (const auid of adminUids) {
        await createTodo(auid, 'admin_verify_payment', orderId);
      }
    }

    if (adminChanged) {
      const adminUids = await getAdminUids();
      if (after.adminStatus === "payment_confirmed") {
        for (const auid of adminUids) {
          await clearTodo(auid, 'admin_verify_payment', orderId);
          await createTodo(auid, 'admin_remit', orderId);
        }
      }
      if (after.adminStatus === "remitted") {
        for (const auid of adminUids) {
          await clearTodo(auid, 'admin_remit', orderId);
          await createTodo(auid, 'admin_done', orderId);
        }
        // 送金完了時に両者にレビューtodo作成（既にレビュー済みの場合はスキップ）
        // 5/1: 取引完了前にレビュー投稿済みのケースで todo が残らないよう対応
        const farmerReviewSnap = await db.doc(`orders/${orderId}/reviews/farmer`).get();
        if (!farmerReviewSnap.exists) {
          await createTodo(after.farmerId, 'farmer_review', orderId);
        }
        const restReviewSnap = await db.doc(`orders/${orderId}/reviews/restaurant`).get();
        if (!restReviewSnap.exists) {
          await createTodo(after.restaurantId, 'rest_review', orderId);
        }

        // 4/28: 農家へ「ご入金がありました」FCM通知（既存ロジックでは抜けていた）
        try {
          const farmerSnap = await db.doc(`users/${after.farmerId}`).get();
          const farmerLang = farmerSnap.data()?.lang || "en";
          const restSnap = await db.doc(`users/${after.restaurantId}`).get();
          const restName = restSnap.data()?.displayName || "Restaurant";

          // 魚種名・数量（items[]対応・複数なら「他n件」表記）
          const remitItems = Array.isArray(after.items) && after.items.length > 0
            ? after.items
            : (after.listingId ? [{ listingId: after.listingId, quantity: after.quantity, snapFishType: after.snapFishType }] : []);
          const remitFirst = remitItems[0] || {};
          let remitFishName = remitFirst.snapFishType || after.snapFishType || "";
          if (!remitFishName && remitFirst.listingId) {
            const lSnap = await db.doc(`fishListings/${remitFirst.listingId}`).get();
            remitFishName = lSnap.data()?.fishType || "";
          }
          const remitQtyLabel = remitItems.length > 1
            ? `${remitFirst.quantity || ""} 他${remitItems.length - 1}件`
            : String(remitFirst.quantity || after.quantity || "");

          const remitVars = { restaurant: restName, fish: remitFishName, qty: remitQtyLabel };
          const { title, body } = getMessage("remitDone", farmerLang, remitVars);
          await notifyUser(after.farmerId, {
            type: "remit_done",
            title, body,
            msgKey: "remitDone", vars: remitVars,
            url: `/pages/farmer/payment.html?id=${orderId}`,
            orderId,
          });
        } catch (e) {
          console.warn("remitDone notification failed:", e.message);
        }
      }
      if (after.adminStatus === "done") {
        for (const auid of adminUids) {
          await clearTodo(auid, 'admin_done', orderId);
        }
      }
    }

    if (!statusChanged) return;

    // 辞退時：在庫復元（自動辞退は autoDeclineExpiredOrders 内で復元済みのためスキップ）
    if (after.status === "declined" && after.autoDeclined !== true) {
      const items = Array.isArray(after.items) && after.items.length > 0
        ? after.items
        : (after.listingId ? [{ listingId: after.listingId, quantity: after.quantity }] : []);
      for (const it of items) {
        if (!it.listingId || !it.quantity) continue;
        await db.doc(`fishListings/${it.listingId}`).update({
          stock: admin.FieldValue.increment(it.quantity),
        });
        console.log("Stock restored:", it.listingId, "+", it.quantity);
      }
    }

    // 期限切れ自動辞退は autoDeclineExpiredOrders 内で両者に通知するため、ここではスキップ
    if (after.status === "declined" && after.autoDeclined === true) {
      console.log("Skip onOrderUpdated notify: auto-declined order", orderId);
      return;
    }

    const restSnap = await db.doc(`users/${after.restaurantId}`).get();
    const restData = restSnap.data() || {};
    const farmerSnap = await db.doc(`users/${after.farmerId}`).get();
    const farmerName = farmerSnap.data()?.displayName || "Farmer";
    const lang = restData.lang || "en";

    // 魚種名・数量（items[]対応・複数なら「他n件」表記）
    const afterItems = Array.isArray(after.items) && after.items.length > 0
      ? after.items
      : (after.listingId ? [{ listingId: after.listingId, quantity: after.quantity, snapFishType: after.snapFishType }] : []);
    const firstItem = afterItems[0] || {};
    let fishName = firstItem.snapFishType || after.snapFishType || "";
    if (!fishName && firstItem.listingId) {
      const listingSnap = await db.doc(`fishListings/${firstItem.listingId}`).get();
      fishName = listingSnap.data()?.fishType || "";
    }
    const qtyLabel = afterItems.length > 1
      ? `${firstItem.quantity || ""} 他${afterItems.length - 1}件`
      : String(firstItem.quantity || after.quantity || "");

    // preparing/delivering/completed は農家のクイック操作で必ずチャットメッセージが
    // 同時送信されるため、ここでの statusUpdate 通知は重複となり省略する。
    // （completed は paymentDeadlineSet 通知も別途飛ぶ）
    if (!["approved", "declined"].includes(after.status)) {
      console.log("Skip statusUpdate notification (chat covers it):", orderId, after.status);
      return;
    }

    const vars = {
      farmer: farmerName,
      fish: fishName,
      qty: qtyLabel,
      date: after.deliveryDate || "",
      time: after.deliveryTime || "",
      status: after.status,
    };

    const type = after.status; // "approved" or "declined"
    const { title, body } = getMessage(type, lang, vars);

    await notifyUser(after.restaurantId, {
      type: `order_${after.status}`,
      title, body,
      url: "/pages/restaurant/orders.html",
      msgKey: type,
      vars,
      orderId,
    });

    console.log("Notification sent to restaurant:", after.restaurantId, "status:", after.status, "lang:", lang);
  }
);

// ── チャットメッセージ送信時 → 相手に通知 ──────────────────────
const CHAT_MESSAGES = {
  ja: { title: "{{sender}} からメッセージ", body: "{{text}}" },
  en: { title: "Message from {{sender}}", body: "{{text}}" },
  km: { title: "សារពី {{sender}}", body: "{{text}}" },
};

exports.onMessageCreated = onDocumentCreated(
  {
    document: "orders/{orderId}/messages/{messageId}",
    region: "asia-southeast1",
    database: "(default)",
  },
  async (event) => {
    const msg = event.data.data();
    const orderId = event.params.orderId;

    // 5/2: システム自動メッセージ（type: 'status'）は通知・todo化対象外
    // 例：配送完了時の "配送完了しました"。チャット履歴上の表示のみ。
    // status 変更による FCM は別経路（onOrderUpdated → notifyUser）で送られる
    if (msg.type === 'status') return;

    const orderSnap = await db.doc(`orders/${orderId}`).get();
    if (!orderSnap.exists) return;
    const order = orderSnap.data();

    // 送信先を特定（送信者の相手）
    const toUid = msg.senderId === order.farmerId ? order.restaurantId : order.farmerId;
    const senderIsFarmer = msg.senderId === order.farmerId;

    // やることリスト：送信者は返信todo解消、受信者に返信todo作成
    const senderReplyTodoType = senderIsFarmer ? 'farmer_reply' : 'rest_reply';
    const recipientReplyTodoType = senderIsFarmer ? 'rest_reply' : 'farmer_reply';
    await clearTodo(msg.senderId, senderReplyTodoType, orderId);
    await createTodo(toUid, recipientReplyTodoType, orderId);

    const toSnap = await db.doc(`users/${toUid}`).get();
    const toData = toSnap.data() || {};
    const senderSnap = await db.doc(`users/${msg.senderId}`).get();
    const senderName = senderSnap.data()?.displayName || "";
    const lang = toData.lang || "en";

    const tmpl = CHAT_MESSAGES[lang] || CHAT_MESSAGES.en;
    const truncText = (msg.text || "").substring(0, 50);
    const title = tmpl.title.replace("{{sender}}", senderName);
    const body = tmpl.body.replace("{{sender}}", senderName).replace("{{text}}", truncText);

    const isFarmer = toUid === order.farmerId;
    const chatUrl = isFarmer
      ? `/pages/farmer/delivery.html?id=${orderId}`
      : `/pages/restaurant/delivery.html?id=${orderId}`;

    await notifyUser(toUid, {
      type: "chat_message",
      title, body,
      msgKey: "chatMessage",
      vars: { sender: senderName, text: truncText },
      url: chatUrl,
      orderId,
    });

    console.log("Chat notification sent to:", toUid);
  }
);

// 期限切れ注文を辞退処理（ステータス更新／在庫復元／todo解消／農家・レストラン通知まで一括）
async function autoDeclineOrder(orderDoc, reason = "承認期限切れによる自動辞退") {
  const admin = require("firebase-admin/firestore");
  const order = orderDoc.data();
  const orderId = orderDoc.id;

  // すでに declined 済みならスキップ（冪等性）
  if (order.status === "declined") return;

  // ステータスを declined に変更（autoDeclined フラグで通知経路を分岐）
  await orderDoc.ref.update({
    status: "declined",
    declineReason: reason,
    autoDeclined: true,
  });

  // 在庫復元（items[] 対応）
  const items = Array.isArray(order.items) && order.items.length > 0
    ? order.items
    : (order.listingId ? [{ listingId: order.listingId, quantity: order.quantity }] : []);
  for (const it of items) {
    if (!it.listingId || !it.quantity) continue;
    await db.doc(`fishListings/${it.listingId}`).update({
      stock: admin.FieldValue.increment(it.quantity),
    });
  }

  // 農家側・レストラン側の関連todoを全て解消（念のため type 問わず）
  await clearAllTodosForOrder(order.farmerId, orderId);
  await clearAllTodosForOrder(order.restaurantId, orderId);

  // 魚種名（snap優先。複数itemなら1件目 + 他n件）
  const firstItem = items[0] || {};
  let fishName = firstItem.snapFishType || order.snapFishType || "";
  if (!fishName && firstItem.listingId) {
    const listingSnap = await db.doc(`fishListings/${firstItem.listingId}`).get();
    fishName = listingSnap.data()?.fishType || "";
  }
  const qtyLabel = items.length > 1
    ? `${firstItem.quantity || ""} 他${items.length - 1}件`
    : String(firstItem.quantity || order.quantity || "");

  // ユーザー情報
  const [farmerSnap, restSnap] = await Promise.all([
    db.doc(`users/${order.farmerId}`).get(),
    db.doc(`users/${order.restaurantId}`).get(),
  ]);
  const farmerData = farmerSnap.data() || {};
  const restData = restSnap.data() || {};
  const farmerName = farmerData.displayName || "Farmer";
  const restName = restData.displayName || "Restaurant";

  // 農家へ通知（通知履歴 + FCM）
  {
    const vars = { restaurant: restName, fish: fishName, qty: qtyLabel };
    const { title, body } = getMessage("expiredDeclinedFarmer", farmerData.lang || "en", vars);
    await notifyUser(order.farmerId, {
      type: "order_expired_declined",
      title, body,
      msgKey: "expiredDeclinedFarmer", vars,
      url: "/pages/farmer/orders.html",
      orderId,
    });
  }

  // レストランへ通知
  {
    const vars = { farmer: farmerName, fish: fishName, qty: qtyLabel };
    const { title, body } = getMessage("expiredDeclinedRestaurant", restData.lang || "en", vars);
    await notifyUser(order.restaurantId, {
      type: "order_expired_declined",
      title, body,
      msgKey: "expiredDeclinedRestaurant", vars,
      url: "/pages/restaurant/orders.html",
      orderId,
    });
  }

  console.log("Auto-declined expired order:", orderId);
}

// ── 期限切れ注文の自動辞退（5分ごとにチェック） ──────────────
exports.autoDeclineExpiredOrders = onSchedule(
  { schedule: "every 5 minutes", region: "asia-southeast1" },
  async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    let snap;
    try {
      snap = await db.collection("orders")
        .where("status", "==", "pending")
        .where("createdAt", "<", oneHourAgo)
        .get();
    } catch (e) {
      console.warn("autoDeclineExpiredOrders query failed:", e.message);
      return;
    }

    if (snap.empty) {
      console.log("No expired orders");
      return;
    }

    for (const doc of snap.docs) {
      await autoDeclineOrder(doc);
    }
  }
);

// ── 孤立 todo クリーンアップ（1時間ごと）──
// 4/29: コスト削減のため5分→1時間へ。autoDeclineExpiredOrders から分離
exports.sweepOrphanTodosHourly = onSchedule(
  { schedule: "every 60 minutes", region: "asia-southeast1" },
  async () => {
    await sweepOrphanTodos();
  }
);

// 5/2: 即時クリーンアップ用（管理者専用 callable）
// 1時間スケジュールを待たずに今すぐ古い todo を掃除したい時に呼ぶ
exports.runSweepOrphanTodos = onCall(
  { region: "asia-southeast1", invoker: "public", cors: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }
    const userSnap = await db.doc(`users/${request.auth.uid}`).get();
    if (userSnap.data()?.role !== "admin") {
      throw new HttpsError("permission-denied", "Admin role required");
    }
    await sweepOrphanTodos();
    return { ok: true };
  }
);

// todoのtype → 対象orderが取りうるべき order.status のセット
// （下記以外の status の場合、その todo は孤立として扱って閉じる）
// 4/28: delivered ステータスは廃止し completed に統合済み
const TODO_VALID_STATUSES = {
  farmer_approve: ['pending'],
  farmer_prepare: ['approved'],
  farmer_deliver: ['preparing'],
  farmer_complete_delivery: ['delivering'],
  rest_pay: ['completed'],
  farmer_review: ['completed'],
  rest_review: ['completed'],
  // 5/2: completed ではチャット入力が UI 上隠れるため reply todo は無効
  farmer_reply: ['pending', 'approved', 'preparing', 'delivering'],
  rest_reply: ['pending', 'approved', 'preparing', 'delivering'],
};

async function sweepOrphanTodos() {
  const admin = require("firebase-admin/firestore");

  // STEP 1: autoDecline がまだ走っていない期限切れ pending 注文をここで辞退させる
  // （scheduled function が失敗している場合のフォールバック。通知も忘れずに送る）
  try {
    const pendingSnap = await db.collection("orders")
      .where("status", "==", "pending")
      .get();
    const oneHourAgoMs = Date.now() - 60 * 60 * 1000;
    for (const orderDoc of pendingSnap.docs) {
      const order = orderDoc.data();
      const createdAtMs = order.createdAt?.toMillis?.() || 0;
      if (createdAtMs === 0 || createdAtMs > oneHourAgoMs) continue;
      await autoDeclineOrder(orderDoc, "承認期限切れによる自動辞退（スイープ）");
    }
  } catch (e) {
    console.warn('Sweep: expired pending decline failed:', e.message);
  }

  // STEP 2: 農家・レストラン両方のユーザーの todo を走査
  const userSnap = await db.collection('users')
    .where('role', 'in', ['farmer', 'restaurant'])
    .get();

  let count = 0;
  for (const userDoc of userSnap.docs) {
    const uid = userDoc.id;
    const todosSnap = await db.collection(`todos/${uid}/items`)
      .where('status', '==', 'open')
      .get();

    for (const todoDoc of todosSnap.docs) {
      const todo = todoDoc.data();
      if (!todo.type) continue;
      const validStatuses = TODO_VALID_STATUSES[todo.type];

      let shouldClear = false;

      // 5/2: TODO_VALID_STATUSES に無い type（廃止された rest_receive など）は孤立扱いで削除
      if (!validStatuses) {
        shouldClear = true;
      } else if (!todo.orderId) {
        shouldClear = true;
      } else {
        const orderSnap = await db.doc(`orders/${todo.orderId}`).get();
        if (!orderSnap.exists) {
          shouldClear = true;
        } else {
          const orderStatus = orderSnap.data().status;
          shouldClear = orderStatus === 'declined' || !validStatuses.includes(orderStatus);
        }
      }

      // フォールバック: farmer_approve は承認期限 60 分なので、90 分以上経った open todo は孤立扱い
      if (!shouldClear && todo.type === 'farmer_approve' && todo.createdAt) {
        const todoAgeMs = Date.now() - todo.createdAt.toMillis();
        if (todoAgeMs > 90 * 60 * 1000) {
          shouldClear = true;
        }
      }

      if (shouldClear) {
        await todoDoc.ref.update({
          status: 'completed',
          completedAt: admin.FieldValue.serverTimestamp(),
        });
        count++;
      }
    }
  }
  if (count > 0) console.log('Orphan todos swept:', count);
}

// ── レビュー作成時：対象ユーザーの「よい率」(0-100) / reviewCount / サブ評価 を更新 ──
// 4/29: 5段階評価から2段階評価（good/bad）に変更。
//   avgRating: そのまま流用するが「よい率（0-100）」の意味に変更
//   subRatings: 各項目の good 数 / total 数を保持
exports.onReviewCreated = onDocumentCreated(
  {
    document: "orders/{orderId}/reviews/{reviewId}",
    region: "asia-southeast1",
    database: "(default)",
  },
  async (event) => {
    const review = event.data.data();
    const toUid = review.toUid;
    const fromRole = review.fromRole; // 'restaurant' → 農家を評価 / 'farmer' → レストランを評価
    if (!toUid || !review.verdict) return;

    const userRef = db.doc(`users/${toUid}`);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const prev = snap.data() || {};
      const prevCount = Number(prev.reviewCount || 0);
      // 既存の avgRating は new 集計では「good 数」として再計算（既存値は捨て、count から逆算）
      // ※ 新スキーマ前提: subRatings.overall = { good: n, total: n }
      const prevSubRatings = prev.subRatings || {};
      const prevOverallGood = Number(prevSubRatings?.overall?.good || 0);

      const isGoodOverall = review.verdict === 'good';
      const newOverallGood = prevOverallGood + (isGoodOverall ? 1 : 0);
      const newCount = prevCount + 1;
      const newGoodRate = Math.round((newOverallGood / newCount) * 100);

      // 各サブ項目の集計
      const subKeys = fromRole === "restaurant"
        ? ["quality", "time"]
        : ["communication", "reception"];
      const newSub = { overall: { good: newOverallGood, total: newCount } };
      for (const key of subKeys) {
        const prevGood = Number(prevSubRatings?.[key]?.good || 0);
        const prevTotal = Number(prevSubRatings?.[key]?.total || 0);
        const v = review.subVerdicts?.[key];
        newSub[key] = {
          good: prevGood + (v === 'good' ? 1 : 0),
          total: prevTotal + 1,
        };
      }

      tx.update(userRef, {
        reviewCount: newCount,
        avgRating: newGoodRate, // 0-100 の「よい率」
        subRatings: newSub,
      });
    });

    // レビュー投稿者のレビューtodo解消
    const reviewerTodoType = fromRole === 'farmer' ? 'farmer_review' : 'rest_review';
    await clearTodo(review.fromUid, reviewerTodoType, event.params.orderId);

    console.log("Review aggregated for user:", toUid, "verdict:", review.verdict);
  }
);

// ── 支払期限切れ催促（5分ごとに監視） ──
// status === 'completed' && paymentStatus !== 'paid' && paymentDeadline 経過済み
// && paymentReminderSent !== true の注文に対し、レストランへ催促通知を送る
// ※ ステータス自動変更はしない（催促のみ）
exports.checkPaymentDeadlineExpired = onSchedule(
  // 10分の支払期限に対し、最遅でも+5分で催促が飛ぶように 5分間隔
  { schedule: "every 5 minutes", region: "asia-southeast1" },
  async () => {
    const now = new Date();
    let snap;
    try {
      snap = await db.collection("orders")
        .where("status", "==", "completed")
        .where("paymentDeadline", "<", now)
        .get();
    } catch (e) {
      // 失敗の99%は複合インデックス未作成。Firebase 管理コンソールに作成リンクが出る
      console.error("[checkPaymentDeadlineExpired] query failed (likely missing composite index status==+paymentDeadline<):", e.message);
      return;
    }
    console.log(`[checkPaymentDeadlineExpired] candidates: ${snap.size}`);
    if (snap.empty) return;

    for (const d of snap.docs) {
      const order = d.data();
      if (order.paymentStatus === "paid") continue;
      if (order.paymentReminderSent === true) continue;

      // 重複防止フラグを先に立てる
      await d.ref.update({ paymentReminderSent: true });

      const restSnap = await db.doc(`users/${order.restaurantId}`).get();
      const lang = restSnap.data()?.lang || "en";
      const farmerSnap = await db.doc(`users/${order.farmerId}`).get();
      const farmerName = farmerSnap.data()?.displayName || "Farmer";

      // 注文識別用の情報（魚種・数量・取引番号）
      const itemsArr = Array.isArray(order.items) && order.items.length > 0
        ? order.items
        : (order.listingId ? [{ listingId: order.listingId, quantity: order.quantity, snapFishType: order.snapFishType }] : []);
      const firstItem = itemsArr[0] || {};
      let fishName = firstItem.snapFishType || order.snapFishType || "";
      if (!fishName && firstItem.listingId) {
        const lSnap = await db.doc(`fishListings/${firstItem.listingId}`).get();
        fishName = lSnap.data()?.fishType || "";
      }
      const qtyLabel = itemsArr.length > 1
        ? `${firstItem.quantity || ""} 他${itemsArr.length - 1}件`
        : String(firstItem.quantity || order.quantity || "");

      const vars = {
        farmer: farmerName,
        fish: fishName,
        qty: qtyLabel,
        orderNo: order.orderNumber || d.id.slice(-6).toUpperCase(),
      };
      const { title, body } = getMessage("paymentDeadlineExpired", lang, vars);
      await notifyUser(order.restaurantId, {
        type: "payment_deadline_expired",
        title, body,
        msgKey: "paymentDeadlineExpired", vars,
        url: `/pages/restaurant/payment.html?id=${d.id}`,
        orderId: d.id,
      });
      console.log("Payment deadline expired reminder sent:", d.id);
    }
  }
);

// ── 納品前日リマインド（毎日18:00 カンボジア時間 = 11:00 UTC） ──
exports.remindUpcomingDeliveries = onSchedule(
  {
    schedule: "0 11 * * *",
    timeZone: "UTC",
    region: "asia-southeast1",
  },
  async () => {
    // カンボジア時間（UTC+7）での翌日のYYYY-MM-DDを算出
    const now = new Date();
    const khmNow = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    const khmTomorrow = new Date(khmNow.getTime() + 24 * 60 * 60 * 1000);
    const yyyy = khmTomorrow.getUTCFullYear();
    const mm = String(khmTomorrow.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(khmTomorrow.getUTCDate()).padStart(2, "0");
    const tomorrowIso = `${yyyy}-${mm}-${dd}`;

    // 翌日納品・かつ進行中ステータスの注文を取得
    const snap = await db.collection("orders")
      .where("deliveryDateIso", "==", tomorrowIso)
      .where("status", "in", ["approved", "preparing"])
      .get();

    if (snap.empty) {
      console.log("No upcoming deliveries for", tomorrowIso);
      return;
    }

    for (const d of snap.docs) {
      const order = d.data();

      const [restSnap, farmerSnap] = await Promise.all([
        db.doc(`users/${order.restaurantId}`).get(),
        db.doc(`users/${order.farmerId}`).get(),
      ]);
      const restData = restSnap.data() || {};
      const farmerData = farmerSnap.data() || {};

      // 魚種名・数量（items[]対応）
      const items = Array.isArray(order.items) && order.items.length > 0
        ? order.items
        : (order.listingId ? [{ listingId: order.listingId, quantity: order.quantity, snapFishType: order.snapFishType }] : []);
      const firstItem = items[0] || {};
      let fishName = firstItem.snapFishType || order.snapFishType || "";
      if (!fishName && firstItem.listingId) {
        const listingSnap = await db.doc(`fishListings/${firstItem.listingId}`).get();
        fishName = listingSnap.data()?.fishType || "";
      }
      const qtyLabel = items.length > 1
        ? `${firstItem.quantity || ""} 他${items.length - 1}件`
        : String(firstItem.quantity || order.quantity || "");

      const remindVars = {
        farmer: farmerData.displayName || "",
        fish: fishName,
        qty: qtyLabel,
        date: order.deliveryDate || "",
        time: order.deliveryTime || "",
      };
      const { title, body } = getMessage("deliveryReminder", restData.lang || "en", remindVars);

      await notifyUser(order.restaurantId, {
        type: "delivery_reminder",
        title, body,
        msgKey: "deliveryReminder", vars: remindVars,
        url: `/pages/restaurant/delivery.html?id=${d.id}`,
        orderId: d.id,
      });
      console.log("Delivery reminder sent:", d.id);
    }
  }
);

// ── トラブル報告作成時：管理者全員に通知＋todo作成 ──────────────
exports.onReportCreated = onDocumentCreated(
  {
    document: "reports/{reportId}",
    region: "asia-southeast1",
    database: "(default)",
  },
  async (event) => {
    const report = event.data.data();
    const reportId = event.params.reportId;
    const fromRole = report.fromRole || "restaurant";
    const type = report.type || "other";

    // 報告者名
    let reporterName = "";
    if (report.fromUid) {
      const fromSnap = await db.doc(`users/${report.fromUid}`).get();
      reporterName = fromSnap.data()?.displayName || "";
    }

    const adminUids = await getAdminUids();
    for (const auid of adminUids) {
      // admin_report todo を作成（orderId 紐付き）
      await createTodo(auid, 'admin_report', report.orderId || reportId);

      const adminSnap = await db.doc(`users/${auid}`).get();
      const lang = adminSnap.data()?.lang || "en";
      const typeLabel = (REPORT_TYPE_LABELS[type] || {})[lang] || type;
      const roleLabel = (REPORTER_ROLE_LABELS[fromRole] || {})[lang] || fromRole;

      const reportVars = {
        fromRole: roleLabel,
        type: typeLabel,
        reporter: reporterName,
      };
      const { title, body } = getMessage("adminReport", lang, reportVars);

      await notifyUser(auid, {
        type: "admin_report",
        title, body,
        msgKey: "adminReport", vars: reportVars,
        url: `/pages/admin/reports.html#report-${reportId}`,
        orderId: report.orderId || null,
      });
    }

    console.log("Report notification sent to admins:", reportId, "admins:", adminUids.length);
  }
);

// ── トラブル報告更新時：resolved になったら管理者todoを解消 ──
exports.onReportUpdated = onDocumentUpdated(
  {
    document: "reports/{reportId}",
    region: "asia-southeast1",
    database: "(default)",
  },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();
    if (before.status === after.status) return;
    if (after.status !== "resolved") return;

    const orderIdOrReport = after.orderId || event.params.reportId;
    const adminUids = await getAdminUids();
    for (const auid of adminUids) {
      await clearTodo(auid, 'admin_report', orderIdOrReport);
    }
    console.log("Report resolved, todos cleared:", event.params.reportId);
  }
);

// ── 一時マイグレーション: 既存の delivered → completed に変換（管理者のみ） ──
// 4/28 の status フロー変更に伴う一回限りの移行用。実行後は本関数は削除可
exports.migrateDeliveredToCompleted = onCall(
  {
    region: "asia-southeast1",
    invoker: "public",
    cors: true,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }
    const userSnap = await db.doc(`users/${request.auth.uid}`).get();
    if (userSnap.data()?.role !== "admin") {
      throw new HttpsError("permission-denied", "Admin role required");
    }

    const snap = await db.collection("orders").where("status", "==", "delivered").get();
    if (snap.empty) return { migrated: 0 };

    const batch = db.batch();
    snap.forEach(d => batch.update(d.ref, { status: "completed" }));
    await batch.commit();

    return { migrated: snap.size };
  }
);

// ── Cloud Vision API 経由の画像OCR（CAA価格表取り込み用） ──
// クライアントは base64 文字列を渡し、抽出テキストを受け取る
// 管理者のみ呼び出し可能
exports.ocrImage = onCall(
  {
    region: "asia-southeast1",
    memory: "512MiB",
    timeoutSeconds: 60,
    invoker: "public",
    cors: true,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }
    // 管理者ロールチェック
    const userSnap = await db.doc(`users/${request.auth.uid}`).get();
    if (userSnap.data()?.role !== "admin") {
      throw new HttpsError("permission-denied", "Admin role required");
    }

    const { imageBase64 } = request.data || {};
    if (!imageBase64 || typeof imageBase64 !== "string") {
      throw new HttpsError("invalid-argument", "imageBase64 is required");
    }

    try {
      const { ImageAnnotatorClient } = require("@google-cloud/vision");
      const client = new ImageAnnotatorClient();
      const [result] = await client.documentTextDetection({
        image: { content: imageBase64 },
      });
      const text = result.fullTextAnnotation?.text || "";
      return { text };
    } catch (err) {
      console.error("Vision OCR failed:", err);
      throw new HttpsError("internal", err.message || "OCR failed");
    }
  }
);

// ── CAA価格表抽出（Gemini 2.5 Flash・管理者専用 callable） ─────────────
// 画像から表構造を理解してJSONで返す。空セル(†)は entries に含めない。
// 入力: { images: [{ mimeType: string, data: base64string }, ...] }
// 出力: { entries: [{ province, fishType, rangeMin, rangeMax, sizeMin, sizeMax }, ...] }
exports.extractCaaPrices = onCall(
  {
    region: "asia-southeast1",
    memory: "512MiB",
    timeoutSeconds: 180,
    invoker: "public",
    cors: true,
    secrets: ["GEMINI_API_KEY"],
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }
    const userSnap = await db.doc(`users/${request.auth.uid}`).get();
    if (userSnap.data()?.role !== "admin") {
      throw new HttpsError("permission-denied", "Admin role required");
    }

    const { images } = request.data || {};
    if (!Array.isArray(images) || images.length === 0) {
      throw new HttpsError("invalid-argument", "images array is required");
    }

    const PROVINCES = [
      "Kandal", "Takeo", "Prey Veng", "Kg. Cham", "Kg. Thom",
      "Siemreap", "Battambang", "Pursat", "Kg. Chhnang", "BMC",
    ];
    const FISH_TYPES = [
      "striped_snakehead", "walking_catfish", "red_tilapia", "nile_tilapia",
      "silver_barb", "spot_pangasius", "pangasius", "giant_snakehead",
      "climbing_perch", "frog",
    ];

    try {
      const { GoogleGenAI, Type } = await import("@google/genai");
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new HttpsError("failed-precondition", "GEMINI_API_KEY secret is not configured");
      }
      const ai = new GoogleGenAI({ apiKey });

      const schema = {
        type: Type.OBJECT,
        properties: {
          entries: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                province: { type: Type.STRING, enum: PROVINCES },
                fishType: { type: Type.STRING, enum: FISH_TYPES },
                rangeMin: { type: Type.NUMBER },
                rangeMax: { type: Type.NUMBER },
                sizeMin: { type: Type.NUMBER },
                sizeMax: { type: Type.NUMBER },
              },
              required: ["province", "fishType", "rangeMin", "rangeMax", "sizeMin", "sizeMax"],
              propertyOrdering: ["province", "fishType", "rangeMin", "rangeMax", "sizeMin", "sizeMax"],
            },
          },
        },
        required: ["entries"],
      };

      const prompt = [
        "Extract the CAA wholesale fish price table from the provided image(s).",
        "",
        "TABLE STRUCTURE:",
        "- Each row is a Cambodian province; each column is a fish species.",
        "- The table has EXACTLY 10 fish-type columns per province row, in fixed left-to-right order.",
        "- Each non-empty cell contains a price range (upper line, KHR/kg) and a size range (lower line, kg).",
        "",
        "CELL INDEPENDENCE (critical — most common error to avoid):",
        "- Each (province, fishType) cell is independent. Read the digits actually shown inside that exact cell.",
        "- Even if two ADJACENT cells contain identical values (e.g., red_tilapia and nile_tilapia both showing '6000-6500/0.45-0.8'), you MUST report BOTH cells separately. Do NOT skip or merge cells based on content similarity.",
        "- Do NOT shift values between columns. Process each fish-type column position independently.",
        "",
        "EMPTY CELL HANDLING (critical):",
        "- A cell is EMPTY if it contains only †, ✝, 'f', a dagger-like mark, or any single placeholder character with NO visible digits.",
        "- When a cell is empty, DO NOT generate an entry for it. Omit it from the output entirely.",
        "- NEVER copy values from adjacent cells into an empty cell.",
        "",
        "Province name mapping (use exactly these canonical English names):",
        "- កណ្តាល → 'Kandal'",
        "- តាកែវ → 'Takeo'",
        "- ព្រៃវែង → 'Prey Veng'",
        "- កំពង់ចាម → 'Kg. Cham'",
        "- កំពង់ធំ → 'Kg. Thom'",
        "- សៀមរាប → 'Siemreap'",
        "- បាត់ដំបង → 'Battambang'",
        "- ពោធិ៍សាត់ → 'Pursat'",
        "- កំពង់ឆ្នាំង → 'Kg. Chhnang'",
        "- បន្ទាយមានជ័យ → 'BMC'",
        "",
        "Fish type mapping (columns left-to-right):",
        "1. ត្រីរ៉ស់ Striped snakehead → 'striped_snakehead'",
        "2. អណ្ដែង Walking catfish → 'walking_catfish'",
        "3. ទីឡាព្យាក្រហម Red tilapia → 'red_tilapia'",
        "4. ទីឡាព្យាខៀវ Nile tilapia → 'nile_tilapia'",
        "5. ឆ្ពិន Silver barb → 'silver_barb'",
        "6. ត្រីពោ Spot pangasius → 'spot_pangasius'",
        "7. ត្រីប្រា Pangasius → 'pangasius'",
        "8. ត្រីឆ្តោ Giant snakehead → 'giant_snakehead'",
        "9. ត្រីក្រាញ់ Climbing perch → 'climbing_perch'",
        "10. កង្កែប Frog → 'frog'",
        "",
        "NUMERIC PRECISION (critical):",
        "- Parse numeric values EXACTLY as written. Preserve every digit, including trailing decimal digits.",
        "- '0.45' is 0.45 — NOT 0.5 or 0.4. Two-decimal values must keep both decimals.",
        "- '0.17' is 0.17 — NOT 0.2.   '0.25' is 0.25 — NOT 0.3.   '0.15' is 0.15 — NOT 0.2.",
        "- Common two-decimal values in this table: 0.15, 0.17, 0.20, 0.25, 0.30, 0.45.",
        "- Multi-digit integers: preserve all digits exactly. '4300' stays 4300 (NOT 4100). '90000' stays 90000 (NOT 9000).",
        "- Do not introduce commas, currency symbols, or thousand separators.",
        "",
        "TYPO PRESERVATION (critical):",
        "- Do NOT 'fix' or normalize values that look like typos. Return what is printed.",
        "- Example: if a cell shows '8500-90000' (5-digit second number), return rangeMax=90000. Do NOT 'correct' it to 9000.",
        "- Example: if a unit is printed as 'g' instead of 'kg', still parse the size number as-is (the size context is kg).",
        "",
        "OUTPUT:",
        "- Output every (province, fishType) intersection where all four numeric values are clearly visible. Aim for completeness — do not skip cells that are filled.",
        "- Multiple images may show different province rows of the same table — extract rows from all images.",
      ].join("\n");

      const parts = [];
      for (const image of images) {
        if (!image || typeof image.data !== "string") continue;
        parts.push({
          inlineData: {
            mimeType: image.mimeType || "image/jpeg",
            data: image.data,
          },
        });
      }
      parts.push({ text: prompt });

      const response = await ai.models.generateContent({
        model: "gemini-2.5-pro",
        contents: [{ role: "user", parts }],
        config: {
          responseMimeType: "application/json",
          responseSchema: schema,
          temperature: 0,
        },
      });

      const text = response.text || "";
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        console.error("Gemini returned non-JSON:", text);
        throw new HttpsError("internal", "Gemini returned invalid JSON");
      }

      return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      console.error("Gemini extract failed:", err);
      throw new HttpsError("internal", err.message || "Gemini extraction failed");
    }
  }
);

// ── ユーザー BAN / 解除（管理者専用 callable） ───────────────────
// クライアントから {uid, banned, reason} を受け取り
//   1) users/{uid} に isBanned/bannedAt/bannedReason を書き込み
//   2) auth.revokeRefreshTokens で強制サインアウト
//   3) BAN対象が農家なら出品中の fishListings.isActive=false に
exports.setUserBanned = onCall(
  {
    region: "asia-southeast1",
    invoker: "public",
    cors: true,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }
    const callerSnap = await db.doc(`users/${request.auth.uid}`).get();
    if (callerSnap.data()?.role !== "admin") {
      throw new HttpsError("permission-denied", "Admin role required");
    }

    const { uid, banned, reason } = request.data || {};
    if (!uid || typeof banned !== "boolean") {
      throw new HttpsError("invalid-argument", "uid and banned are required");
    }
    if (uid === request.auth.uid) {
      throw new HttpsError("invalid-argument", "Cannot ban yourself");
    }

    const targetSnap = await db.doc(`users/${uid}`).get();
    if (!targetSnap.exists) {
      throw new HttpsError("not-found", "User not found");
    }
    const targetData = targetSnap.data();
    if (banned && targetData.role === "admin") {
      throw new HttpsError("permission-denied", "Cannot ban admin");
    }

    const admin = require("firebase-admin/firestore");
    const batch = db.batch();
    batch.update(db.doc(`users/${uid}`), {
      isBanned: banned,
      bannedAt: banned ? admin.FieldValue.serverTimestamp() : null,
      bannedReason: banned ? (reason || null) : null,
    });

    // 農家の場合、出品を全て停止
    let deactivated = 0;
    if (banned && targetData.role === "farmer") {
      const listSnap = await db.collection("fishListings")
        .where("farmerId", "==", uid)
        .where("isActive", "==", true)
        .get();
      listSnap.forEach(d => {
        batch.update(d.ref, { isActive: false });
        deactivated++;
      });
    }
    await batch.commit();

    // BAN時はリフレッシュトークン失効で強制サインアウト
    if (banned) {
      try {
        await getAuth().revokeRefreshTokens(uid);
      } catch (e) {
        console.warn("revokeRefreshTokens failed:", e.message);
      }
    }

    return { ok: true, deactivated };
  }
);

// ── 運営チャット: メッセージ作成時の通知 ──────────────────────────
// adminChats/{uid}/messages/{msgId} 作成 → 受信側に FCM 通知
//   senderRole==='admin' → ユーザーに通知
//   senderRole==='user'  → 全管理者に通知
exports.onAdminChatMessage = onDocumentCreated(
  {
    document: "adminChats/{uid}/messages/{msgId}",
    region: "asia-southeast1",
  },
  async (event) => {
    const data = event.data?.data();
    if (!data) return;
    const { uid } = event.params;
    const senderRole = data.senderRole;
    const text = data.text || "";

    // 親ドキュメントに最新メッセージのサマリを保存
    // 5/1: 管理者ユーザー一覧で未読バッジ・最終メッセージを表示するため
    const admin = require("firebase-admin/firestore");
    try {
      await db.doc(`adminChats/${uid}`).set({
        lastMessage: text.slice(0, 200),
        lastMessageAt: admin.FieldValue.serverTimestamp(),
        lastSenderRole: senderRole,
        // ユーザー発言時のみ未読フラグを立てる。管理者が返信した時点で false に
        hasUnreadFromUser: senderRole === "user",
        updatedAt: admin.FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (e) {
      console.error("Failed to update adminChats parent doc:", uid, e);
    }

    if (senderRole === "admin") {
      const userSnap = await db.doc(`users/${uid}`).get();
      const lang = userSnap.data()?.lang || "km";
      const vars = { text: text.slice(0, 80) };
      const msg = getMessage("adminChat", lang, vars);
      await notifyUser(uid, {
        type: "admin_chat",
        title: msg.title, body: msg.body,
        url: "/pages/admin-chat.html",
        msgKey: "adminChat",
        vars,
      });
    } else if (senderRole === "user") {
      const adminUids = await getAdminUids();
      const senderSnap = await db.doc(`users/${uid}`).get();
      const senderName = senderSnap.data()?.displayName || senderSnap.data()?.loginId || "user";
      const vars = { name: senderName, text: text.slice(0, 80) };
      await Promise.all(adminUids.map(async adminUid => {
        const adminSnap = await db.doc(`users/${adminUid}`).get();
        const lang = adminSnap.data()?.lang || "ja";
        const msg = getMessage("adminChatFromUser", lang, vars);
        await notifyUser(adminUid, {
          type: "admin_chat",
          title: msg.title, body: msg.body,
          url: `/pages/admin/users.html?uid=${uid}`,
          msgKey: "adminChatFromUser",
          vars,
        });
      }));
    }
  }
);
