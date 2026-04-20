const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");
const { getFirestore } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

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

    const farmerSnap = await db.doc(`users/${order.farmerId}`).get();
    const farmerData = farmerSnap.data();
    const token = farmerData?.fcmToken;
    if (!token) {
      console.log("No fcmToken for farmer:", order.farmerId);
      return;
    }

    const restSnap = await db.doc(`users/${order.restaurantId}`).get();
    const restName = restSnap.data()?.displayName || "Restaurant";
    const lang = farmerData?.lang || "en";

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

    await getMessaging().send({
      token,
      data: {
        title, body,
        type: "new_order",
        orderId: event.params.orderId,
        url: "/pages/farmer/orders.html",
      },
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

    if (before.status === after.status) return;

    const admin = require("firebase-admin/firestore");

    // 辞退時：在庫復元
    if (after.status === "declined" && after.listingId && after.quantity > 0) {
      const listingRef = db.doc(`fishListings/${after.listingId}`);
      await listingRef.update({
        stock: admin.FieldValue.increment(after.quantity),
      });
      console.log("Stock restored:", after.listingId, "+", after.quantity);
    }

    // 期限切れ自動辞退は autoDeclineExpiredOrders 内で両者に通知するため、ここではスキップ
    if (after.status === "declined" && after.autoDeclined === true) {
      console.log("Skip onOrderUpdated notify: auto-declined order", event.params.orderId);
      return;
    }

    const restSnap = await db.doc(`users/${after.restaurantId}`).get();
    const restData = restSnap.data();
    const token = restData?.fcmToken;
    if (!token) {
      console.log("No fcmToken for restaurant:", after.restaurantId);
      return;
    }

    const farmerSnap = await db.doc(`users/${after.farmerId}`).get();
    const farmerName = farmerSnap.data()?.displayName || "Farmer";
    const lang = restData?.lang || "en";

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
      ? `/pages/restaurant/delivery.html?id=${event.params.orderId}`
      : "/pages/restaurant/orders.html";

    await getMessaging().send({
      token,
      data: {
        title, body,
        type: `order_${after.status}`,
        orderId: event.params.orderId,
        url,
      },
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

    const toSnap = await db.doc(`users/${toUid}`).get();
    const toData = toSnap.data();
    const token = toData?.fcmToken;
    if (!token) {
      console.log("No fcmToken for chat recipient:", toUid);
      return;
    }

    const senderSnap = await db.doc(`users/${msg.senderId}`).get();
    const senderName = senderSnap.data()?.displayName || "";
    const lang = toData?.lang || "en";

    const tmpl = CHAT_MESSAGES[lang] || CHAT_MESSAGES.en;
    const truncText = (msg.text || "").substring(0, 50);
    const title = tmpl.title;
    const body = tmpl.body.replace("{{sender}}", senderName).replace("{{text}}", truncText);

    // 送信先のロールに応じてチャット画面URLを決定
    const isFarmer = toUid === order.farmerId;
    const chatUrl = isFarmer
      ? `/pages/farmer/delivery.html?id=${orderId}`
      : `/pages/restaurant/delivery.html?id=${orderId}`;

    await getMessaging().send({
      token,
      data: {
        title, body,
        type: "chat_message",
        orderId,
        url: chatUrl,
      },
    });

    console.log("Chat notification sent to:", toUid);
  }
);

// ── 期限切れ注文の自動辞退（5分ごとにチェック） ──────────────
exports.autoDeclineExpiredOrders = onSchedule(
  { schedule: "every 5 minutes", region: "asia-southeast1" },
  async () => {
    const admin = require("firebase-admin/firestore");
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const snap = await db.collection("orders")
      .where("status", "==", "pending")
      .where("createdAt", "<", oneHourAgo)
      .get();

    if (snap.empty) {
      console.log("No expired orders");
      return;
    }

    for (const doc of snap.docs) {
      const order = doc.data();

      // ステータスを declined に変更（autoDeclined フラグで通知経路を分岐）
      await doc.ref.update({
        status: "declined",
        declineReason: "承認期限切れによる自動辞退",
        autoDeclined: true,
      });

      // 在庫復元
      if (order.listingId && order.quantity > 0) {
        await db.doc(`fishListings/${order.listingId}`).update({
          stock: admin.FieldValue.increment(order.quantity),
        });
      }

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

      // 農家へ通知
      const farmerToken = farmerData.fcmToken;
      if (farmerToken) {
        const { title, body } = getMessage("expiredDeclinedFarmer", farmerData.lang || "en", {
          restaurant: restName,
          fish: fishName,
          qty: String(order.quantity || ""),
        });
        try {
          await getMessaging().send({
            token: farmerToken,
            data: {
              title, body,
              type: "order_expired_declined",
              orderId: doc.id,
              url: "/pages/farmer/orders.html",
            },
          });
        } catch (e) {
          console.error("Failed to notify farmer on auto-decline:", doc.id, e);
        }
      }

      // レストランへ通知
      const restToken = restData.fcmToken;
      if (restToken) {
        const { title, body } = getMessage("expiredDeclinedRestaurant", restData.lang || "en", {
          farmer: farmerName,
          fish: fishName,
          qty: String(order.quantity || ""),
        });
        try {
          await getMessaging().send({
            token: restToken,
            data: {
              title, body,
              type: "order_expired_declined",
              orderId: doc.id,
              url: "/pages/restaurant/orders.html",
            },
          });
        } catch (e) {
          console.error("Failed to notify restaurant on auto-decline:", doc.id, e);
        }
      }

      console.log("Auto-declined expired order:", doc.id);
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
      const token = restData.fcmToken;
      if (!token) {
        console.log("No fcmToken for restaurant:", order.restaurantId);
        continue;
      }

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

      try {
        await getMessaging().send({
          token,
          data: {
            title, body,
            type: "delivery_reminder",
            orderId: d.id,
            url: `/pages/restaurant/delivery.html?id=${d.id}`,
          },
        });
        console.log("Delivery reminder sent:", d.id);
      } catch (e) {
        console.error("Failed to send delivery reminder:", d.id, e);
      }
    }
  }
);
