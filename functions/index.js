const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");
const { getFirestore } = require("firebase-admin/firestore");

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
async function getAdminUids() {
  const snap = await db.collection('users').where('role', '==', 'admin').get();
  return snap.docs.map(d => d.id);
}

// ── 通知履歴 ヘルパー ─────────────────────────────────────────
// notifications/{uid}/items/{autoId} に履歴を保存。
// FCM 送信も同時に行う（token があれば）。クライアントはここから購読して表示。
async function notifyUser(uid, { type, title, body, url, orderId, lang }) {
  if (!uid || !title) return;
  const admin = require("firebase-admin/firestore");

  // Firestore に保存
  await db.collection(`notifications/${uid}/items`).add({
    type: type || 'general',
    title,
    body: body || '',
    url: url || null,
    orderId: orderId || null,
    read: false,
    createdAt: admin.FieldValue.serverTimestamp(),
  });

  // FCM 送信
  try {
    const userSnap = await db.doc(`users/${uid}`).get();
    const token = userSnap.data()?.fcmToken;
    if (token) {
      await getMessaging().send({
        token,
        data: {
          title, body: body || '',
          type: type || 'general',
          orderId: orderId || '',
          url: url || '',
        },
      });
    }
  } catch (e) {
    console.error('notifyUser FCM failed:', uid, type, e);
  }
}

// ── 多言語メッセージ ──────────────────────────────────────────
const MESSAGES = {
  newOrder: {
    ja: { title: "新しい注文が届きました", body: "{{fish}} {{qty}}kg\n納品：{{date}} {{time}}\n1時間以内に承認してください\n承認期限：{{deadline}}" },
    en: { title: "New order received", body: "{{fish}} {{qty}}kg\nDelivery: {{date}} {{time}}\nPlease approve within 1 hour\nDeadline: {{deadline}}" },
    km: { title: "មានការបញ្ជាទិញថ្មី", body: "{{fish}} {{qty}}kg\nដឹកជញ្ជូន: {{date}} {{time}}\nសូមយល់ព្រមក្នុង 1 ម៉ោង\nកំណត់ពេល: {{deadline}}" },
  },
  approved: {
    ja: { title: "注文が承認されました", body: "{{fish}} {{qty}}kg\n納品：{{date}} {{time}}\n{{farmer}}" },
    en: { title: "Order approved", body: "{{fish}} {{qty}}kg\nDelivery: {{date}} {{time}}\n{{farmer}}" },
    km: { title: "ការបញ្ជាទិញត្រូវបានយល់ព្រម", body: "{{fish}} {{qty}}kg\nដឹកជញ្ជូន: {{date}} {{time}}\n{{farmer}}" },
  },
  declined: {
    ja: { title: "注文が辞退されました", body: "{{fish}} {{qty}}kg\n{{farmer}}" },
    en: { title: "Order declined", body: "{{fish}} {{qty}}kg\n{{farmer}}" },
    km: { title: "ការបញ្ជាទិញត្រូវបានបដិសេធ", body: "{{fish}} {{qty}}kg\n{{farmer}}" },
  },
  expiredDeclinedFarmer: {
    ja: { title: "承認期限切れにより辞退扱いになりました", body: "{{fish}} {{qty}}kg\n{{restaurant}}" },
    en: { title: "Order auto-declined (approval deadline expired)", body: "{{fish}} {{qty}}kg\n{{restaurant}}" },
    km: { title: "ការបញ្ជាទិញបដិសេធដោយស្វ័យប្រវត្តិ (ហួសកំណត់ពេលយល់ព្រម)", body: "{{fish}} {{qty}}kg\n{{restaurant}}" },
  },
  expiredDeclinedRestaurant: {
    ja: { title: "承認期限切れにより辞退扱いになりました", body: "{{fish}} {{qty}}kg\n{{farmer}}" },
    en: { title: "Order auto-declined (approval deadline expired)", body: "{{fish}} {{qty}}kg\n{{farmer}}" },
    km: { title: "ការបញ្ជាទិញបដិសេធដោយស្វ័យប្រវត្តិ (ហួសកំណត់ពេលយល់ព្រម)", body: "{{fish}} {{qty}}kg\n{{farmer}}" },
  },
  statusUpdate: {
    ja: { title: "注文ステータスが更新されました", body: "ステータス: {{status}}" },
    en: { title: "Order status updated", body: "Status: {{status}}" },
    km: { title: "ស្ថានភាពការបញ្ជាទិញបានផ្លាស់ប្ដូរ", body: "ស្ថានភាព: {{status}}" },
  },
  deliveryReminder: {
    ja: { title: "明日は納品日です", body: "{{fish}} {{qty}}kg\n納品：{{date}} {{time}}\n{{farmer}}" },
    en: { title: "Delivery is tomorrow", body: "{{fish}} {{qty}}kg\nDelivery: {{date}} {{time}}\n{{farmer}}" },
    km: { title: "ការដឹកជញ្ជូននៅថ្ងៃស្អែក", body: "{{fish}} {{qty}}kg\nដឹកជញ្ជូន: {{date}} {{time}}\n{{farmer}}" },
  },
  adminReport: {
    ja: { title: "新しいトラブル報告", body: "{{fromRole}} → {{type}}\n{{reporter}}" },
    en: { title: "New trouble report", body: "{{fromRole}} → {{type}}\n{{reporter}}" },
    km: { title: "របាយការណ៍បញ្ហាថ្មី", body: "{{fromRole}} → {{type}}\n{{reporter}}" },
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

    // 在庫減算（注文数量分）
    if (order.listingId && order.quantity > 0) {
      const listingRef = db.doc(`fishListings/${order.listingId}`);
      await listingRef.update({
        stock: admin.FieldValue.increment(-order.quantity),
      });
      console.log("Stock decremented:", order.listingId, "-", order.quantity);
    }

    // 農家のやることリストに「承認・辞退」を追加
    await createTodo(order.farmerId, 'farmer_approve', event.params.orderId);

    const farmerSnap = await db.doc(`users/${order.farmerId}`).get();
    const farmerData = farmerSnap.data() || {};
    const restSnap = await db.doc(`users/${order.restaurantId}`).get();
    const restName = restSnap.data()?.displayName || "Restaurant";
    const lang = farmerData.lang || "en";

    // 魚種名を取得
    let fishName = "";
    if (order.listingId) {
      const listingSnap = await db.doc(`fishListings/${order.listingId}`).get();
      fishName = listingSnap.data()?.fishType || "";
    }

    // 承認期限（注文時刻 + 1時間、カンボジア時間UTC+7で表示）
    const createdAt = order.createdAt?.toDate?.() || new Date();
    const deadlineDate = new Date(createdAt.getTime() + 60 * 60 * 1000);
    const khmDeadline = new Date(deadlineDate.getTime() + 7 * 60 * 60 * 1000);
    const deadline = `${khmDeadline.getUTCHours()}:${String(khmDeadline.getUTCMinutes()).padStart(2, '0')}`;

    const { title, body } = getMessage("newOrder", lang, {
      restaurant: restName,
      fish: fishName,
      qty: String(order.quantity),
      date: order.deliveryDate || "",
      time: order.deliveryTime || "",
      deadline,
    });

    await notifyUser(order.farmerId, {
      type: "new_order",
      title, body,
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
      // 配送中 → 配送todo解消＋受渡todo作成
      if (after.status === "delivering") {
        await clearTodo(after.farmerId, 'farmer_deliver', orderId);
        await createTodo(after.farmerId, 'farmer_complete_delivery', orderId);
      }
      // 到着（delivered）→ 受渡todo解消＋レストラン受取todo作成
      if (after.status === "delivered") {
        await clearTodo(after.farmerId, 'farmer_complete_delivery', orderId);
        await createTodo(after.restaurantId, 'rest_receive', orderId);
      }
      // 完了（restaurant が受取確認）→ 受取todo解消＋支払todo作成
      if (after.status === "completed") {
        await clearTodo(after.restaurantId, 'rest_receive', orderId);
        await createTodo(after.restaurantId, 'rest_pay', orderId);
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
        // 送金完了時に両者にレビューtodo作成
        await createTodo(after.farmerId, 'farmer_review', orderId);
        await createTodo(after.restaurantId, 'rest_review', orderId);
      }
      if (after.adminStatus === "done") {
        for (const auid of adminUids) {
          await clearTodo(auid, 'admin_done', orderId);
        }
      }
    }

    if (!statusChanged) return;

    // 辞退時：在庫復元（自動辞退は autoDeclineExpiredOrders 内で復元済みのためスキップ）
    if (after.status === "declined" && after.listingId && after.quantity > 0
        && after.autoDeclined !== true) {
      const listingRef = db.doc(`fishListings/${after.listingId}`);
      await listingRef.update({
        stock: admin.FieldValue.increment(after.quantity),
      });
      console.log("Stock restored:", after.listingId, "+", after.quantity);
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

    // 魚種名を取得
    let fishName = "";
    if (after.listingId) {
      const listingSnap = await db.doc(`fishListings/${after.listingId}`).get();
      fishName = listingSnap.data()?.fishType || "";
    }

    let type;
    const vars = {
      farmer: farmerName,
      fish: fishName,
      qty: String(after.quantity || ""),
      date: after.deliveryDate || "",
      time: after.deliveryTime || "",
      status: after.status,
    };

    if (after.status === "approved") {
      type = "approved";
    } else if (after.status === "declined") {
      type = "declined";
    } else {
      type = "statusUpdate";
    }

    const { title, body } = getMessage(type, lang, vars);

    // 配送系ステータスならチャット画面へ、それ以外は注文一覧へ
    const url = ["preparing", "delivering", "delivered"].includes(after.status)
      ? `/pages/restaurant/delivery.html?id=${orderId}`
      : "/pages/restaurant/orders.html";

    await notifyUser(after.restaurantId, {
      type: `order_${after.status}`,
      title, body, url,
      orderId,
    });

    console.log("Notification sent to restaurant:", after.restaurantId, "status:", after.status, "lang:", lang);
  }
);

// ── チャットメッセージ送信時 → 相手に通知 ──────────────────────
const CHAT_MESSAGES = {
  ja: { title: "新しいメッセージ", body: "{{sender}}: {{text}}" },
  en: { title: "New message", body: "{{sender}}: {{text}}" },
  km: { title: "សារថ្មី", body: "{{sender}}: {{text}}" },
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
    const title = tmpl.title;
    const body = tmpl.body.replace("{{sender}}", senderName).replace("{{text}}", truncText);

    const isFarmer = toUid === order.farmerId;
    const chatUrl = isFarmer
      ? `/pages/farmer/delivery.html?id=${orderId}`
      : `/pages/restaurant/delivery.html?id=${orderId}`;

    await notifyUser(toUid, {
      type: "chat_message",
      title, body,
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

  // 在庫復元
  if (order.listingId && order.quantity > 0) {
    await db.doc(`fishListings/${order.listingId}`).update({
      stock: admin.FieldValue.increment(order.quantity),
    });
  }

  // 農家側・レストラン側の関連todoを全て解消（念のため type 問わず）
  await clearAllTodosForOrder(order.farmerId, orderId);
  await clearAllTodosForOrder(order.restaurantId, orderId);

  // 魚種名（snap優先）
  let fishName = order.snapFishType || "";
  if (!fishName && order.listingId) {
    const listingSnap = await db.doc(`fishListings/${order.listingId}`).get();
    fishName = listingSnap.data()?.fishType || "";
  }

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
    const { title, body } = getMessage("expiredDeclinedFarmer", farmerData.lang || "en", {
      restaurant: restName,
      fish: fishName,
      qty: String(order.quantity || ""),
    });
    await notifyUser(order.farmerId, {
      type: "order_expired_declined",
      title, body,
      url: "/pages/farmer/orders.html",
      orderId,
    });
  }

  // レストランへ通知
  {
    const { title, body } = getMessage("expiredDeclinedRestaurant", restData.lang || "en", {
      farmer: farmerName,
      fish: fishName,
      qty: String(order.quantity || ""),
    });
    await notifyUser(order.restaurantId, {
      type: "order_expired_declined",
      title, body,
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
      await sweepOrphanTodos();
      return;
    }

    if (snap.empty) {
      console.log("No expired orders");
      await sweepOrphanTodos();
      return;
    }

    for (const doc of snap.docs) {
      await autoDeclineOrder(doc);
    }

    // 孤立した todo を一括クリーンアップ
    await sweepOrphanTodos();
  }
);

// todoのtype → 対象orderが取りうるべき order.status のセット
// （下記以外の status の場合、その todo は孤立として扱って閉じる）
const TODO_VALID_STATUSES = {
  farmer_approve: ['pending'],
  farmer_prepare: ['approved'],
  farmer_deliver: ['preparing'],
  farmer_complete_delivery: ['delivering'],
  rest_receive: ['delivered'],
  rest_pay: ['completed'],
  farmer_review: ['delivered', 'completed'],
  rest_review: ['delivered', 'completed'],
  farmer_reply: ['pending', 'approved', 'preparing', 'delivering', 'delivered', 'completed'],
  rest_reply: ['pending', 'approved', 'preparing', 'delivering', 'delivered', 'completed'],
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
      if (!validStatuses) continue;

      let shouldClear = false;

      if (!todo.orderId) {
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

// ── レビュー作成時：対象ユーザーの avgRating / reviewCount / サブ評価 を更新 ──
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
    const newRating = Number(review.avgRating || 0);
    if (!toUid || !newRating) return;

    const userRef = db.doc(`users/${toUid}`);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const prev = snap.data() || {};
      const prevCount = Number(prev.reviewCount || 0);
      const prevAvg = Number(prev.avgRating || 0);
      const newCount = prevCount + 1;
      const newAvg = (prevAvg * prevCount + newRating) / newCount;

      // サブ評価の累積平均
      const update = { reviewCount: newCount, avgRating: newAvg };
      if (fromRole === "restaurant") {
        // レストランが農家を評価 → 農家の subRatings
        const sub = prev.subRatings || { overall: 0, quality: 0, time: 0, count: 0 };
        const c = sub.count || 0;
        update.subRatings = {
          overall: ((sub.overall || 0) * c + Number(review.overall || 0)) / (c + 1),
          quality: ((sub.quality || 0) * c + Number(review.quality || 0)) / (c + 1),
          time: ((sub.time || 0) * c + Number(review.time || 0)) / (c + 1),
          count: c + 1,
        };
      } else if (fromRole === "farmer") {
        // 農家がレストランを評価 → レストランの subRatings
        const sub = prev.subRatings || { overall: 0, communication: 0, reception: 0, count: 0 };
        const c = sub.count || 0;
        update.subRatings = {
          overall: ((sub.overall || 0) * c + Number(review.overall || 0)) / (c + 1),
          communication: ((sub.communication || 0) * c + Number(review.communication || 0)) / (c + 1),
          reception: ((sub.reception || 0) * c + Number(review.reception || 0)) / (c + 1),
          count: c + 1,
        };
      }

      tx.update(userRef, update);
    });

    // レビュー投稿者のレビューtodo解消
    const reviewerTodoType = fromRole === 'farmer' ? 'farmer_review' : 'rest_review';
    await clearTodo(review.fromUid, reviewerTodoType, event.params.orderId);

    console.log("Review aggregated for user:", toUid, "avg:", newRating);
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

      // 魚種名（snap優先）
      let fishName = order.snapFishType || "";
      if (!fishName && order.listingId) {
        const listingSnap = await db.doc(`fishListings/${order.listingId}`).get();
        fishName = listingSnap.data()?.fishType || "";
      }

      const { title, body } = getMessage("deliveryReminder", restData.lang || "en", {
        farmer: farmerData.displayName || "",
        fish: fishName,
        qty: String(order.quantity || ""),
        date: order.deliveryDate || "",
        time: order.deliveryTime || "",
      });

      await notifyUser(order.restaurantId, {
        type: "delivery_reminder",
        title, body,
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

      const { title, body } = getMessage("adminReport", lang, {
        fromRole: roleLabel,
        type: typeLabel,
        reporter: reporterName,
      });

      await notifyUser(auid, {
        type: "admin_report",
        title, body,
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
