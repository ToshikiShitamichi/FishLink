const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");
const { getFirestore } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

// ── 注文作成時 → 農家に通知 ──────────────────────────────────
exports.onOrderCreated = onDocumentCreated(
  {
    document: "orders/{orderId}",
    region: "asia-southeast1",
    database: "(default)",
  },
  async (event) => {
    const order = event.data.data();

    const farmerSnap = await db.doc(`users/${order.farmerId}`).get();
    const token = farmerSnap.data()?.fcmToken;
    if (!token) {
      console.log("No fcmToken for farmer:", order.farmerId);
      return;
    }

    const restSnap = await db.doc(`users/${order.restaurantId}`).get();
    const restName = restSnap.data()?.displayName || "Restaurant";

    await getMessaging().send({
      token,
      notification: {
        title: "New order received",
        body: `${restName}: ${order.quantity}kg`,
      },
      data: {
        type: "new_order",
        orderId: event.params.orderId,
      },
    });

    console.log("Notification sent to farmer:", order.farmerId);
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

    const restSnap = await db.doc(`users/${after.restaurantId}`).get();
    const token = restSnap.data()?.fcmToken;
    if (!token) {
      console.log("No fcmToken for restaurant:", after.restaurantId);
      return;
    }

    const farmerSnap = await db.doc(`users/${after.farmerId}`).get();
    const farmerName = farmerSnap.data()?.displayName || "Farmer";

    let title = "Order update";
    let body = `Status: ${after.status}`;

    if (after.status === "approved") {
      title = "Order approved";
      body = `${farmerName} approved your order`;
    } else if (after.status === "declined") {
      title = "Order declined";
      body = `${farmerName} declined your order`;
    }

    await getMessaging().send({
      token,
      notification: { title, body },
      data: {
        type: `order_${after.status}`,
        orderId: event.params.orderId,
      },
    });

    console.log("Notification sent to restaurant:", after.restaurantId, "status:", after.status);
  }
);
