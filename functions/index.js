const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");
const { getFirestore } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

// ── 多言語メッセージ ──────────────────────────────────────────
const MESSAGES = {
  newOrder: {
    ja: { title: "新しい注文が届きました", body: "{{restaurant}}から{{qty}}kgの注文" },
    en: { title: "New order received", body: "{{restaurant}} ordered {{qty}}kg" },
    km: { title: "មានការបញ្ជាទិញថ្មី", body: "{{restaurant}} បានបញ្ជាទិញ {{qty}}kg" },
  },
  approved: {
    ja: { title: "注文が承認されました", body: "{{farmer}}が注文を承認しました" },
    en: { title: "Order approved", body: "{{farmer}} approved your order" },
    km: { title: "ការបញ្ជាទិញត្រូវបានយល់ព្រម", body: "{{farmer}} បានយល់ព្រមការបញ្ជាទិញ" },
  },
  declined: {
    ja: { title: "注文が辞退されました", body: "{{farmer}}が注文を辞退しました" },
    en: { title: "Order declined", body: "{{farmer}} declined your order" },
    km: { title: "ការបញ្ជាទិញត្រូវបានបដិសេធ", body: "{{farmer}} បានបដិសេធការបញ្ជាទិញ" },
  },
  statusUpdate: {
    ja: { title: "注文ステータスが更新されました", body: "ステータス: {{status}}" },
    en: { title: "Order status updated", body: "Status: {{status}}" },
    km: { title: "ស្ថានភាពការបញ្ជាទិញបានផ្លាស់ប្ដូរ", body: "ស្ថានភាព: {{status}}" },
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

    const { title, body } = getMessage("newOrder", lang, {
      restaurant: restName,
      qty: String(order.quantity),
    });

    await getMessaging().send({
      token,
      notification: { title, body },
      data: {
        type: "new_order",
        orderId: event.params.orderId,
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

    let type;
    const vars = { farmer: farmerName, status: after.status };

    if (after.status === "approved") {
      type = "approved";
    } else if (after.status === "declined") {
      type = "declined";
    } else {
      type = "statusUpdate";
    }

    const { title, body } = getMessage(type, lang, vars);

    await getMessaging().send({
      token,
      notification: { title, body },
      data: {
        type: `order_${after.status}`,
        orderId: event.params.orderId,
      },
    });

    console.log("Notification sent to restaurant:", after.restaurantId, "status:", after.status, "lang:", lang);
  }
);
