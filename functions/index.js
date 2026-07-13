const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");
const { getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");  // 5/23 #81: ボイスメッセージの自動削除用
const { getAuth } = require("firebase-admin/auth");

initializeApp();
const db = getFirestore();

// ── 承認期限 ヘルパー（2026-07-08 #196）────────────────────────
// ⚠️ この式は js/approval-deadline.js（ブラウザ ES module）の複製。Cloud Functions は
//    ES module を import できないため CommonJS で同一ロジックを再現している。
//    片方を変えたら必ず両方を EXACT に揃えること（constants・branch 条件・日跨ぎ処理）。
//    複製箇所＝onOrderCreated（approveDeadline 保存）／autoDeclineExpiredOrders／
//    remindApproveDeadline／sweepOrphanTodos。
// 承認期限 = 注文 + 1.5h。ただしその期限が夜間（21:00–5:00）に入る場合は
//   「翌朝5:00起点」にリセット（= 5:00 + 1.5h = 6:30）。KHM(UTC+7) を「正」として計算。
const APPROVAL_LEAD_HOURS = 1.5;   // 承認期限 = 注文 + 1.5h（依頼③）
const NIGHT_START_HOUR = 21;       // 夜間開始 21:00（含む）
const NIGHT_END_HOUR = 5;          // 夜間終了（翌朝）05:00（含まない＝5:00 は昼扱い）
const KHM_OFFSET_MS = 7 * 60 * 60 * 1000;
const AD_HOUR_MS = 60 * 60 * 1000;

// UTC ms → KHM の壁時計成分（getUTC*）。
function khmParts(utcMs) {
  const d = new Date(utcMs + KHM_OFFSET_MS);
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth(), day: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(),
  };
}

// KHM の壁時計（Y, Mo(0基点), D, h, mi）→ 実 UTC ms。
function khmWallToUtcMs(y, mo, day, h, mi) {
  return Date.UTC(y, mo, day, h, mi, 0, 0) - KHM_OFFSET_MS;
}

// 注文時刻(ms) → 承認期限(ms)。夜間なら翌朝5:00起点にリセットして +1.5h（=6:30）。
function computeApprovalDeadlineMs(orderMs) {
  const raw = orderMs + APPROVAL_LEAD_HOURS * AD_HOUR_MS;
  const k = khmParts(raw);
  const isNight = k.h >= NIGHT_START_HOUR || k.h < NIGHT_END_HOUR; // [21:00, 05:00)
  if (!isNight) return raw;
  // 夜間 → 「翌朝 NIGHT_END_HOUR(5:00)」を起点に。
  //   夕方以降(>= NIGHT_START_HOUR) は KHM 翌日の 5:00／深夜〜早朝(< NIGHT_END_HOUR) は KHM 同日の 5:00。
  let y = k.y, mo = k.mo, day = k.day;
  if (k.h >= NIGHT_START_HOUR) {
    const nd = new Date(Date.UTC(y, mo, day + 1)); // 月跨ぎを Date に任せる
    y = nd.getUTCFullYear(); mo = nd.getUTCMonth(); day = nd.getUTCDate();
  }
  const base = khmWallToUtcMs(y, mo, day, NIGHT_END_HOUR, 0);
  return base + APPROVAL_LEAD_HOURS * AD_HOUR_MS;
}

// UTC ms → KHM の "H:MM"（承認期限の表示用）。
function formatKhmHm(utcMs) {
  const k = khmParts(utcMs);
  return `${k.h}:${String(k.mi).padStart(2, '0')}`;
}

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

// ── 6/3 #119: 公開Q&A の「未回答の質問」やることリスト同期 ───────────
// listing に農家未回答の質問が1件でもあれば farmer_qa todo を作成、無ければ解消（冪等）。
async function listingHasUnansweredQuestions(listingId, farmerId) {
  const snap = await db.collection(`fishListings/${listingId}/comments`).get();
  const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  // root 質問＝parentReplyId なし・未削除・農家自身の投稿でない
  const roots = docs.filter((d) => !d.parentReplyId && d.isDeleted !== true && d.senderId !== farmerId);
  for (const root of roots) {
    // legacy 埋め込み返信（replyText）があれば回答済み扱い
    if (root.replyText && String(root.replyText).trim()) continue;
    // 農家からの child 返信（未削除）があれば回答済み
    const farmerReplied = docs.some(
      (d) => d.parentReplyId === root.id && d.senderId === farmerId && d.isDeleted !== true,
    );
    if (!farmerReplied) return true;
  }
  return false;
}

async function syncQaTodo(listingId, farmerId) {
  if (!listingId || !farmerId) return;
  try {
    const has = await listingHasUnansweredQuestions(listingId, farmerId);
    if (has) await createTodo(farmerId, "farmer_qa", listingId);
    else await clearTodo(farmerId, "farmer_qa", listingId);
  } catch (e) {
    console.warn("syncQaTodo failed:", e.message);
  }
}

// ── 6/3 #120: 連絡先マスク（サーバ側・バイパス防止）。js/contact-mask.js と同一ロジックの CJS 版 ──
const _CONTACT_URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const _CONTACT_DOMAIN_RE = /\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|io|me|info|biz|co|kh|app|link|page|shop|xyz|online|site|gg|ru)\b(?:\/\S*)?/gi;
const _CONTACT_HANDLE_RE = /@[A-Za-z0-9_.]{2,}/g;
const _CONTACT_MSGAPP_RE = /\b(?:t\.me|wa\.me|telegram|whats?app|wechat|line\s*id|messenger|facebook\.com|fb\.com|instagram)\b\S*/gi;
const _CONTACT_PHONE_RE = /\+?\d[\d\-.\s()]{6,}\d/g;
function _normalizeWidth(s) {
  return String(s ?? "").replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/　/g, " ");
}
function _digitCount(s) { const m = String(s).match(/\d/g); return m ? m.length : 0; }
function maskContactsServer(text, placeholder = "［連絡先は非表示］") {
  if (!text) return { masked: text, hit: false };
  let hit = false;
  let out = _normalizeWidth(text);
  const DATE_LIKE = /^\s*\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\s*$/;
  const apply = (re, opts = {}) => {
    out = out.replace(re, (match) => {
      if (opts.minDigits && (_digitCount(match) < opts.minDigits || DATE_LIKE.test(match))) return match;
      hit = true;
      return placeholder;
    });
  };
  apply(_CONTACT_URL_RE);
  apply(_CONTACT_MSGAPP_RE);
  apply(_CONTACT_DOMAIN_RE);
  apply(_CONTACT_HANDLE_RE);
  apply(_CONTACT_PHONE_RE, { minDigits: 8 });
  return { masked: out, hit };
}

// ── 6/3 #121: マスク発動Q&A投稿を トラブル報告「公開質問（要確認）」として自動生成 ──
async function createQaContactReport({ listingId, commentId, posterUid, posterRole, listing, farmerName, maskedText, qaField = "text" }) {
  const admin = require("firebase-admin/firestore");
  // 同一投稿×フィールドの重複レポートを避ける（commentId 単一フィールド query → 複合インデックス不要）。
  const existing = await db.collection("reports")
    .where("commentId", "==", commentId)
    .get();
  if (existing.docs.some((d) => d.data().type === "qa_contact" && (d.data().qaField || "text") === qaField)) return;
  await db.collection("reports").add({
    type: "qa_contact",
    source: "qa",
    qaField,                       // 'text'（質問/返信本文）or 'replyText'（legacy 埋め込み返信）
    fromUid: posterUid || null,
    fromRole: posterRole || "restaurant",
    listingId: listingId || null,
    commentId: commentId || null,
    qaContext: {
      fishType: listing?.fishType || "",
      size: listing?.size || "",
      farmerName: farmerName || "",
    },
    detail: maskedText || "",
    status: "open",
    createdAt: admin.FieldValue.serverTimestamp(),
  });
  console.log("QA contact report created:", listingId, commentId, qaField);
}

// ── 6/5 #128: マスク発動レビューコメントを トラブル報告「レビュー（要確認）」として自動生成 ──
//   #121 の qa_contact と同じ要領。運営が reports.html から「非表示」にすると review.hidden=true に。
async function createReviewContactReport({ orderId, reviewId, fromUid, fromRole, reportedUid, maskedText }) {
  const admin = require("firebase-admin/firestore");
  // 同一レビュー（注文×方向）の重複レポートを避ける
  const existing = await db.collection("reports")
    .where("orderId", "==", orderId)
    .get();
  if (existing.docs.some((d) => d.data().type === "review_contact" && (d.data().reviewId || "") === reviewId)) return;
  await db.collection("reports").add({
    type: "review_contact",
    source: "review",
    orderId: orderId || null,
    reviewId: reviewId || null,          // 'restaurant' | 'farmer'（reviews サブコレクションの doc id）
    fromUid: fromUid || null,            // 投稿者（評者）
    fromRole: fromRole || "restaurant",
    reportedUid: reportedUid || null,    // 被評価者
    detail: maskedText || "",            // マスク後の本文（公開と同じ）
    status: "open",
    createdAt: admin.FieldValue.serverTimestamp(),
  });
  console.log("Review contact report created:", orderId, reviewId);
}

// 管理者UID取得（全管理者）
// 4/29: コスト削減のため `settings/adminUids.uids[]` をキャッシュとして使用
//       キャッシュが存在しない場合のみ users をスキャンしてキャッシュを生成
// 5/5 #6: 「新しい admin が登録されたが通知が届かない」問題対策で、
//   onUserWritten トリガで admin role になった際に自動でキャッシュを再生成
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
  console.log('Admin UIDs refreshed (user scan):', uids.length, uids);
  return uids;
}

// 5/5 #6: users コレクションのキャッシュ無効化ヘルパー
//   onUserWritten から呼ばれ、`settings/adminUids` を再生成する。
async function invalidateAdminUidsCache(reason) {
  _adminUidsCache = null;
  _adminUidsCacheAt = 0;
  try {
    await db.doc('settings/adminUids').delete();
    console.log('settings/adminUids cache invalidated:', reason);
  } catch (e) { /* ignore — 既に無ければスキップ */ }
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
    if (tokens.length === 0) {
      // 5/4: トークン未登録でも silent return せず、後で原因切り分けできるようログ
      console.log('notifyUser skipped: no FCM tokens registered', { uid, type });
      return;
    }

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

    // 5/4: 送信結果を診断用にログ
    console.log('notifyUser FCM result:', {
      uid, type,
      tokens: tokens.length,
      success: response.successCount,
      failure: response.failureCount,
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
  // #142/#143: 買い手が承認前にキャンセル → 農家へ通知（辞退＝農家都合とは別ラベル）
  cancelled: {
    ja: { title: "注文がキャンセルされました", body: "{{restaurant}} {{fish}} {{qty}}kg\nレストランが承認前にキャンセルしました" },
    en: { title: "An order was cancelled", body: "{{restaurant}} {{fish}} {{qty}}kg\nThe restaurant cancelled before approval" },
    km: { title: "ការបញ្ជាទិញត្រូវបានបោះបង់", body: "{{restaurant}} {{fish}} {{qty}}kg\nភោជនីយដ្ឋានបានបោះបង់មុនពេលយល់ព្រម" },
  },
  expiredDeclinedFarmer: {
    ja: { title: "{{restaurant}} の注文が期限切れ辞退", body: "{{fish}} {{qty}}kg" },
    en: { title: "Order from {{restaurant}} auto-declined (expired)", body: "{{fish}} {{qty}}kg" },
    km: { title: "បញ្ជាទិញពី {{restaurant}} ហួសកំណត់ពេល", body: "{{fish}} {{qty}}kg" },
  },
  // 5/25 #88: 承認期限 10 分前リマインド（農家向け）
  approveDeadlineReminder: {
    ja: { title: "承認期限まであと10分", body: "{{restaurant}} {{fish}} {{qty}}kg\n承認しないと自動で辞退になります" },
    en: { title: "10 minutes left to approve", body: "{{restaurant}} {{fish}} {{qty}}kg\nThe order will be auto-declined if not approved in time" },
    km: { title: "នៅសល់ 10 នាទីដើម្បីយល់ព្រម", body: "{{restaurant}} {{fish}} {{qty}}kg\nបញ្ជាទិញនឹងត្រូវបដិសេធដោយស្វ័យប្រវត្តិបើមិនយល់ព្រម" },
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
    ja: { title: "送金が完了しました", body: "{{restaurant}} の注文 {{fish}} {{qty}}kg\n取引相手を評価しましょう" },
    en: { title: "Remittance completed", body: "Order from {{restaurant}}: {{fish}} {{qty}}kg\nPlease rate your counterpart" },
    km: { title: "ការផ្ទេរប្រាក់បានបញ្ចប់", body: "ការបញ្ជាទិញពី {{restaurant}}: {{fish}} {{qty}}kg\nសូមវាយតម្លៃដៃគូរបស់អ្នក" },
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
  // 5/23 #80: 商品ページ Q&A 通知
  commentQuestion: {
    ja: { title: "{{fish}} に新しい質問", body: "{{sender}}: {{text}}" },
    en: { title: "New question on {{fish}}", body: "{{sender}}: {{text}}" },
    km: { title: "សំណួរថ្មីលើ {{fish}}", body: "{{sender}}: {{text}}" },
  },
  commentReply: {
    ja: { title: "{{farmer}} から返信", body: "{{text}}" },
    en: { title: "Reply from {{farmer}}", body: "{{text}}" },
    km: { title: "ចម្លើយពី {{farmer}}", body: "{{text}}" },
  },
  // 5/24 #82 Phase 2 Chunk 2: 紹介クーポン発行通知
  referralCouponIssued: {
    ja: { title: "紹介クーポンを獲得しました", body: "{{amount}} KHR 割引クーポン（コード: {{code}}・{{validDays}}日有効）" },
    en: { title: "Referral coupon earned", body: "{{amount}} KHR off (code: {{code}}, valid {{validDays}} days)" },
    km: { title: "បានទទួលគូប៉ុងណែនាំ", body: "បញ្ចុះ {{amount}} KHR (កូដ: {{code}} · មានសុពលភាព {{validDays}} ថ្ងៃ)" },
  },
  // 5/24 #82 Phase 2 Chunk 2: 農家ボーナス枠獲得通知（チケット数+1）
  referralBonusEarned: {
    ja: { title: "紹介ボーナス枠を獲得", body: "次回以降の取引で {{amount}} KHR が上乗せされます" },
    en: { title: "Referral bonus credit earned", body: "Your next transaction will include a {{amount}} KHR bonus" },
    km: { title: "បានទទួលប្រាក់រង្វាន់ណែនាំ", body: "ប្រតិបត្តិការបន្ទាប់នឹងរួមបញ្ចូលប្រាក់រង្វាន់ {{amount}} KHR" },
  },
  // 5/24 #82 Phase 2 Chunk 2: 農家ボーナス消費通知（取引完了時に上乗せ適用）
  referralBonusApplied: {
    ja: { title: "紹介ボーナス適用", body: "今回の取引に {{amount}} KHR の紹介ボーナスが上乗せされました" },
    en: { title: "Referral bonus applied", body: "{{amount}} KHR referral bonus added to this transaction" },
    km: { title: "បានអនុវត្តប្រាក់រង្វាន់ណែនាំ", body: "បានបន្ថែមប្រាក់រង្វាន់ {{amount}} KHR លើប្រតិបត្តិការនេះ" },
  },
  // 6/26 #171 案B: 辞退／承認前キャンセル → 買い手へ即ウォレット返金通知（お金が動いた通知は確実に出す）
  declinedRefund: {
    ja: { title: "{{farmer}} が注文を辞退しました", body: "{{amount}} KHR をウォレットに返金しました（次回のご注文で使えます）" },
    en: { title: "{{farmer}} declined your order", body: "{{amount}} KHR was refunded to your wallet (use it on your next order)" },
    km: { title: "{{farmer}} បានបដិសេធការបញ្ជាទិញ", body: "បានបង្វិល {{amount}} KHR ទៅកាបូបវិញ (ប្រើបានលើការបញ្ជាទិញបន្ទាប់)" },
  },
  cancelledRefund: {
    ja: { title: "注文をキャンセルしました", body: "{{amount}} KHR をウォレットに返金しました（次回のご注文で使えます）" },
    en: { title: "Order cancelled", body: "{{amount}} KHR was refunded to your wallet (use it on your next order)" },
    km: { title: "បានបោះបង់ការបញ្ជាទិញ", body: "បានបង្វិល {{amount}} KHR ទៅកាបូបវិញ (ប្រើបានលើការបញ្ជាទិញបន្ទាប់)" },
  },
  // 6/29 #185 プッシュ通知 網羅（notification-spec v1.0 §3〜§5）──────────────
  // 買い手：配送ステータス（配送開始／到着／少し遅れそう の3つだけ・§3-3 B）。文言に農家名。
  deliveryStarted: {
    ja: { title: "{{farmer}} が配達に向かいました", body: "配送状況をチャットで確認できます" },
    en: { title: "{{farmer}} is on the way", body: "Track the delivery in the chat" },
    km: { title: "{{farmer}} កំពុងធ្វើដំណើរដឹកជញ្ជូន", body: "តាមដានការដឹកជញ្ជូនក្នុងការជជែក" },
  },
  deliveryArrived: {
    ja: { title: "{{farmer}} が到着しました", body: "お受け取りをお願いします" },
    en: { title: "{{farmer}} has arrived", body: "Please receive your order" },
    km: { title: "{{farmer}} បានមកដល់", body: "សូមទទួលការបញ្ជាទិញរបស់អ្នក" },
  },
  deliveryDelayed: {
    ja: { title: "{{farmer}} が少し遅れそうです", body: "配送状況をチャットで確認できます" },
    en: { title: "{{farmer}} may be slightly delayed", body: "Track the delivery in the chat" },
    km: { title: "{{farmer}} អាចនឹងយឺតបន្តិច", body: "តាមដានការដឹកជញ្ជូនក្នុងការជជែក" },
  },
  // 買い手：お届け（配送完了・前払い注文）。§3-1。
  //   ⚠️ 魚種/数量は入れない（複数item時の「他N件」が日本語固定＝他言語に漏れるため。文言は農家名のみ・spec通り）。
  deliveredToBuyer: {
    ja: { title: "{{farmer}} がお届けしました", body: "受け取りをご確認ください" },
    en: { title: "{{farmer}} delivered your order", body: "Please confirm receipt" },
    km: { title: "{{farmer}} បានដឹកជញ្ជូនរួចរាល់", body: "សូមបញ្ជាក់ការទទួល" },
  },
  // 買い手：取引完了（レビュー誘導）。§3-1。
  tradeCompletedReview: {
    ja: { title: "お取引が完了しました", body: "{{farmer}} を評価しましょう" },
    en: { title: "Your transaction is complete", body: "Please rate {{farmer}}" },
    km: { title: "ប្រតិបត្តិការរបស់អ្នកបានបញ្ចប់", body: "សូមវាយតម្លៃ {{farmer}}" },
  },
  // 農家：問題が報告された（送金確認中）。§3-2。
  problemReportedFarmer: {
    ja: { title: "問題が報告されています", body: "{{restaurant}} の注文について確認中です（送金は保留）" },
    en: { title: "A problem was reported", body: "Reviewing the order from {{restaurant}} (remittance on hold)" },
    km: { title: "មានការរាយការណ៍បញ្ហា", body: "កំពុងពិនិត្យការបញ្ជាទិញពី {{restaurant}} (ការផ្ទេរប្រាក់ត្រូវបានផ្អាក)" },
  },
  // 買い手：お支払い未確認。§3-1（運営が入金照合で未確認判定＝admin UI は別途）。
  paymentUnconfirmed: {
    ja: { title: "入金を確認できませんでした", body: "もう一度お支払いください" },
    en: { title: "We couldn't confirm your payment", body: "Please pay again" },
    km: { title: "យើងមិនអាចបញ្ជាក់ការទូទាត់បានទេ", body: "សូមទូទាត់ម្តងទៀត" },
  },
  // 買い手：クーポン期限リマインド（期限3日前に1回・未使用のみ）。§5。
  couponExpiringSoon: {
    ja: { title: "クーポンの期限が近づいています", body: "{{amount}} KHR クーポン（あと{{days}}日）" },
    en: { title: "Your coupon is expiring soon", body: "{{amount}} KHR coupon ({{days}} days left)" },
    km: { title: "គូប៉ុងរបស់អ្នកជិតផុតកំណត់", body: "គូប៉ុង {{amount}} KHR (នៅសល់ {{days}} ថ្ងៃ)" },
  },
};

const REPORT_TYPE_LABELS = {
  shortage:      { ja: "数量不足", en: "Shortage", km: "បរិមាណខ្វះ" },
  quality:       { ja: "品質",     en: "Quality",  km: "គុណភាព" },
  delay:         { ja: "配送遅延", en: "Delay",    km: "យឺត" },
  reception:     { ja: "受取対応", en: "Reception", km: "ការទទួល" },
  communication: { ja: "やり取り", en: "Communication", km: "ទំនាក់ទំនង" },
  qa_contact:    { ja: "公開質問（要確認）", en: "Public Q&A (review)", km: "សំណួរសាធារណៈ (ត្រួតពិនិត្យ)" },
  review_contact: { ja: "レビュー（要確認）", en: "Review (check)", km: "ការវាយតម្លៃ (ត្រួតពិនិត្យ)" },
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

// ──────────────────────────────────────────────────────────────
// 5/24 #82 Phase 2 Chunk 2: 紹介クーポン・農家ボーナス処理
// ──────────────────────────────────────────────────────────────

const COUPON_CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const COUPON_CODE_LEN = 8;

function generateCouponCode() {
  let s = "";
  for (let i = 0; i < COUPON_CODE_LEN; i++) {
    s += COUPON_CODE_CHARS[Math.floor(Math.random() * COUPON_CODE_CHARS.length)];
  }
  return s;
}

/**
 * 衝突回避付きでレストランへクーポンを発行。
 * 5 回リトライしても衝突したら null を返す（実用上ほぼ起こらない・62^8 ≈ 2.18e14）。
 *
 * @param {string} toUid 発行先 uid（レストラン）
 * @param {string} sourceUid 紹介相手側 uid
 * @param {string} sourceReferralCode 元の紹介コード
 * @param {'referrer' | 'referred'} issuedReason
 * @param {number} amountKhr 割引額
 * @param {number} validDays 有効期限（日数）
 * @returns {Promise<string | null>} 発行されたコード文字列
 */
async function issueCouponToRestaurant(toUid, sourceUid, sourceReferralCode, issuedReason, amountKhr, validDays) {
  const admin = require("firebase-admin/firestore");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + validDays * 24 * 60 * 60 * 1000);

  let code = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateCouponCode();
    const couponRef = db.doc(`coupons/${candidate}`);
    try {
      // トランザクションで存在チェック → 作成（同時並行でも衝突しない）
      const ok = await db.runTransaction(async (tx) => {
        const snap = await tx.get(couponRef);
        if (snap.exists) return false;
        tx.set(couponRef, {
          ownerUid: toUid,
          amountKhr,
          issuedAt: admin.FieldValue.serverTimestamp(),
          expiresAt,
          usedAt: null,
          usedOrderId: null,
          issuedReason,
          sourceReferralCode,
          sourceUid,
        });
        return true;
      });
      if (ok) {
        code = candidate;
        break;
      }
    } catch (e) {
      console.warn("issueCouponToRestaurant tx attempt failed:", attempt, e.message);
    }
  }
  if (!code) {
    console.error("issueCouponToRestaurant: failed to generate unique code after 5 retries");
    return null;
  }
  console.log("Coupon issued:", code, "to", toUid, "reason:", issuedReason, "amount:", amountKhr);

  // FCM 通知（受信者の言語で）
  try {
    const userSnap = await db.doc(`users/${toUid}`).get();
    const lang = userSnap.data()?.lang || "en";
    const vars = { code, amount: amountKhr.toLocaleString(), validDays: String(validDays) };
    const { title, body } = getMessage("referralCouponIssued", lang, vars);
    await notifyUser(toUid, {
      type: "referral_coupon_issued",
      title, body,
      msgKey: "referralCouponIssued", vars,
      url: "/pages/restaurant/account/referral.html",
    });
  } catch (e) {
    console.warn("referralCouponIssued FCM failed:", e.message);
  }
  return code;
}

/**
 * 紹介関係確定時に「受け取る側」のロールに応じた特典を付与。
 *  - レストラン → クーポン発行
 *  - 農家       → pendingFarmerBonus += 1（チケット式）
 */
async function grantReferralReward(toUid, toRole, sourceUid, sourceReferralCode, issuedReason, settings) {
  const admin = require("firebase-admin/firestore");
  if (toRole === "restaurant") {
    const amountKhr = Number(settings.restaurantCouponKhr || 0);
    if (amountKhr <= 0) {
      console.log("grantReferralReward skipped (restaurantCouponKhr=0):", toUid);
      return;
    }
    const validDays = Number(settings.couponValidDays || 30);
    await issueCouponToRestaurant(toUid, sourceUid, sourceReferralCode, issuedReason, amountKhr, validDays);
  } else if (toRole === "farmer") {
    const amountKhr = Number(settings.farmerBonusKhr || 0);
    if (amountKhr <= 0) {
      console.log("grantReferralReward skipped (farmerBonusKhr=0):", toUid);
      return;
    }
    await db.doc(`users/${toUid}`).update({
      pendingFarmerBonus: admin.FieldValue.increment(1),
    });
    console.log("pendingFarmerBonus +1 for farmer:", toUid);

    // FCM 通知
    try {
      const userSnap = await db.doc(`users/${toUid}`).get();
      const lang = userSnap.data()?.lang || "en";
      const vars = { amount: amountKhr.toLocaleString() };
      const { title, body } = getMessage("referralBonusEarned", lang, vars);
      await notifyUser(toUid, {
        type: "referral_bonus_earned",
        title, body,
        msgKey: "referralBonusEarned", vars,
        url: "/pages/farmer/account/referral.html",
      });
    } catch (e) {
      console.warn("referralBonusEarned FCM failed:", e.message);
    }
  }
}

/**
 * 1 ユーザーについて、pendingReferralCode → referredBy 昇格 + 双方特典付与。
 * 既に referredBy が確定済み、または pendingReferralCode が無い場合はスキップ（冪等）。
 *
 * @param {string} uid 被紹介者の uid
 * @param {object} settings settings/referral のデータ
 */
async function confirmReferralForUser(uid, settings) {
  const admin = require("firebase-admin/firestore");
  const userRef = db.doc(`users/${uid}`);
  const snap = await userRef.get();
  if (!snap.exists) return;
  const data = snap.data();

  if (data.referredBy) return; // 既に確定済み
  const code = data.pendingReferralCode;
  if (!code) return; // 入力なし

  // 5/24 #82 Phase 3: 不正検知ヘルパー — 処理スキップ時の pendingReferralCode クリア + 構造化ログ
  // reason は telemetry 検索しやすいよう固定の小語彙にする
  const skipAndClear = async (reason, extra = {}) => {
    try { await userRef.update({ pendingReferralCode: admin.FieldValue.delete() }); } catch (_) { /* ignore */ }
    console.warn("[referral-skip]", JSON.stringify({ reason, uid, code, ...extra }));
  };

  // 紹介者を探す
  const referrerSnap = await db.collection("users")
    .where("referralCode", "==", code)
    .limit(1)
    .get();
  if (referrerSnap.empty) {
    await skipAndClear("orphan_code");
    return;
  }
  const referrerDoc = referrerSnap.docs[0];
  const referrerUid = referrerDoc.id;
  if (referrerUid === uid) {
    // 自己コード（通常 register 検証で弾かれるが防御的に）
    await skipAndClear("self_code");
    return;
  }
  const referrerData = referrerDoc.data();

  // 5/24 #82 Phase 3: maxReferralsPerUser enforcement
  // settings.maxReferralsPerUser > 0 で上限あり / 0 = 無制限
  // 紹介者の referralCount が上限到達済みなら付与をスキップして pendingReferralCode をクリア
  // （被紹介者は将来コードを差し替えできないため、ここで永久にスキップとなる点はトレードオフ）
  const maxReferrals = Number(settings.maxReferralsPerUser || 0);
  if (maxReferrals > 0 && Number(referrerData.referralCount || 0) >= maxReferrals) {
    await skipAndClear("max_referrals_exceeded", {
      referrerUid,
      currentCount: referrerData.referralCount || 0,
      max: maxReferrals,
    });
    return;
  }

  // 5/24 #82 Phase 3: 招待ネットワーク循環検知（1-hop A→B→A）
  // 紹介者 referrer の referredBy がこのユーザーの紹介コードと一致するなら循環。
  // 多段の循環（A→B→C→A 等）は実用上発生しにくく、検知コスト高いため Phase 3 では skip。
  if (data.referralCode && referrerData.referredBy === data.referralCode) {
    await skipAndClear("cycle_1hop", {
      referrerUid,
      referrerReferredBy: referrerData.referredBy,
      myReferralCode: data.referralCode,
    });
    return;
  }

  // referredBy 確定 + 紹介者 referralCount +1 をアトミックに
  // トランザクション内で上限を再チェック（並行確定でも上限を超えないようにする）
  let exceeded = false;
  await db.runTransaction(async (tx) => {
    const freshUserSnap = await tx.get(userRef);
    const fresh = freshUserSnap.data() || {};
    if (fresh.referredBy) {
      // 別経路で同時確定された場合は何もしない
      return;
    }
    const freshReferrerSnap = await tx.get(referrerDoc.ref);
    const freshReferrer = freshReferrerSnap.data() || {};
    if (maxReferrals > 0 && Number(freshReferrer.referralCount || 0) >= maxReferrals) {
      // 並行登録で上限を超えそう → このユーザーを諦める（pendingReferralCode はトランザクション外で消す）
      exceeded = true;
      return;
    }
    tx.update(userRef, {
      referredBy: code,
      pendingReferralCode: admin.FieldValue.delete(),
    });
    tx.update(referrerDoc.ref, {
      referralCount: admin.FieldValue.increment(1),
    });
  });

  if (exceeded) {
    await skipAndClear("max_referrals_race", { referrerUid });
    return;
  }

  console.log("Referral confirmed:", uid, "<-", referrerUid, "code:", code);

  // 双方に特典付与（受け取る側のロールで決定）
  await grantReferralReward(uid, data.role, referrerUid, code, "referred", settings);
  await grantReferralReward(referrerUid, referrerData.role, uid, code, "referrer", settings);
}

/**
 * 農家側の order 完了時に pendingFarmerBonus を 1 消費して order に referralBonusAmount を記録。
 * 既に referralBonusAmount がセットされていればスキップ（冪等）。
 *
 * @param {string} orderId
 * @param {object} order order doc データ
 * @param {object} settings settings/referral のデータ
 */
async function consumeFarmerBonusForOrder(orderId, order, settings) {
  const admin = require("firebase-admin/firestore");
  if (order.referralBonusAmount && order.referralBonusAmount > 0) {
    // 既に消費済み
    return;
  }
  const farmerUid = order.farmerId;
  if (!farmerUid) return;
  const amountKhr = Number(settings.farmerBonusKhr || 0);
  if (amountKhr <= 0) return;

  // トランザクション：pendingFarmerBonus > 0 を確認しつつ -1 + order に記録
  const result = await db.runTransaction(async (tx) => {
    const farmerRef = db.doc(`users/${farmerUid}`);
    const orderRef = db.doc(`orders/${orderId}`);
    const farmerSnap = await tx.get(farmerRef);
    const fresh = farmerSnap.data() || {};
    const remaining = Number(fresh.pendingFarmerBonus || 0);
    if (remaining <= 0) return { consumed: false };
    const orderSnap = await tx.get(orderRef);
    if (orderSnap.data()?.referralBonusAmount > 0) return { consumed: false }; // 2 重防止
    tx.update(farmerRef, {
      pendingFarmerBonus: admin.FieldValue.increment(-1),
      // 6/26 #177: 紹介ボーナスの「獲得合計」（紹介専用ページ A5 が users.referralBonusTotalKhr を表示）。
      referralBonusTotalKhr: admin.FieldValue.increment(amountKhr),
    });
    tx.update(orderRef, {
      referralBonusAmount: amountKhr,
      // 既存 farmerReceiveAmount にも上乗せ
      farmerReceiveAmount: admin.FieldValue.increment(amountKhr),
    });
    return { consumed: true };
  });

  if (!result.consumed) return;
  console.log("Farmer bonus consumed:", farmerUid, "order:", orderId, "amount:", amountKhr);

  // FCM 通知
  try {
    const userSnap = await db.doc(`users/${farmerUid}`).get();
    const lang = userSnap.data()?.lang || "en";
    const vars = { amount: amountKhr.toLocaleString() };
    const { title, body } = getMessage("referralBonusApplied", lang, vars);
    await notifyUser(farmerUid, {
      type: "referral_bonus_applied",
      title, body,
      msgKey: "referralBonusApplied", vars,
      url: "/pages/farmer/payment.html?id=" + orderId,
      orderId,
    });
  } catch (e) {
    console.warn("referralBonusApplied FCM failed:", e.message);
  }
}

/**
 * 案B #171: 注文の辞退／承認前キャンセル時に、買い手へ「即ウォレット返金」する（payment-spec §4.3/§4.5）。
 *  - 返金額 = min(order.subtotal, paymentGroupTotal − グループ内の既返金合計)。
 *    複数農家カートで 1 農家辞退＝その農家の小計を満額返金・クーポン割引は残った農家に残る。
 *    全農家が辞退/キャンセルでグループ全額に達したら、クーポンを未使用に戻す（再利用可）。
 *  - 残高クレジット＋台帳記録＋order の冪等マーカー refundedToWallet を 1 トランザクションで。
 *  - 残高（wallets）書き込みは必ず CF（rules は write:false）。
 * @param {string} orderId
 * @param {object} order   declined/cancelled になった order データ（before/after どちらでも可）
 * @param {'declined'|'cancelled'} reason
 */
async function runRefundToWallet(orderId, order, reason) {
  const admin = require("firebase-admin/firestore");
  if (order.prepaid !== true) return;            // 案B（前払い）注文のみ
  if (order.refundedToWallet === true) return;   // 既に返金済み
  const buyerId = order.restaurantId;
  if (!buyerId) return;
  const groupId = order.paymentGroupId || null;

  // グループ内の order 参照を集める（単一農家なら自分のみ）＋クーポンコード特定
  let groupRefs = [db.doc(`orders/${orderId}`)];
  let couponCode = order.appliedCouponCode || null;
  if (groupId) {
    try {
      const gsnap = await db.collection("orders").where("paymentGroupId", "==", groupId).get();
      if (!gsnap.empty) {
        groupRefs = gsnap.docs.map((d) => d.ref);
        for (const d of gsnap.docs) {
          if (!couponCode && d.data().appliedCouponCode) couponCode = d.data().appliedCouponCode;
        }
      }
    } catch (e) { console.warn("refund group query failed:", e.message); }
  }
  // 農家名（台帳の counterpart 表示用）はトランザクション外で取得
  let farmerName = "";
  try {
    const fs = await db.doc(`users/${order.farmerId}`).get();
    farmerName = fs.data()?.displayName || "";
  } catch (_) { /* ignore */ }

  const walletRef = db.doc(`wallets/${buyerId}`);
  const couponRef = couponCode ? db.doc(`coupons/${couponCode}`) : null;
  const orderNo = order.orderNumber || `FL-${String(orderId).slice(0, 8).toUpperCase()}`;

  let creditedAmount = 0;
  try {
    await db.runTransaction(async (tx) => {
      const orderRef = db.doc(`orders/${orderId}`);
      const oSnap = await tx.get(orderRef);
      const fresh = oSnap.data() || {};
      if (fresh.refundedToWallet === true) return;       // 二重返金防止
      // 7/10 #203 B-2: この order で既に「ウォレット充当分の即返金（walletCancelRefunded）」を
      //   済ませている場合、その額は refundAmount に記録済み＝残額（KHQR分）だけを追加返金する。
      //   通常フロー（辞退・入金確認済キャンセル）は walletCancelRefunded 無し＝priorPartial=0 で従来と同一挙動。
      const priorPartial = fresh.walletCancelRefunded === true ? Number(fresh.refundAmount || 0) : 0;
      // グループ各 order を fresh 読み（既返金合計・残数）
      const groupSnaps = await Promise.all(groupRefs.map((r) => tx.get(r)));
      const wSnap = await tx.get(walletRef);
      const couponSnap = couponRef ? await tx.get(couponRef) : null;

      const paidTotal = Number(fresh.paymentGroupTotal || fresh.totalAmount || 0);
      let alreadyRefunded = 0;
      let othersAllSettled = true;
      for (const gs of groupSnaps) {
        if (gs.id === orderId) continue;
        const gd = gs.data() || {};
        if (gd.refundedToWallet === true) alreadyRefunded += Number(gd.refundAmount || 0);
        else if (gd.status !== "declined" && gd.status !== "cancelled") othersAllSettled = false;
      }
      const base = Number(fresh.subtotal || fresh.totalAmount || 0);
      let refundTotal = Math.min(base, paidTotal - alreadyRefunded);   // この order の返金総額
      if (!isFinite(refundTotal) || refundTotal < 0) refundTotal = 0;
      let refund = refundTotal - priorPartial;                          // 今回クレジットする残額
      if (refund < 0) refund = 0;
      creditedAmount = refund;

      const bal = Number(wSnap.data()?.balance || 0);
      tx.set(walletRef, { buyerId, balance: bal + refund }, { merge: true });
      if (refund > 0) {
        const txRef = db.collection(`wallets/${buyerId}/transactions`).doc();
        tx.set(txRef, {
          amount: refund,
          type: reason === "cancelled" ? "refund_cancelled" : "refund_declined",
          counterpart: farmerName,
          relatedOrderId: orderId,
          orderNumber: orderNo,
          createdAt: admin.FieldValue.serverTimestamp(),
        });
      }
      tx.update(orderRef, {
        refundedToWallet: true,
        refundAmount: refundTotal,
        refundedAt: admin.FieldValue.serverTimestamp(),
      });

      // グループ全額返金に達した＆クーポン使用済みなら未使用に戻す（payment-spec §4.3「全農家辞退→クーポン未使用」）
      if (couponSnap && couponSnap.exists && othersAllSettled
          && (alreadyRefunded + refundTotal) >= paidTotal && couponSnap.data().usedOrderId) {
        tx.update(couponRef, { usedAt: null, usedOrderId: null });
      }
    });
  } catch (e) {
    console.error("runRefundToWallet failed:", orderId, e);
    return;
  }

  // 買い手へ「ウォレットに返金しました」通知（お金が動いた通知は確実に出す＝案Bの安心の核）
  //   7/10 #203 B-2: 今回クレジットした残額が 0 の時（例：deferred で既に全額返金済み）は通知しない。
  if (creditedAmount > 0) {
    try {
      const restSnap = await db.doc(`users/${buyerId}`).get();
      const lang = restSnap.data()?.lang || "en";
      const vars = { farmer: farmerName, amount: creditedAmount.toLocaleString() };
      const msgKey = reason === "cancelled" ? "cancelledRefund" : "declinedRefund";
      const { title, body } = getMessage(msgKey, lang, vars);
      await notifyUser(buyerId, {
        type: "wallet_refund",
        title, body,
        msgKey, vars,
        // 6/29 #185: 辞退／承認前キャンセルの返金通知は「注文状況の辞退カード」へ（spec §3-1）。
        url: "/pages/restaurant/orders.html",
        orderId,
      });
    } catch (e) { console.warn("wallet_refund notify failed:", e.message); }
  }

  console.log("Refunded to wallet:", orderId, reason, "amount:", creditedAmount);
}

/**
 * 7/10 #203 B-2: お支払い確認中（入金未確認）で承認前キャンセルされた前払い注文に対し、
 *   「実際に受け取った分＝ウォレット充当分（作成時に onOrderCreated で実引き落とし済み）」だけを
 *   即ウォレット返金する。KHQR分は未入金の可能性があるため返金しない（未入金で〔支払いました〕→
 *   即キャンセルの穴を塞ぐ）。後で運営が入金確認（depositConfirmed）したら runRefundToWallet が
 *   priorPartial を差し引いて残額（KHQR分）を返金し、そこで初めて refundedToWallet を立てる。
 *   - walletCancelRefunded マーカーで冪等・refundedToWallet は立てない（残額返金の余地を残す）。
 *   - ウォレット全額まかない注文（khqrAmount===0）は cart.html で depositConfirmed=true 作成＝
 *     runRefundToWallet 経路（クーポン un-consume 込み）を通るため、この関数は実質 mixed 注文用。
 * @param {string} orderId
 * @param {object} order  cancelled(before pending) になった前払い注文（after）
 */
async function refundWalletPortionOnCancel(orderId, order) {
  const admin = require("firebase-admin/firestore");
  if (order.prepaid !== true) return;
  if (!(Number(order.walletApplied || 0) > 0)) return;   // ウォレット充当なし＝返金対象なし（穴ふさぎ）
  const buyerId = order.restaurantId;
  if (!buyerId) return;
  let farmerName = "";
  try { farmerName = (await db.doc(`users/${order.farmerId}`).get()).data()?.displayName || ""; } catch (_) { /* ignore */ }
  const walletRef = db.doc(`wallets/${buyerId}`);
  const orderRef = db.doc(`orders/${orderId}`);
  const orderNo = order.orderNumber || `FL-${String(orderId).slice(0, 8).toUpperCase()}`;

  let credited = 0;
  try {
    await db.runTransaction(async (tx) => {
      const oSnap = await tx.get(orderRef);
      const fresh = oSnap.data() || {};
      // 既に（全額 or ウォレット分）返金済みならスキップ（冪等）
      if (fresh.refundedToWallet === true || fresh.walletCancelRefunded === true) return;
      const refund = Number(fresh.walletApplied || 0);
      if (!(refund > 0)) return;
      credited = refund;
      const wSnap = await tx.get(walletRef);
      const bal = Number(wSnap.data()?.balance || 0);
      tx.set(walletRef, { buyerId, balance: bal + refund }, { merge: true });
      const txRef = db.collection(`wallets/${buyerId}/transactions`).doc();
      tx.set(txRef, {
        amount: refund,
        type: "refund_cancelled",
        counterpart: farmerName,
        relatedOrderId: orderId,
        orderNumber: orderNo,
        createdAt: admin.FieldValue.serverTimestamp(),
      });
      // refundedToWallet は立てない（KHQR分の残額を depositConfirmed 後に返金できるように）。
      tx.update(orderRef, {
        walletCancelRefunded: true,
        refundAmount: refund,
        refundedAt: admin.FieldValue.serverTimestamp(),
      });
    });
  } catch (e) {
    console.error("refundWalletPortionOnCancel failed:", orderId, e);
    return;
  }

  if (credited > 0) {
    try {
      const restSnap = await db.doc(`users/${buyerId}`).get();
      const lang = restSnap.data()?.lang || "en";
      const vars = { farmer: farmerName, amount: credited.toLocaleString() };
      const { title, body } = getMessage("cancelledRefund", lang, vars);
      await notifyUser(buyerId, {
        type: "wallet_refund",
        title, body,
        msgKey: "cancelledRefund", vars,
        url: "/pages/restaurant/orders.html",
        orderId,
      });
    } catch (e) { console.warn("walletPortion refund notify failed:", e.message); }
    console.log("Refunded wallet-portion on cancel:", orderId, "amount:", credited);
  }
}

/**
 * 取引完了時に呼ばれるエントリーポイント。
 *  - settings/referral.enabled が false なら全スキップ
 *  - farmer / restaurant それぞれの pendingReferralCode を referredBy に昇格＆特典付与
 *  - farmer の pendingFarmerBonus を 1 消費して order に上乗せ
 */
async function processReferralAndBonus(orderId, order) {
  try {
    const settingsSnap = await db.doc("settings/referral").get();
    const settings = settingsSnap.exists ? settingsSnap.data() : null;
    if (!settings || settings.enabled !== true) {
      console.log("processReferralAndBonus skipped (settings disabled):", orderId);
      return;
    }

    // 双方の referredBy 昇格（順次・トランザクションは内部で）
    if (order.farmerId) {
      await confirmReferralForUser(order.farmerId, settings);
    }
    if (order.restaurantId) {
      await confirmReferralForUser(order.restaurantId, settings);
    }

    // 農家ボーナス消費（毎回・referredBy 確定後のチケットを消費可能）
    if (order.farmerId) {
      await consumeFarmerBonusForOrder(orderId, order, settings);
    }
  } catch (e) {
    console.error("processReferralAndBonus failed:", orderId, e);
  }
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

    // 6/26 #171 案B: 前払いウォレット充当のデビット（CF管理・冪等・残高クランプ）。
    //   買い手は注文時にウォレット残高を充当（walletApplied）＋残額をKHQRで前払い。
    //   ⚠️ 残高デビットは必ずCF側で行う（rules で wallet は write:false）＝クライアント改竄防止。
    //   ・トランザクションで現残高を読み、min(walletApplied, balance) をクランプして減算。
    //   ・order.walletDebited マーカーで at-least-once 再配信の二重デビットを防止（tradeCount と同方式）。
    //   ・複数農家カートでも各 order が自分の walletApplied 分を1回ずつ落とす（wallet doc 上で直列化）。
    if (order.prepaid === true && Number(order.walletApplied) > 0) {
      try {
        const orderRef = event.data.ref;
        const walletRef = db.doc(`wallets/${order.restaurantId}`);
        await db.runTransaction(async (tx) => {
          const oSnap = await tx.get(orderRef);
          if (oSnap.data()?.walletDebited === true) return; // 二重デビット防止
          const wSnap = await tx.get(walletRef);
          const bal = Number(wSnap.data()?.balance || 0);
          const debit = Math.max(0, Math.min(Number(order.walletApplied), bal));
          if (debit > 0) {
            tx.set(walletRef, { buyerId: order.restaurantId, balance: bal - debit }, { merge: true });
            const txRef = db.collection(`wallets/${order.restaurantId}/transactions`).doc();
            tx.set(txRef, {
              amount: -debit,
              type: "order_use",
              counterpart: orderNumber,
              relatedOrderId: event.params.orderId,
              createdAt: admin.FieldValue.serverTimestamp(),
            });
          }
          tx.update(orderRef, { walletDebited: true });
        });
        console.log("Wallet debited (order_use):", event.params.orderId, "applied:", order.walletApplied);
      } catch (e) {
        console.error("wallet debit failed:", event.params.orderId, e);
      }
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

    // 承認期限（注文 + 1.5h・夜間21:00–5:00は翌朝5:00起点にリセット・KHM表示）#196
    //   js/approval-deadline.js と同一ロジック（上部 CommonJS ヘルパー）。
    const deadlineMs = computeApprovalDeadlineMs(createdAtMs);
    const deadline = formatKhmHm(deadlineMs);
    // schedulers/clients 用に order へ永続化（deadline ベースの自動辞退/リマインドの基点）
    await event.data.ref.update({ approveDeadline: admin.Timestamp.fromMillis(deadlineMs) });

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
      // #142/#143 キャンセル（買い手が承認前にキャンセル）→ 両者の関連todoを全て解消（辞退と同様・承認期限停止）
      if (after.status === "cancelled") {
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
        // 6/26 #171 案B: 前払い注文は受取時払いが無い＝買い手の支払いtodoを作らない。
        if (after.prepaid !== true) {
          await createTodo(after.restaurantId, 'rest_pay', orderId);
        }

        // 6/10 #137/#138: 取引完了の累計（プロフィールの信頼ブロック「取引N件」・spec §5）。
        //   農家・レストラン双方の users.tradeCount を +1。辞退/キャンセル（'declined' 等）は
        //   completed にならず数えない。
        //   ⚠️ statusChanged ガードは「ユニークなイベント1回」では二重発火しないが、
        //      Cloud Functions の onDocumentUpdated は at-least-once（同一イベントの再配信あり）で、
        //      increment は非冪等。よって注文ドキュメントの一度きりマーカー tradeCounted を
        //      トランザクションで立て、既に立っていればスキップ＝再配信・バックフィルとの二重計上を防ぐ
        //      （同ブロックの consumeFarmerBonusForOrder と同方式）。既存の完了済み注文は
        //      functions/scripts/backfill-tradecount.js が同じマーカー方式で一度だけ埋める。
        const orderRef = event.data.after.ref;
        try {
          await db.runTransaction(async (tx) => {
            const snap = await tx.get(orderRef);
            if (!snap.exists || snap.data()?.tradeCounted === true) return; // 再配信/集計済みはスキップ
            const inc = admin.FieldValue.increment(1);
            if (after.farmerId) tx.set(db.doc(`users/${after.farmerId}`), { tradeCount: inc }, { merge: true });
            if (after.restaurantId) tx.set(db.doc(`users/${after.restaurantId}`), { tradeCount: inc }, { merge: true });
            tx.update(orderRef, { tradeCounted: true });
          });
        } catch (e) {
          console.error('tradeCount tx failed', orderId, e);
        }

        // 5/24 #82 Phase 2 Chunk 2: 紹介関係の確定 + 双方特典付与 + 農家ボーナス消費
        // - referredBy 未確定の場合は pendingReferralCode を referredBy に昇格 + 双方に特典発行
        // - 農家側は毎回 pendingFarmerBonus を 1 消費して order に上乗せ
        // - settings/referral.enabled が false なら全スキップ（冪等・失敗してもログのみ）
        await processReferralAndBonus(orderId, after);

        // 配送完了時刻を記録（問題報告の期限・案Bの自動取引完了の基点 = completedAt + N時間）。
        // 6/26 #171 案B: 前払い注文は受取時払いの支払期限・督促 push を作らない（completedAt のみ）。
        //   旧（受取時払い）注文だけ paymentDeadline + paymentDeadlineSet push を維持。
        if (!after.completedAt) {
          const now = new Date();
          if (after.prepaid === true) {
            await event.data.after.ref.update({ completedAt: now });
            // 6/29 #185: 前払い注文は受取時払い通知が無い＝買い手へ「お届け」通知を出す（spec §3-1・農家名のみ）。
            try {
              const restSnapC = await db.doc(`users/${after.restaurantId}`).get();
              const langC = restSnapC.data()?.lang || "en";
              const farmerSnapC = await db.doc(`users/${after.farmerId}`).get();
              const farmerNameC = farmerSnapC.data()?.displayName || "Farmer";
              const dVars = { farmer: farmerNameC };
              const dMsg = getMessage("deliveredToBuyer", langC, dVars);
              await notifyUser(after.restaurantId, {
                type: "order_delivered",
                title: dMsg.title, body: dMsg.body,
                msgKey: "deliveredToBuyer", vars: dVars,
                url: `/pages/restaurant/orders.html`,
                orderId,
              });
            } catch (e) { console.warn("deliveredToBuyer notify failed:", e.message); }
          } else {
            const deadline = new Date(now.getTime() + 10 * 60 * 1000);
            await event.data.after.ref.update({
              completedAt: now,
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

    // 6/29 #185: 問題が報告された → 農家へ通知（送金保留・spec §3-2）。paymentProblemHold false→true の遷移で1回。
    //   買い手 report.html が orders.paymentProblemHold=true を立てる（#129/#150）。
    if (before.paymentProblemHold !== true && after.paymentProblemHold === true) {
      try {
        const farmerSnapP = await db.doc(`users/${after.farmerId}`).get();
        const langP = farmerSnapP.data()?.lang || "en";
        const restSnapP = await db.doc(`users/${after.restaurantId}`).get();
        const restNameP = restSnapP.data()?.displayName || "Restaurant";
        const pVars = { restaurant: restNameP };
        const pMsg = getMessage("problemReportedFarmer", langP, pVars);
        await notifyUser(after.farmerId, {
          type: "problem_reported",
          title: pMsg.title, body: pMsg.body,
          msgKey: "problemReportedFarmer", vars: pVars,
          url: `/pages/farmer/payment.html?id=${orderId}`,
          orderId,
        });
      } catch (e) { console.warn("problemReportedFarmer notify failed:", e.message); }
    }

    // 6/29 #185: お支払い未確認 → 買い手へ通知（spec §3-1）。paymentUnconfirmed false→true。
    //   運営が入金照合で「未確認」判定した瞬間（admin UI は別途＝前方互換で trigger を用意）。
    if (before.paymentUnconfirmed !== true && after.paymentUnconfirmed === true) {
      try {
        const restSnapU = await db.doc(`users/${after.restaurantId}`).get();
        const langU = restSnapU.data()?.lang || "en";
        const uMsg = getMessage("paymentUnconfirmed", langU, {});
        await notifyUser(after.restaurantId, {
          type: "payment_unconfirmed",
          title: uMsg.title, body: uMsg.body,
          msgKey: "paymentUnconfirmed", vars: {},
          url: `/pages/restaurant/payment.html?id=${orderId}`,
          orderId,
        });
      } catch (e) { console.warn("paymentUnconfirmed notify failed:", e.message); }
    }

    // 7/10 #203/#204 B-2: 入金確認（depositConfirmed false→true）が「既にキャンセル済み」の前払い注文に
    //   効いたら deferred ウォレット返金（お支払い確認中でキャンセル→後から入金が確認できたケース）。
    //   ウォレット充当分は既に refundWalletPortionOnCancel で返金済みなら、runRefundToWallet が
    //   priorPartial を差し引いて残額（KHQR分）だけ返金する。refundedToWallet で冪等。
    if (before.depositConfirmed !== true && after.depositConfirmed === true
        && after.status === "cancelled" && after.prepaid === true && after.refundedToWallet !== true) {
      await runRefundToWallet(orderId, after, "cancelled");
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

    // #142/#143 キャンセル時：在庫復元（承認前キャンセル＝注文時に減らした在庫を戻す）。
    //   ★ before.status === 'pending' を必須にする＝「承認前キャンセル」だけ在庫を戻す。
    //     クライアントの競合ロック（トランザクション）に加えたサーバ側ガード。承認後（在庫は
    //     差し引かれたまま）など pending 以外からの cancelled では在庫を戻さない＝過剰復元を防ぐ。
    //   at-least-once 再配信での二重復元も、注文ドキュメントの一度きりマーカー
    //   cancelStockRestored をトランザクションで立てて防ぐ（tradeCount と同方式・冪等）。
    if (after.status === "cancelled" && before.status === "pending") {
      const orderRef = event.data.after.ref;
      try {
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(orderRef);
          if (!snap.exists || snap.data()?.cancelStockRestored === true) return;
          const items = Array.isArray(after.items) && after.items.length > 0
            ? after.items
            : (after.listingId ? [{ listingId: after.listingId, quantity: after.quantity }] : []);
          for (const it of items) {
            if (!it.listingId || !it.quantity) continue;
            tx.set(db.doc(`fishListings/${it.listingId}`),
              { stock: admin.FieldValue.increment(it.quantity) }, { merge: true });
          }
          tx.update(orderRef, { cancelStockRestored: true });
        });
        console.log("Stock restored (cancel):", orderId);
      } catch (e) {
        console.error("cancel stock restore failed", orderId, e);
      }
    }

    // 6/26 #171 案B: 前払い注文の辞退／承認前キャンセル → 買い手へ即ウォレット返金（小計満額・グループ按分）。
    //   手動辞退も自動辞退も対象（自動辞退の早期 return より前に実行）。返金通知も runRefundToWallet が送る。
    if (after.prepaid === true) {
      if (after.status === "declined" && before.status !== "declined") {
        await runRefundToWallet(orderId, after, "declined");
      } else if (after.status === "cancelled" && before.status === "pending") {
        // 7/10 #203 B-2:「実際に受け取ったお金だけ返金」。
        //   入金確認済（depositConfirmed）→ 全額（subtotal・group/coupon 込み）を即返金。
        //   未確認（お支払い確認中）→ ウォレット充当分（作成時に onOrderCreated で実引き落とし済み）
        //     だけを即返金し、KHQR分は未入金の可能性があるため返金しない（穴ふさぎ）。
        //     後で運営が入金確認したら下記 depositConfirmed 遷移で deferred に残額を返金。
        if (after.depositConfirmed === true) {
          await runRefundToWallet(orderId, after, "cancelled");
        } else {
          await refundWalletPortionOnCancel(orderId, after);
        }
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

    // #142/#143 買い手キャンセル（承認前）→ 農家へ通知（辞退＝農家都合とは別ラベル）。
    //   before.status === 'pending' の正当な遷移のみ通知（承認後など不正遷移では通知しない）。
    if (after.status === "cancelled" && before.status === "pending") {
      const farmerLang = farmerSnap.data()?.lang || "en";
      const restName = restData.displayName || "Restaurant";
      const cVars = { restaurant: restName, fish: fishName, qty: qtyLabel };
      const cMsg = getMessage("cancelled", farmerLang, cVars);
      await notifyUser(after.farmerId, {
        type: "order_cancelled",
        title: cMsg.title, body: cMsg.body,
        msgKey: "cancelled", vars: cVars,
        url: `/pages/farmer/orders.html`,
        orderId,
      });
      console.log("Cancel notification sent to farmer:", after.farmerId, "lang:", farmerLang);
      return;
    }

    // 6/26 #171 案B: 前払い注文の辞退通知は runRefundToWallet が「ウォレットに返金しました」を送るため、
    //   ここでの declined 通知は重複させない（approved は買い手へ通知を出す）。
    if (after.status === "declined" && after.prepaid === true) {
      return;
    }

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

// 5/23 #81: ボイスメッセージ用テンプレート（本文は秒数を埋め込み）
const CHAT_VOICE_MESSAGES = {
  ja: { title: "{{sender}} からメッセージ", body: "ボイスメッセージ ({{sec}}秒)" },
  en: { title: "Message from {{sender}}", body: "Voice message ({{sec}}s)" },
  km: { title: "សារពី {{sender}}", body: "សារសំឡេង ({{sec}} វិនាទី)" },
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

    // 5/23 #81: ボイスメッセージは別テンプレ（本文は秒数）。クライアント側で voice.notifBody での再翻訳も可能。
    const isVoice = msg.type === 'voice';
    const tmpl = isVoice
      ? (CHAT_VOICE_MESSAGES[lang] || CHAT_VOICE_MESSAGES.en)
      : (CHAT_MESSAGES[lang] || CHAT_MESSAGES.en);
    const truncText = (msg.text || "").substring(0, 50);
    const sec = String(Math.max(0, Math.floor(msg.voiceDurationSec || 0)));
    const title = tmpl.title.replace("{{sender}}", senderName);
    const body = isVoice
      ? tmpl.body.replace("{{sec}}", sec)
      : tmpl.body.replace("{{sender}}", senderName).replace("{{text}}", truncText);

    const isFarmer = toUid === order.farmerId;
    const chatUrl = isFarmer
      ? `/pages/farmer/delivery.html?id=${orderId}`
      : `/pages/restaurant/delivery.html?id=${orderId}`;

    // 6/29 #185: 配送ステータスのシステム行（type:'chat'+statusKind）は、買い手の行動が変わる
    //   3つ（配送開始 ship_start／到着 arrived／少し遅れそう delay）だけ専用文言でプッシュ（spec §3-3 B）。
    //   準備開始（prepare_start）等はチャットのシステム行に出すのみ＝プッシュしない。
    //   （todo は上で通常どおり処理済み＝ここでは push のみ制御）
    if (msg.statusKind) {
      const DELIVERY_PUSH = { ship_start: "deliveryStarted", arrived: "deliveryArrived", delay: "deliveryDelayed" };
      const dvKey = DELIVERY_PUSH[msg.statusKind];
      if (!dvKey) {
        console.log("Skip status push (not a buyer-facing delivery status):", orderId, msg.statusKind);
        return;
      }
      const dvVars = { farmer: senderName };
      const dv = getMessage(dvKey, lang, dvVars);
      await notifyUser(toUid, {
        type: `delivery_${msg.statusKind}`,
        title: dv.title, body: dv.body,
        msgKey: dvKey, vars: dvVars,
        url: chatUrl,
        orderId,
      });
      console.log("Delivery status push sent:", orderId, msg.statusKind, "→", toUid);
      return;
    }

    await notifyUser(toUid, {
      type: isVoice ? "chat_voice_message" : "chat_message",
      title, body,
      msgKey: isVoice ? "voiceNotif" : "chatMessage",
      vars: isVoice ? { sender: senderName, sec } : { sender: senderName, text: truncText },
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

  // レストランへ通知（6/26 #171 案B: 前払い注文は onOrderUpdated→runRefundToWallet が
  //   「ウォレットに返金しました」通知を送るため、ここでの期限切れ辞退通知は重複させない）。
  if (order.prepaid !== true) {
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
    // #196: 承認期限は必ず createdAt+1.5h 以降（夜間は更に後ろ）。よって createdAt < now−90分 は
    //   期限切れ注文の SUPERSET。既存の複合インデックス（status 等値 + createdAt 範囲）を維持しつつ
    //   広めに拾い、ループ内で実際の approveDeadline を見て本当に過ぎたものだけ辞退する。
    const now = Date.now();
    const ninetyMinAgo = new Date(now - 90 * 60 * 1000);

    let snap;
    try {
      snap = await db.collection("orders")
        .where("status", "==", "pending")
        .where("createdAt", "<", ninetyMinAgo)
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
      const o = doc.data();
      const dl = o.approveDeadline?.toMillis?.()
        ?? computeApprovalDeadlineMs(o.createdAt?.toMillis?.() || 0);
      if (now > dl) await autoDeclineOrder(doc);
    }
  }
);

// 5/25 #88: 承認期限 10 分前リマインド（毎分実行）
//   pending 注文で createdAt が 50 分前以前（= 残り 10 分以下）かつ approvalReminderSent != true を対象。
//   通知後は approvalReminderSent=true をセットして 1 回しか発火させない。
//   autoDeclineExpiredOrders は 5 分間隔なので、最大で deadline 後 5 分まで辞退されずに通知が走る可能性
//   があるが、辞退時の expired 通知が別途送られるため UX 上の問題はない。
exports.remindApproveDeadline = onSchedule(
  { schedule: "every 1 minutes", region: "asia-southeast1" },
  async () => {
    // #196: 承認期限は createdAt+1.5h 以降（夜間は更に後ろ）。リマインドは deadline−10分に発火するので
    //   now >= dl−10分 ⇒ createdAt <= now−80分。よって createdAt < now−80分 が候補の SUPERSET。
    //   （既存の status 等値 + createdAt 範囲 の複合インデックスを維持）
    const now = Date.now();
    const eightyMinAgo = new Date(now - 80 * 60 * 1000);

    let snap;
    try {
      // status=pending かつ createdAt < 80分前 を取得（インデックス: status + createdAt 既存）
      snap = await db.collection("orders")
        .where("status", "==", "pending")
        .where("createdAt", "<", eightyMinAgo)
        .get();
    } catch (e) {
      console.warn("remindApproveDeadline query failed:", e.message);
      return;
    }
    if (snap.empty) return;

    const admin = require("firebase-admin/firestore");
    for (const docSnap of snap.docs) {
      const order = docSnap.data();
      // 既に通知済はスキップ
      if (order.approvalReminderSent === true) continue;
      // 実際の承認期限を算出（保存値優先・無ければ createdAt から再計算）
      const dl = order.approveDeadline?.toMillis?.()
        ?? computeApprovalDeadlineMs(order.createdAt?.toMillis?.() || 0);
      // 既に期限切れ（autoDecline に任せる）はスキップ
      if (now >= dl) continue;
      // 期限 10 分前より手前ならまだ早い（次回ループで発火）
      if (now < dl - 10 * 60 * 1000) continue;

      const orderId = docSnap.id;
      try {
        // farmer の言語で通知
        const farmerSnap = await db.doc(`users/${order.farmerId}`).get();
        const lang = farmerSnap.data()?.lang || "ja";
        const restSnap = await db.doc(`users/${order.restaurantId}`).get();
        const restaurant = restSnap.data()?.displayName || "";
        const fishTypeKey = order.snapFishType || "";
        // i18n 化された魚種ラベル（getMessage の vars に渡す前にこちらで解決）
        const fishLabel = fishTypeKey
          ? (lang === "ja" ? fishTypeKey : (lang === "km" ? fishTypeKey : fishTypeKey))
          : "";
        const vars = {
          restaurant,
          fish: fishLabel,
          qty: order.quantity || 0,
        };
        const { title, body } = getMessage("approveDeadlineReminder", lang, vars);
        await notifyUser(order.farmerId, {
          type: "approve_deadline_reminder",
          title, body,
          msgKey: "approveDeadlineReminder", vars,
          url: "/pages/farmer/orders.html",
          orderId,
        });
        // 通知済みフラグをセット（次回ループでスキップ）
        await docSnap.ref.update({ approvalReminderSent: true, approvalReminderSentAt: admin.FieldValue.serverTimestamp() });
        console.log("Approve deadline reminder sent for order:", orderId);
      } catch (e) {
        console.warn("remindApproveDeadline failed for", orderId, ":", e.message);
      }
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
    const nowMs = Date.now();
    for (const orderDoc of pendingSnap.docs) {
      const order = orderDoc.data();
      const createdAtMs = order.createdAt?.toMillis?.() || 0;
      if (createdAtMs === 0) continue;
      // #196: 実際の承認期限（保存値優先・無ければ再計算）を過ぎていなければスキップ
      const dl = order.approveDeadline?.toMillis?.() ?? computeApprovalDeadlineMs(createdAtMs);
      if (nowMs <= dl) continue;
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
      let orderData = null; // #196: フォールバックで承認期限を見るため上位スコープで保持

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
          orderData = orderSnap.data();
          const orderStatus = orderData.status;
          shouldClear = orderStatus === 'declined' || !validStatuses.includes(orderStatus);
        }
      }

      // フォールバック: farmer_approve は承認期限まで有効。#196 で期限が夜間注文だと最大 ~9.5h まで
      //   伸びるため、固定 90 分では有効な夜間注文の todo を誤って閉じてしまう。
      //   → 実際の承認期限（保存値優先・無ければ再計算）+ 30 分の猶予を過ぎた場合のみ孤立扱い。
      if (!shouldClear && todo.type === 'farmer_approve' && orderData) {
        const createdAtMs = orderData.createdAt?.toMillis?.() || 0;
        if (createdAtMs) {
          const dl = orderData.approveDeadline?.toMillis?.() ?? computeApprovalDeadlineMs(createdAtMs);
          if (Date.now() > dl + 30 * 60 * 1000) {
            shouldClear = true;
          }
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

    // ── 6/5 #128: コメントの連絡先マスクをサーバ側で再検証（バイパス防止）＋ 要確認レポート生成 ──
    const orderId = event.params.orderId;
    const reviewId = event.params.reviewId; // 'restaurant' | 'farmer'
    const rawComment = review.rawComment || review.comment || "";
    if (rawComment) {
      const det = maskContactsServer(rawComment);
      if (det.hit) {
        // クライアントがマスクせず保存した場合に備えて上書き
        if (review.comment !== det.masked || review.masked !== true) {
          try {
            await db.doc(`orders/${orderId}/reviews/${reviewId}`)
              .set({ comment: det.masked, masked: true }, { merge: true });
          } catch (e) { console.warn("review re-mask update failed:", e); }
        }
        await createReviewContactReport({
          orderId,
          reviewId,
          fromUid: review.fromUid,
          fromRole,
          reportedUid: toUid,
          maskedText: det.masked,
        });
      }
    }

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
      // 6/26 #171 案B: 前払い注文は受取時払いの督促対象外（未払い注文は存在しない＝督促を出さない）。
      if (order.prepaid === true) continue;
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

// ── 6/26 #171 案B: 配送完了 + 問題報告ウィンドウ経過で「取引完了」を自動確定（5分ごと） ──
//   旧 checkPaymentDeadlineExpired（受取時払い督促）の置換的役割。前払い注文のみ対象。
//   completedAt から settings/campaign.reportWindowHours（既定4時間）経過し、問題報告（paymentProblemHold）が
//   無ければ tradeCompleted を立てる → 買い手「完了」・送金解禁・レビュー解禁。送金の実行は運営手動（不変）。
//   ※ status=='completed' のみクエリ（複合インデックス不要）→ コードで前払い/未完了/期限経過/保留なしを絞る。
exports.autoCompleteTrades = onSchedule(
  { schedule: "every 5 minutes", region: "asia-southeast1" },
  async () => {
    const admin = require("firebase-admin/firestore");
    let windowH = 4;
    try {
      const s = await db.doc("settings/campaign").get();
      const v = Number(s.data()?.reportWindowHours);
      if (isFinite(v) && v > 0) windowH = v;
    } catch (_) { /* default 4 */ }
    const cutoffMs = Date.now() - windowH * 60 * 60 * 1000;

    let snap;
    try {
      snap = await db.collection("orders").where("status", "==", "completed").get();
    } catch (e) {
      console.error("[autoCompleteTrades] query failed:", e.message);
      return;
    }
    let n = 0;
    for (const d of snap.docs) {
      const o = d.data();
      if (o.prepaid !== true) continue;            // 案B（前払い）注文のみ
      if (o.tradeCompleted === true) continue;     // 既に取引完了
      if (o.paymentProblemHold === true) continue; // 問題報告で保留中は確定しない
      const completedAtMs = o.completedAt?.toMillis?.() ? o.completedAt.toMillis() : 0;
      if (!completedAtMs || completedAtMs > cutoffMs) continue; // まだ窓内
      try {
        await d.ref.update({
          tradeCompleted: true,
          tradeCompletedAt: admin.FieldValue.serverTimestamp(),
        });
        n++;
        // 6/29 #185: 取引完了 → 買い手へレビュー誘導通知（spec §3-1・買い手のレビュー解禁は tradeCompleted）。
        try {
          const restSnapT = await db.doc(`users/${o.restaurantId}`).get();
          const langT = restSnapT.data()?.lang || "en";
          const farmerSnapT = await db.doc(`users/${o.farmerId}`).get();
          const farmerNameT = farmerSnapT.data()?.displayName || "Farmer";
          const tVars = { farmer: farmerNameT };
          const tMsg = getMessage("tradeCompletedReview", langT, tVars);
          await notifyUser(o.restaurantId, {
            type: "trade_completed",
            title: tMsg.title, body: tMsg.body,
            msgKey: "tradeCompletedReview", vars: tVars,
            url: `/pages/restaurant/review.html?id=${d.id}`,
            orderId: d.id,
          });
        } catch (e) { console.warn("tradeCompletedReview notify failed:", d.id, e.message); }
      } catch (e) {
        console.error("[autoCompleteTrades] update failed:", d.id, e.message);
      }
    }
    if (n > 0) console.log(`[autoCompleteTrades] trade-completed: ${n}`);
  }
);

// ── 6/29 #185: 紹介クーポン 期限リマインド（期限3日前に1回・未使用の人だけ・spec §5）──
//   毎日 09:00 カンボジア時間（= 02:00 UTC）に実行。
//   ⚠️ 単一フィールド range（expiresAt <）のみで複合インデックス不要。usedAt/期限内/送信済みはコードで絞る。
//      expiryReminderSent マーカーで 1 回だけ発火。
exports.remindCouponExpiry = onSchedule(
  { schedule: "0 2 * * *", timeZone: "UTC", region: "asia-southeast1" },
  async () => {
    const admin = require("firebase-admin/firestore");
    const now = new Date();
    const in3Days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    let snap;
    try {
      // 両端とも同一フィールド（expiresAt）の range ＝単一フィールドindexで足りる（複合index不要）。
      // 下限 now で「既に期限切れ」を読み込み対象から除外＝読み取り集合が3日窓に限定され、増え続けない。
      snap = await db.collection("coupons")
        .where("expiresAt", ">", now)
        .where("expiresAt", "<", in3Days)
        .get();
    } catch (e) {
      console.error("[remindCouponExpiry] query failed:", e.message);
      return;
    }
    let n = 0;
    for (const d of snap.docs) {
      const c = d.data();
      if (c.usedAt) continue;                       // 使用済みは除外
      if (c.expiryReminderSent === true) continue;  // 既に送信済み
      const expMs = c.expiresAt?.toMillis?.() || 0;
      if (!expMs || expMs <= now.getTime()) continue; // 既に期限切れは除外（3日以内かつ未来のみ）
      if (!c.ownerUid) continue;
      try {
        const uSnap = await db.doc(`users/${c.ownerUid}`).get();
        const lang = uSnap.data()?.lang || "en";
        const daysLeft = Math.max(1, Math.ceil((expMs - now.getTime()) / (24 * 60 * 60 * 1000)));
        const vars = { amount: Number(c.amountKhr || 0).toLocaleString(), days: String(daysLeft) };
        const { title, body } = getMessage("couponExpiringSoon", lang, vars);
        await notifyUser(c.ownerUid, {
          type: "coupon_expiring",
          title, body,
          msgKey: "couponExpiringSoon", vars,
          url: "/pages/restaurant/cart.html",
        });
        await d.ref.update({ expiryReminderSent: true });
        n++;
      } catch (e) {
        console.warn("[remindCouponExpiry] failed for", d.id, ":", e.message);
      }
    }
    if (n > 0) console.log(`[remindCouponExpiry] sent: ${n}`);
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

// 5/5 #6: users コレクション変更時に adminUids キャッシュを自動再生成
//   問題: 新しい admin が登録された際 settings/adminUids にUIDが追加されず、
//          トラブル報告通知が新admin に届かない（CLAUDE.mdの既知の運用課題）
//   対策: 作成・更新で role が 'admin' になった瞬間にキャッシュを破棄。
//          次回 getAdminUids() 呼び出しで users をスキャンし直して再生成される。
exports.onUserCreated = onDocumentCreated(
  {
    document: "users/{uid}",
    region: "asia-southeast1",
    database: "(default)",
  },
  async (event) => {
    const data = event.data?.data() || {};
    if (data.role === 'admin') {
      await invalidateAdminUidsCache(`new admin created: ${event.params.uid}`);
    }
  }
);

exports.onUserUpdated = onDocumentUpdated(
  {
    document: "users/{uid}",
    region: "asia-southeast1",
    database: "(default)",
  },
  async (event) => {
    const before = event.data.before.data() || {};
    const after = event.data.after.data() || {};
    // role 変化（admin になる/admin から外れる）または既存 admin の有効/無効切替
    if (before.role !== after.role && (before.role === 'admin' || after.role === 'admin')) {
      await invalidateAdminUidsCache(`admin role changed: ${event.params.uid} ${before.role}→${after.role}`);
    }
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

// ── 一回限り: 既存の完了済み注文から users.tradeCount を集計（管理者のみ・冪等・再実行可） ──
// 6/10 #137/#138: プロフィールの信頼ブロック「取引N件」のバックフィル（admin/settings.html のボタンから実行）。
//   ライブ集計（onOrderUpdated）と同じ「increment + 注文の一度きりマーカー tradeCounted」方式の
//   トランザクションで処理＝同時実行・再実行しても二重計上しない（マーカー済みはスキップ）。
//   タイムアウト時は再クリックで続きから（マーカー済みをスキップして再開）。
//   functions/scripts/backfill-tradecount.js は UI 不可/大量データ時のフォールバック（同一ロジック）。
exports.backfillTradeCount = onCall(
  {
    region: "asia-southeast1",
    timeoutSeconds: 540,
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
    const admin = require("firebase-admin/firestore");

    const snap = await db.collection("orders").where("status", "==", "completed").get();
    let counted = 0, skipped = 0, failed = 0;
    for (const docSnap of snap.docs) {
      const oref = docSnap.ref;
      try {
        const res = await db.runTransaction(async (tx) => {
          const o = await tx.get(oref);
          if (!o.exists) return false;
          const data = o.data() || {};
          if (data.tradeCounted === true) return false; // 集計済み（再実行 or ライブが先に処理）
          const inc = admin.FieldValue.increment(1);
          if (data.farmerId) tx.set(db.doc(`users/${data.farmerId}`), { tradeCount: inc }, { merge: true });
          if (data.restaurantId) tx.set(db.doc(`users/${data.restaurantId}`), { tradeCount: inc }, { merge: true });
          tx.update(oref, { tradeCounted: true });
          return true;
        });
        if (res) counted++; else skipped++;
      } catch (e) {
        console.error("backfillTradeCount tx failed", docSnap.id, e);
        failed++;
      }
    }
    return { total: snap.size, counted, skipped, failed };
  }
);

// ── 6/17 #151: SMS-OTP パスワードリセット（合成メール口座のパスワード更新） ──
// 電話番号 → 正規化（+855XXXXXXXX / 855... / 0XX... → 855XXXXXXXX）。js/firebase-config.js と同ロジック。
function normalizePhoneServer(raw) {
  if (!raw) return "";
  let s = String(raw).replace(/[^\d+]/g, "");
  if (!s) return "";
  if (s.startsWith("+855")) s = s.slice(1);
  else if (s.startsWith("855")) { /* keep */ }
  else if (s.startsWith("0")) s = "855" + s.slice(1);
  else s = "855" + s;
  s = s.replace(/\D/g, "");
  return s;
}

// クライアントは Firebase Phone Auth（電話番号OTP）で番号所有を検証し、ログイン状態（phone provider）で
// 本callableを呼ぶ。本callableは request.auth.token.phone_number（検証済みの+855番号）を信頼し、
// その番号で登録された {phone}@fishlink.local 口座を Firestore users.phone で引いてパスワードを更新する。
//   ＝自分の検証済み番号で登録した口座のパスワードしか変えられない（なりすまし・総当たり不可）。
//   番号の有無は呼び出し側に漏らさない（未登録でも ok を返す＝総当たり防止）。
exports.resetPasswordWithPhone = onCall(
  { region: "asia-southeast1", invoker: "public", cors: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }
    // Phone Auth で検証された電話番号（E.164・例 +85512345678）。なければ拒否。
    const tokenPhone = request.auth.token && request.auth.token.phone_number;
    if (!tokenPhone) {
      throw new HttpsError("permission-denied", "Phone verification required");
    }
    const newPassword = request.data && request.data.newPassword;
    if (!newPassword || typeof newPassword !== "string" || newPassword.length < 6) {
      throw new HttpsError("invalid-argument", "Password must be at least 6 characters");
    }
    const normalized = normalizePhoneServer(tokenPhone);
    if (!/^855\d{8,9}$/.test(normalized)) {
      throw new HttpsError("invalid-argument", "Invalid phone number");
    }
    const userSnap = await db.collection("users")
      .where("phone", "==", normalized).limit(1).get();
    // 番号の有無は漏らさない（未登録でも成功扱いで返す＝総当たり防止）。
    if (userSnap.empty) {
      return { ok: true };
    }
    const uid = userSnap.docs[0].id;
    await getAuth().updateUser(uid, { password: newPassword });
    return { ok: true };
  }
);

// ── 🎬 7/9 #199: リール動画 保持N上限（出品ごと最新10本・古いものから物理削除） ──
//   ポートフォリオ化（差し替えても消さない）と両立するストレージ有界化。
//   「最新10本を残して超過分（最古）だけ物理削除」＝収束的＝onDocumentCreated の at-least-once 再配信でも
//   ≤10 のときは no-op で安全（冪等）。反例＝絶対数 SET 系ではないので二重計上リスクなし。
const MAX_REELS_PER_LISTING = 10;
exports.onReelVideoCreated = onDocumentCreated(
  {
    document: "reel_videos/{videoId}",
    region: "asia-southeast1",
    database: "(default)",
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const listingId = snap.data()?.listingId;
    if (!listingId) return;

    // その出品の全リールを取得（equality のみ＝複合インデックス不要・並べ替えはコード側）。
    const qs = await db.collection("reel_videos").where("listingId", "==", listingId).get();
    if (qs.size <= MAX_REELS_PER_LISTING) return;

    const docs = qs.docs.slice().sort((a, b) => {
      const ta = a.data().postedAt?.toMillis ? a.data().postedAt.toMillis() : 0;
      const tb = b.data().postedAt?.toMillis ? b.data().postedAt.toMillis() : 0;
      return ta - tb; // 古い順
    });
    const toDelete = docs.slice(0, docs.length - MAX_REELS_PER_LISTING); // 最古の超過分
    const bucket = getStorage().bucket();
    for (const d of toDelete) {
      const sp = d.data().storagePath;
      if (sp) {
        try { await bucket.file(sp).delete(); }
        catch (e) { /* 404 等は無視 */ }
      }
      try { await d.ref.delete(); } catch (e) { /* ignore */ }
    }
    console.log(`[reel-retention] listing=${listingId} kept=${MAX_REELS_PER_LISTING} deleted=${toDelete.length}`);
  }
);

// ── 🎬 7/9 #199: 出品「完全削除」で動画を道連れ物理削除（orphan を作らない） ──
//   投稿一覧の「完全削除」は実体はソフトデリート（deletedAt セット＋isActive:false・出品docは残す）。
//   ＝deletedAt が null→set に遷移したときだけ、その出品の全リールを Storage 実体ごと物理削除。
//   「停止」（isActive:false のみ・deletedAt なし）は遷移条件に当たらない＝動画は保持（アーカイブに残す）＝spec §6。
exports.onFishListingDeletedCascade = onDocumentUpdated(
  {
    document: "fishListings/{listingId}",
    region: "asia-southeast1",
    database: "(default)",
  },
  async (event) => {
    const before = event.data.before.data() || {};
    const after = event.data.after.data() || {};
    if (before.deletedAt || !after.deletedAt) return; // null→set 遷移以外は何もしない

    const listingId = event.params.listingId;
    const qs = await db.collection("reel_videos").where("listingId", "==", listingId).get();
    if (qs.empty) return;

    const bucket = getStorage().bucket();
    for (const d of qs.docs) {
      const sp = d.data().storagePath;
      if (sp) {
        try { await bucket.file(sp).delete(); }
        catch (e) { /* 404 等は無視 */ }
      }
      try { await d.ref.delete(); } catch (e) { /* ignore */ }
    }
    console.log(`[reel-cascade] listing=${listingId} deletedReels=${qs.size} (owner deleted listing)`);
  }
);

// ── 6/22 #166: 電話番号の自己変更（合成メール口座のログイン番号＝メールを移行つきで更新） ──
//   識別子は {phone}@fishlink.local（合成メール）なので、電話番号を変える＝Auth のメールを変える。
//   オーケストレーションの肝：クライアントは「合成メールの本人」と「Phone Auth の新番号ユーザー」に
//   同時にはサインインできない。そこで本人セッションは保ったまま、新番号の OTP 検証だけを
//   secondary Firebase app で行い、その phone-provider ユーザーの IDトークン(phoneIdToken=新番号 検証済み)を
//   本callable に渡す。
//   本callable は：
//     ① request.auth.uid＝本人（＝変更対象の口座。本人の口座しか変えられない＝なりすまし不可）
//     ② phoneIdToken を verifyIdToken して phone_number（検証済み新番号）を取り出す（新番号の所有を server 検証）
//   の2つの server 検証で、本人の口座のメール＋Firestore users.phone を新番号へ更新する。
//   重複は Firestore 事前チェック＋Auth のメール一意制約（email-already-exists）で二重に防ぐ。
exports.changePhoneWithOtp = onCall(
  { region: "asia-southeast1", invoker: "public", cors: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }
    const uid = request.auth.uid; // ＝本人（変更対象の口座）。本人以外は変えられない。
    const phoneIdToken = request.data && request.data.phoneIdToken;
    if (!phoneIdToken || typeof phoneIdToken !== "string") {
      throw new HttpsError("permission-denied", "Phone verification required");
    }
    // 新番号の所有を server で検証（secondary app の phone-provider IDトークン）。
    let decoded;
    try {
      decoded = await getAuth().verifyIdToken(phoneIdToken);
    } catch (e) {
      throw new HttpsError("permission-denied", "Phone verification failed");
    }
    const tokenPhone = decoded && decoded.phone_number;
    if (!tokenPhone) {
      throw new HttpsError("permission-denied", "Phone verification required");
    }
    const normalized = normalizePhoneServer(tokenPhone);
    if (!/^855\d{8,9}$/.test(normalized)) {
      throw new HttpsError("invalid-argument", "Invalid phone number");
    }
    // 重複チェック（自分自身は除外）。他人が同じ番号で登録済みなら拒否。
    const dupSnap = await db.collection("users")
      .where("phone", "==", normalized).limit(2).get();
    const conflict = dupSnap.docs.find((d) => d.id !== uid);
    if (conflict) {
      throw new HttpsError("already-exists", "Phone number already in use");
    }
    // 既に自分の番号（変更なし）なら no-op で成功。
    const mine = dupSnap.docs.find((d) => d.id === uid);
    if (mine) {
      return { ok: true, unchanged: true };
    }
    // Auth のログインメールを {新phone}@fishlink.local に更新（Admin SDK＝検証メール不要）。
    const newEmail = `${normalized}@fishlink.local`;
    try {
      await getAuth().updateUser(uid, { email: newEmail });
    } catch (e) {
      // Auth のメール一意制約。Firestore 事前チェックを抜けたレースなどはここで弾く。
      if (e && (e.code === "auth/email-already-exists" || e.errorInfo?.code === "auth/email-already-exists")) {
        throw new HttpsError("already-exists", "Phone number already in use");
      }
      throw new HttpsError("internal", "Failed to update phone number");
    }
    // Firestore の表示用 phone も更新。
    await db.doc(`users/${uid}`).update({ phone: normalized });
    return { ok: true, phone: normalized };
  }
);

// ── 6/26 #171/#176 案B: ウォレット残高の返金（出金）申請（callable・admin SDK）──
//   残高（wallets）は rules で write:false ＝ CF のみが書ける。申請＝全額（MVP・部分指定なし）。
//   ①残高を即0に減算＋台帳に「残高の返金（申請）」を記録（二重使用防止）②運営チャット（adminChats）に
//   申請メッセージを投稿（onAdminChatMessage が親docサマリ＋管理者通知を処理）→ 運営が返金先へ手動送金。
exports.requestWalletWithdrawal = onCall(
  { region: "asia-southeast1", invoker: "public", cors: true },
  async (request) => {
    const admin = require("firebase-admin/firestore");
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Authentication required");

    const userSnap = await db.doc(`users/${uid}`).get();
    const userData = userSnap.data() || {};
    const refund = userData.refundAccount || {};
    const hasDest = refund.name && (refund.qrLink || refund.qrImage);
    if (!hasDest) throw new HttpsError("failed-precondition", "Refund destination not registered");

    const walletRef = db.doc(`wallets/${uid}`);
    let amount = 0;
    await db.runTransaction(async (tx) => {
      const wSnap = await tx.get(walletRef);
      const bal = Number(wSnap.data()?.balance || 0);
      if (bal <= 0) throw new HttpsError("failed-precondition", "No balance to withdraw");
      amount = bal;
      tx.set(walletRef, { buyerId: uid, balance: 0 }, { merge: true });
      const txRef = db.collection(`wallets/${uid}/transactions`).doc();
      tx.set(txRef, {
        amount: -bal,
        type: "withdraw_request",
        counterpart: null,
        relatedOrderId: null,
        createdAt: admin.FieldValue.serverTimestamp(),
      });
    });

    // 運営チャットに申請メッセージを投稿（senderRole:'user' → onAdminChatMessage が親doc＋管理者通知を処理）。
    //   ⚠️ 運営は返金先へ手動送金する＝「返金先QR」を必ず見せる必要がある：
    //      QR画像は imageUrls で添付（チャットに描画）／QRリンクは本文に載せる。
    //      onAdminChatMessage は type==='withdraw_request' をマスク対象外にする（リンク・名義を潰さない）。
    try {
      let body = `【ウォレット残高の返金 申請】\n金額: ${amount.toLocaleString()} KHR\n返金先: ${refund.name || "-"}`;
      if (refund.qrLink) body += `\nQRリンク: ${refund.qrLink}`;
      const msgData = {
        senderRole: "user",
        senderId: uid,
        type: "withdraw_request",
        text: body,
        withdrawalAmount: amount,
        category: "payment",
        isRead: false,
        createdAt: admin.FieldValue.serverTimestamp(),
      };
      if (refund.qrImage) msgData.imageUrls = [refund.qrImage]; // 返金先QR画像を運営に表示（チャットに描画）
      await db.collection(`adminChats/${uid}/messages`).add(msgData);
    } catch (e) {
      console.error("withdrawal chat post failed:", uid, e.message);
      // チャット投稿失敗でも残高は減算済み＝申請自体は受理（ログのみ）
    }

    return { ok: true, amount };
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
      "Siemreap", "Battambang", "Pursat", "Kg. Chhnang", "BMC", "Kampot",
    ];
    const FISH_TYPES = [
      "striped_snakehead", "walking_catfish", "red_tilapia", "nile_tilapia",
      "silver_barb", "spot_pangasius", "pangasius", "giant_snakehead",
      "barramundi", "climbing_perch", "frog",
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
        "- The table has EXACTLY 11 fish-type columns per province row, in fixed left-to-right order.",
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
        "- កំពត → 'Kampot'",
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
        "9. ត្រីឆ្ពង់ Asian sea bass / Barramundi → 'barramundi'",
        "10. ត្រីក្រាញ់ Climbing perch → 'climbing_perch'",
        "11. កង្កែប Frog → 'frog'",
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

// ── 5/11 #65: users.province を内部キーに正規化するマイグレーション ──
// Geocoding API が言語別に返した州名（"Takéo Province" / "ខេត្តតាកែវ" / "タケオ州" など）が
// 混在しているため、内部キー（例: 'takeo'）に統一する。
// 管理者のみ呼び出し可能。1回実行すれば全 users を一括更新する。
// クライアント側 js/province-utils.js と完全に同期したエイリアス＋正規化ロジック。
const PROVINCE_DATA = {
  phnom_penh: {
    en: 'Phnom Penh', km: 'ភ្នំពេញ', ja: 'プノンペン',
    aliases: ['phnom penh', 'phnompenh', 'phnom-penh', 'phnom penh capital', 'phnom penh municipality', 'krong phnom penh', 'រាជធានីភ្នំពេញ', 'プノンペン', 'プノンペン特別市'],
  },
  kandal: {
    en: 'Kandal', km: 'ខេត្តកណ្តាល', ja: 'カンダル州',
    aliases: ['kandal', 'khaet kandal', 'カンダル', 'カンダル州'],
  },
  takeo: {
    en: 'Takéo', km: 'ខេត្តតាកែវ', ja: 'タケオ州',
    aliases: ['takeo', 'takéo', 'takev', 'takaev', 'khaet takeo', 'khaet takéo', 'タケオ', 'タケオ州'],
  },
  prey_veng: {
    en: 'Prey Veng', km: 'ខេត្តព្រៃវែង', ja: 'プレイヴェン州',
    aliases: ['prey veng', 'preyveng', 'khaet prey veng', 'プレイヴェン', 'プレイヴェン州'],
  },
  kampong_cham: {
    en: 'Kampong Cham', km: 'ខេត្តកំពង់ចាម', ja: 'コンポンチャム州',
    aliases: ['kampong cham', 'kompong cham', 'kg. cham', 'kg cham', 'khaet kampong cham', 'コンポンチャム', 'コンポンチャム州'],
  },
  kampong_thom: {
    en: 'Kampong Thom', km: 'ខេត្តកំពង់ធំ', ja: 'コンポントム州',
    aliases: ['kampong thom', 'kompong thom', 'kg. thom', 'kg thom', 'khaet kampong thom', 'コンポントム', 'コンポントム州'],
  },
  siem_reap: {
    en: 'Siem Reap', km: 'ខេត្តសៀមរាប', ja: 'シェムリアップ州',
    aliases: ['siem reap', 'siemreap', 'siem reab', 'siemreab', 'khaet siem reap', 'シェムリアップ', 'シェムリアップ州'],
  },
  battambang: {
    en: 'Battambang', km: 'ខេត្តបាត់ដំបង', ja: 'バッタンバン州',
    aliases: ['battambang', 'battambong', 'batdambang', 'battam bang', 'khaet battambang', 'バッタンバン', 'バッタンバン州'],
  },
  pursat: {
    en: 'Pursat', km: 'ខេត្តពោធិ៍សាត់', ja: 'ポーサット州',
    aliases: ['pursat', 'poursat', 'pouthisat', 'pothisat', 'khaet pursat', 'ポーサット', 'ポーサット州'],
  },
  kampong_chhnang: {
    en: 'Kampong Chhnang', km: 'ខេត្តកំពង់ឆ្នាំង', ja: 'コンポンチュナン州',
    aliases: ['kampong chhnang', 'kompong chhnang', 'kg. chhnang', 'kg chhnang', 'khaet kampong chhnang', 'コンポンチュナン', 'コンポンチュナン州'],
  },
  kampong_speu: {
    en: 'Kampong Speu', km: 'ខេត្តកំពង់ស្ពឺ', ja: 'コンポンスプー州',
    aliases: ['kampong speu', 'kompong speu', 'kg. speu', 'kg speu', 'khaet kampong speu', 'コンポンスプー', 'コンポンスプー州'],
  },
  banteay_meanchey: {
    en: 'Banteay Meanchey', km: 'ខេត្តបន្ទាយមានជ័យ', ja: 'バンテイメンチェイ州',
    aliases: ['banteay meanchey', 'banteay mean chey', 'banteay meancheay', 'bmc', 'khaet banteay meanchey', 'バンテイメンチェイ', 'バンテイメンチェイ州'],
  },
  svay_rieng: {
    en: 'Svay Rieng', km: 'ខេត្តស្វាយរៀង', ja: 'スヴァイリエン州',
    aliases: ['svay rieng', 'svayrieng', 'khaet svay rieng', 'スヴァイリエン', 'スヴァイリエン州'],
  },
  kratie: {
    en: 'Kratié', km: 'ខេត្តក្រចេះ', ja: 'クラチェ州',
    aliases: ['kratie', 'kratié', 'krocheh', 'kracheh', 'khaet kratie', 'khaet kratié', 'クラチェ', 'クラチェ州'],
  },
  stung_treng: {
    en: 'Stung Treng', km: 'ខេត្តស្ទឹងត្រែង', ja: 'ストゥントレン州',
    aliases: ['stung treng', 'stoeung treng', 'steung treng', 'stungtreng', 'khaet stung treng', 'ストゥントレン', 'ストゥントレン州'],
  },
  ratanakiri: {
    en: 'Ratanakiri', km: 'ខេត្តរតនគិរី', ja: 'ラタナキリ州',
    aliases: ['ratanakiri', 'rattanakiri', 'ratanak kiri', 'rotanakiri', 'khaet ratanakiri', 'ラタナキリ', 'ラタナキリ州'],
  },
  mondulkiri: {
    en: 'Mondulkiri', km: 'ខេត្តមណ្ឌលគិរី', ja: 'モンドルキリ州',
    aliases: ['mondulkiri', 'mondol kiri', 'monduolkiri', 'khaet mondulkiri', 'モンドルキリ', 'モンドルキリ州'],
  },
  preah_vihear: {
    en: 'Preah Vihear', km: 'ខេត្តព្រះវិហារ', ja: 'プレアヴィヒア州',
    aliases: ['preah vihear', 'preahvihear', 'preah vihea', 'khaet preah vihear', 'プレアヴィヒア', 'プレアヴィヒア州'],
  },
  kep: {
    en: 'Kep', km: 'ខេត្តកែប', ja: 'ケップ州',
    aliases: ['kep', 'kaeb', 'krong kep', 'khaet kep', 'ケップ', 'ケップ州'],
  },
  kampot: {
    en: 'Kampot', km: 'ខេត្តកំពត', ja: 'カンポット州',
    aliases: ['kampot', 'khaet kampot', 'カンポット', 'カンポット州'],
  },
  koh_kong: {
    en: 'Koh Kong', km: 'ខេត្តកោះកុង', ja: 'コーコン州',
    aliases: ['koh kong', 'kohkong', 'kaoh kong', 'kah kong', 'khaet koh kong', 'コーコン', 'コーコン州'],
  },
  tboung_khmum: {
    en: 'Tboung Khmum', km: 'ខេត្តត្បូងឃ្មុំ', ja: 'トボンクムム州',
    aliases: ['tboung khmum', 'tbong khmum', 'tbaung khmum', 'khaet tboung khmum', 'トボンクムム', 'トボンクムム州'],
  },
  oddar_meanchey: {
    en: 'Oddar Meanchey', km: 'ខេត្តឧត្តរមានជ័យ', ja: 'オッドーミエンチェイ州',
    aliases: ['oddar meanchey', 'otdar meanchey', 'otdor meanchey', 'oddar mean chey', 'khaet oddar meanchey', 'オッドーミエンチェイ', 'オッドーミエンチェイ州'],
  },
  preah_sihanouk: {
    en: 'Preah Sihanouk', km: 'ខេត្តព្រះសីហនុ', ja: 'シハヌークビル州',
    aliases: ['preah sihanouk', 'preahsihanouk', 'sihanoukville', 'sihanouk', 'krong preah sihanouk', 'khaet preah sihanouk', 'シハヌークビル', 'シハヌーク州', 'シハヌークビル州'],
  },
  pailin: {
    en: 'Pailin', km: 'ខេត្តប៉ៃលិន', ja: 'パイリン州',
    aliases: ['pailin', 'krong pailin', 'khaet pailin', 'パイリン', 'パイリン州'],
  },
};

function canonicalizeProvince(s) {
  if (!s) return '';
  return String(s)
    .normalize('NFC')
    .toLowerCase()
    .replace(/　/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+province$/i, '')
    .replace(/^province\s+of\s+/i, '')
    .replace(/^khaet\s+/i, '')
    .replace(/^krong\s+/i, '')
    .replace(/^ខេត្ត/, '')
    .replace(/^ខែត្រ/, '')
    .replace(/^ក្រុង/, '')
    .replace(/^រាជធានី/, '')
    .trim();
}

const PROVINCE_ALIAS_INDEX = (() => {
  const map = new Map();
  const add = (alias, key) => {
    const c = canonicalizeProvince(alias);
    if (c) map.set(c, key);
  };
  for (const [key, entry] of Object.entries(PROVINCE_DATA)) {
    add(entry.en, key);
    add(entry.km, key);
    add(entry.ja, key);
    (entry.aliases || []).forEach(a => add(a, key));
    add(key, key);
    add(key.replace(/_/g, ' '), key);
  }
  return map;
})();

function normalizeProvinceServer(raw) {
  if (!raw) return null;
  if (PROVINCE_DATA[raw]) return raw; // already a key
  const c = canonicalizeProvince(raw);
  if (!c) return null;
  return PROVINCE_ALIAS_INDEX.get(c) || null;
}

exports.migrateProvinces = onCall(
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

    const usersSnap = await db.collection("users").get();
    const batches = [];
    let batch = db.batch();
    let pending = 0;
    let updated = 0;
    let skipped = 0;
    let unknown = 0;
    const unknownSamples = [];

    usersSnap.forEach(d => {
      const data = d.data();
      const raw = data.province;
      if (!raw) { skipped++; return; }
      // 既に内部キーならスキップ
      if (PROVINCE_DATA[raw]) { skipped++; return; }
      const key = normalizeProvinceServer(raw);
      if (!key) {
        unknown++;
        if (unknownSamples.length < 20) unknownSamples.push({ uid: d.id, province: raw });
        return;
      }
      batch.update(d.ref, { province: key });
      pending++;
      updated++;
      // Firestore batch は最大 500 操作
      if (pending >= 400) {
        batches.push(batch.commit());
        batch = db.batch();
        pending = 0;
      }
    });
    if (pending > 0) batches.push(batch.commit());
    await Promise.all(batches);

    return { total: usersSnap.size, updated, skipped, unknown, unknownSamples };
  }
);

// ── 5/11 拡張: district のクメール語版（districtKm）を Geocoding API で backfill ──
// 既存ユーザーの users.location（lat/lng）を language=km で逆ジオコーディングして
// administrative_area_level_2 を取得し、users.districtKm に保存する。
// 管理者のみ呼び出し可能。1回実行すれば対象ユーザーを全件処理する。
// レート制限と API コスト抑制のため、毎呼び出しに 100ms の遅延を入れる。
const GEOCODING_API_KEY = "AIzaSyAR8k3SC1KSW7awepRV_tmujgs89_6Psl0"; // 既存のブラウザキー
async function reverseGeocodeKm(lat, lng) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=km&result_type=administrative_area_level_2&key=${GEOCODING_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== "OK" || !data.results || data.results.length === 0) return null;
  for (const r of data.results) {
    const comp = (r.address_components || []).find(c =>
      Array.isArray(c.types) && c.types.includes("administrative_area_level_2")
    );
    if (comp?.long_name) return comp.long_name;
  }
  return null;
}

exports.migrateDistrictsKm = onCall(
  {
    region: "asia-southeast1",
    invoker: "public",
    cors: true,
    timeoutSeconds: 540, // 9分（最大）。100ユーザー × 100ms 程度なら余裕
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }
    const callerSnap = await db.doc(`users/${request.auth.uid}`).get();
    if (callerSnap.data()?.role !== "admin") {
      throw new HttpsError("permission-denied", "Admin role required");
    }

    const usersSnap = await db.collection("users").get();
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    const failures = [];

    for (const d of usersSnap.docs) {
      const data = d.data();
      // 既に districtKm があるユーザーはスキップ
      if (data.districtKm) { skipped++; continue; }
      // 位置情報がないユーザーはスキップ
      const lat = data.location?.lat;
      const lng = data.location?.lng;
      if (typeof lat !== "number" || typeof lng !== "number") { skipped++; continue; }

      try {
        const km = await reverseGeocodeKm(lat, lng);
        if (km) {
          await d.ref.update({ districtKm: km });
          updated++;
        } else {
          failed++;
          if (failures.length < 20) failures.push({ uid: d.id, lat, lng, reason: "no_result" });
        }
      } catch (e) {
        failed++;
        if (failures.length < 20) failures.push({ uid: d.id, lat, lng, reason: e.message?.slice(0, 80) });
      }
      // レート制限対策：100ms 待機
      await new Promise(r => setTimeout(r, 100));
    }

    return { total: usersSnap.size, updated, skipped, failed, failures };
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
    // 6/14 #145: 件の区切り（システム行）は通知・サマリ更新の対象外
    //   （senderRole==='system' / type==='separator'。これを処理すると lastMessage を空で
    //    上書き＋未対応フラグを誤って下ろす＋無用な通知になるため早期 return）。
    if (data.type === "separator" || data.senderRole === "system") return;

    const { uid } = event.params;
    const senderRole = data.senderRole;
    let text = data.text || "";
    const hasImage = Array.isArray(data.imageUrls) && data.imageUrls.length > 0;

    // 6/14 #145 / #120: サーバ側で連絡先を再検知（バイパス防止）。ユーザー発言のみ。
    //   client は admin-chat.html 送信時に maskContacts 済みだが、API 直叩きを防ぐため再マスクし、
    //   発動時は本文をマスク後で上書き＋contactMasked フラグを立てる（Q&A onCommentCreated と同方式）。
    // 6/28 #176: ウォレット返金申請（withdraw_request）は運営が返金先へ送金するための正規メッセージ＝
    //   返金先の QRリンク/名義をマスクしない（通常のユーザー発言のみ連絡先マスク）。
    if (senderRole === "user" && text && data.type !== "withdraw_request") {
      const serverDetect = maskContactsServer(text);
      if (serverDetect.hit && serverDetect.masked !== text) {
        text = serverDetect.masked;
        try {
          await event.data.ref.update({ text, contactMasked: true });
        } catch (e) {
          console.error("onAdminChatMessage mask update failed:", uid, e);
        }
      }
    }

    // 画像のみ（本文空）のプレビュー文言（言語別）
    const imageLabel = (lang) => ({ ja: "画像が送信されました", en: "Image sent", km: "បានផ្ញើរូបភាព" }[lang] || "Image");
    const preview = text ? text.slice(0, 200) : (hasImage ? "[image]" : "");

    // 親ドキュメントに最新メッセージのサマリを保存
    // 5/1: 管理者ユーザー一覧で未読バッジ・最終メッセージを表示するため
    const admin = require("firebase-admin/firestore");
    try {
      await db.doc(`adminChats/${uid}`).set({
        lastMessage: preview,
        lastMessageAt: admin.FieldValue.serverTimestamp(),
        lastSenderRole: senderRole,
        // ユーザー発言時のみ未読フラグを立てる。管理者が返信した時点で false に
        hasUnreadFromUser: senderRole === "user",
        // 6/14 #145: 未対応/対応済（ユーザー発言→未対応／管理者返信→対応済）。
        //   一覧の未対応バッジ・「未対応」フィルタの正本。
        supportStatus: senderRole === "user" ? "todo" : "done",
        updatedAt: admin.FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (e) {
      console.error("Failed to update adminChats parent doc:", uid, e);
    }

    if (senderRole === "admin") {
      const userSnap = await db.doc(`users/${uid}`).get();
      const lang = userSnap.data()?.lang || "km";
      const vars = { text: text ? text.slice(0, 80) : (hasImage ? imageLabel(lang) : "") };
      const msg = getMessage("adminChat", lang, vars);
      await notifyUser(uid, {
        type: "admin_chat",
        title: msg.title, body: msg.body,
        // 6/14 #145: タップで会話を直接開く
        url: "/pages/admin-chat.html?view=chat",
        msgKey: "adminChat",
        vars,
      });
    } else if (senderRole === "user") {
      const adminUids = await getAdminUids();
      console.log("onAdminChatMessage: notifying admins", { fromUid: uid, adminCount: adminUids.length });
      const senderSnap = await db.doc(`users/${uid}`).get();
      const senderName = senderSnap.data()?.displayName || senderSnap.data()?.loginId || "user";
      await Promise.all(adminUids.map(async adminUid => {
        const adminSnap = await db.doc(`users/${adminUid}`).get();
        const lang = adminSnap.data()?.lang || "ja";
        const vars = { name: senderName, text: text ? text.slice(0, 80) : (hasImage ? imageLabel(lang) : "") };
        const msg = getMessage("adminChatFromUser", lang, vars);
        await notifyUser(adminUid, {
          type: "admin_chat",
          title: msg.title, body: msg.body,
          url: `/pages/admin/users.html?uid=${uid}`,
          msgKey: "adminChatFromUser",
          vars,
        });
      }));
    } else {
      console.log("onAdminChatMessage: senderRole not handled", { senderRole, uid });
    }
  }
);

// ── 5/23 #80: 商品ページ Q&A 通知 ─────────────────────────────────
// fishListings/{listingId}/comments/{commentId} の作成・更新で FCM 通知。
//   - 質問新規投稿 → listing の farmer に通知
//   - 返信新規追加（replyText が null/空 → 非空に変化）→ 質問者に通知
// 通知 URL は /pages/restaurant/comments.html?id={listingId} に統一（農家・レストラン共用ページ）。
exports.onCommentCreated = onDocumentCreated(
  {
    document: "fishListings/{listingId}/comments/{commentId}",
    region: "asia-southeast1",
    database: "(default)",
  },
  async (event) => {
    const data = event.data?.data();
    if (!data) return;
    const { listingId, commentId } = event.params;
    // 削除済みフラグ付きで作成された場合はスキップ
    if (data.isDeleted) return;

    const listingSnap = await db.doc(`fishListings/${listingId}`).get();
    if (!listingSnap.exists) return;
    const listing = listingSnap.data();
    const farmerId = listing.farmerId;
    if (!farmerId) return;

    // 6/3 #120/#121: サーバ側で連絡先を再検知（バイパス防止）。client が既にマスク済みなら contactMasked フラグで検知。
    try {
      const serverDetect = maskContactsServer(data.text || "");
      const wasMasked = data.contactMasked === true || serverDetect.hit;
      if (serverDetect.hit) {
        // client を経由しない投稿（API直叩き等）→ 本文を再マスク
        await event.data.ref.update({ text: serverDetect.masked, contactMasked: true });
      }
      if (wasMasked) {
        const farmerSnapForReport = await db.doc(`users/${farmerId}`).get();
        await createQaContactReport({
          listingId, commentId,
          posterUid: data.senderId,
          posterRole: data.senderRole,
          listing,
          farmerName: farmerSnapForReport.data()?.displayName || "",
          maskedText: serverDetect.hit ? serverDetect.masked : data.text,
        });
      }
    } catch (e) {
      console.warn("qa contact mask/report failed:", e.message);
    }

    // 5/27 #99: 多段スレッド対応 — parentReplyId が付いていれば返信通知ロジックへ分岐
    if (data.parentReplyId) {
      try {
        // スレッド参加者（親質問者 + 全ての過去返信者）を集める
        const commentsSnap = await db.collection(`fishListings/${listingId}/comments`).get();
        const parentDoc = commentsSnap.docs.find((d) => d.id === data.parentReplyId);
        // 親質問 ID を辿る（親も child の場合はその親、最終的に parentReplyId なしの質問 doc に到達）
        let rootId = data.parentReplyId;
        let safety = 10;
        while (safety-- > 0) {
          const rootDoc = commentsSnap.docs.find((d) => d.id === rootId);
          if (!rootDoc) break;
          const parentField = rootDoc.data().parentReplyId;
          if (!parentField) break;
          rootId = parentField;
        }
        const participants = new Set();
        // 質問者
        const rootDoc = commentsSnap.docs.find((d) => d.id === rootId);
        if (rootDoc?.data().senderId) participants.add(rootDoc.data().senderId);
        if (rootDoc?.data().replyByUid) participants.add(rootDoc.data().replyByUid);
        // 同じスレッドの全 child の送信者
        for (const d of commentsSnap.docs) {
          const dd = d.data();
          if (dd.parentReplyId && (dd.parentReplyId === rootId || dd.parentReplyId === parentDoc?.id)) {
            if (dd.senderId) participants.add(dd.senderId);
          }
        }
        // 出品農家は常に含める
        participants.add(farmerId);
        // 自分自身（送信者）は除外
        participants.delete(data.senderId);

        const senderSnap = await db.doc(`users/${data.senderId}`).get();
        const senderName = senderSnap.data()?.displayName || "";
        const truncText = (data.text || "").substring(0, 80);
        const fishKey = listing.fishType || "";

        await Promise.all([...participants].map(async (uid) => {
          const userSnap = await db.doc(`users/${uid}`).get();
          const lang = userSnap.data()?.lang || "en";
          const vars = { sender: senderName, fish: fishKey, text: truncText };
          const { title, body } = getMessage("commentReply", lang, vars);
          await notifyUser(uid, {
            type: "comment_reply",
            title, body,
            msgKey: "commentReply",
            vars,
            url: `/pages/restaurant/comments.html?id=${listingId}`,
          });
        }));
        console.log("Thread reply notifications sent:", listingId, commentId, "participants:", [...participants]);
      } catch (e) {
        console.warn("thread reply notify failed:", e.message);
      }
      // 6/3 #119: 農家の返信で「未回答」状態が解消されたか同期
      await syncQaTodo(listingId, farmerId);
      return;
    }

    // 自分（farmer）が自分の商品にコメントした場合は通知しない
    if (data.senderId === farmerId) return;

    const [farmerSnap, senderSnap] = await Promise.all([
      db.doc(`users/${farmerId}`).get(),
      db.doc(`users/${data.senderId}`).get(),
    ]);
    const farmerData = farmerSnap.data() || {};
    const lang = farmerData.lang || "en";
    const senderName = senderSnap.data()?.displayName || "";

    // 魚種名は farmer の言語に依らずキー文字列のまま送る（クライアント側で msgKey/vars 再翻訳可能）
    const fishKey = listing.fishType || "";
    const truncText = (data.text || "").substring(0, 80);
    const vars = { sender: senderName, fish: fishKey, text: truncText };
    const { title, body } = getMessage("commentQuestion", lang, vars);

    await notifyUser(farmerId, {
      type: "comment_question",
      title, body,
      msgKey: "commentQuestion",
      vars,
      url: `/pages/restaurant/comments.html?id=${listingId}`,
    });

    // 6/3 #119: 未回答の質問を農家のやることリスト（✓✓）に積む（放置＝失注の防止・§5）
    await createTodo(farmerId, "farmer_qa", listingId);

    console.log("Comment question notification sent to farmer:", farmerId, listingId);
  }
);

exports.onCommentUpdated = onDocumentUpdated(
  {
    document: "fishListings/{listingId}/comments/{commentId}",
    region: "asia-southeast1",
    database: "(default)",
  },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!before || !after) return;

    const { listingId } = event.params;

    // 6/3 #119: isDeleted が true に変化（質問/スレッド取り消し）。
    if (before.isDeleted !== true && after.isDeleted === true) {
      try {
        const { commentId } = event.params;
        // スレッドごと削除フラグ付き＝root 質問の取り消し → 子返信を連鎖でソフト削除（Rules 回避のため admin で実行）。
        if (after.threadDeleted === true && !after.parentReplyId) {
          const admin = require("firebase-admin/firestore");
          const commentsSnap = await db.collection(`fishListings/${listingId}/comments`).get();
          const batch = db.batch();
          let n = 0;
          for (const d of commentsSnap.docs) {
            const dd = d.data();
            if (dd.parentReplyId === commentId && dd.isDeleted !== true) {
              batch.update(d.ref, { isDeleted: true, deletedAt: admin.FieldValue.serverTimestamp() });
              n++;
            }
          }
          // root の legacy 埋め込み返信もクリア
          if (after.replyText) {
            batch.update(event.data.after.ref, { replyText: null, replyAt: null, replyByUid: null });
            n++;
          }
          if (n > 0) await batch.commit();
          console.log("Thread cascade-deleted:", listingId, commentId, "children:", n);
        }
        const listingSnap = await db.doc(`fishListings/${listingId}`).get();
        const farmerId = listingSnap.data()?.farmerId;
        if (farmerId) await syncQaTodo(listingId, farmerId);
      } catch (e) { console.warn("qa todo sync / cascade on delete failed:", e.message); }
      return;
    }

    // replyText が新規に追加された場合のみ通知。取消・編集や isDeleted 切替では通知しない。
    const hadReply = !!(before.replyText && String(before.replyText).trim());
    const hasReply = !!(after.replyText && String(after.replyText).trim());
    if (hadReply || !hasReply) return;

    const askerUid = after.senderId;
    if (!askerUid) return;
    // 返信者が質問者本人なら通知しない
    if (after.replyByUid && after.replyByUid === askerUid) return;

    const [askerSnap, listingSnap] = await Promise.all([
      db.doc(`users/${askerUid}`).get(),
      db.doc(`fishListings/${listingId}`).get(),
    ]);
    const askerData = askerSnap.data() || {};
    const lang = askerData.lang || "en";
    const farmerId = listingSnap.data()?.farmerId;
    const farmerSnap = farmerId ? await db.doc(`users/${farmerId}`).get() : null;
    const farmerName = farmerSnap?.data()?.displayName || "";

    const truncText = String(after.replyText || "").substring(0, 80);
    const vars = { farmer: farmerName, text: truncText };
    const { title, body } = getMessage("commentReply", lang, vars);

    await notifyUser(askerUid, {
      type: "comment_reply",
      title, body,
      msgKey: "commentReply",
      vars,
      url: `/pages/restaurant/comments.html?id=${listingId}`,
    });

    // 6/3 #119: 農家が legacy 返信を付けたら未回答todoを再同期
    if (farmerId && after.replyByUid === farmerId) await syncQaTodo(listingId, farmerId);

    // 6/3 #120/#121: 農家の legacy 返信にも連絡先マスク／報告を適用（バイパス防止）
    try {
      const det = maskContactsServer(after.replyText || "");
      const wasMasked = after.replyContactMasked === true || det.hit;
      if (det.hit) {
        await event.data.after.ref.update({ replyText: det.masked, replyContactMasked: true });
      }
      if (wasMasked) {
        await createQaContactReport({
          listingId, commentId: event.params.commentId,
          posterUid: after.replyByUid, posterRole: "farmer",
          listing: listingSnap.data(),
          farmerName,
          maskedText: det.hit ? det.masked : after.replyText,
          qaField: "replyText",
        });
      }
    } catch (e) {
      console.warn("qa reply mask/report failed:", e.message);
    }

    console.log("Comment reply notification sent to asker:", askerUid, listingId);
  }
);

// ── 5/23 #81: ボイスメッセージの 30日自動削除 ─────────────────────
// orders/*/messages/* で type='voice' かつ createdAt が 30日以上前のものを対象に：
//   1) Storage の voice/{orderId}/{msgId}.{ext} を削除
//   2) Firestore の voiceUrl/voiceStoragePath を null + voiceExpired=true
// 要件：collectionGroup('messages') の (type ASC, createdAt ASC) 複合インデックス。
//   初回実行時にインデックス未作成だと Firestore がエラーリンクを返すので、それで作成可能。
exports.deleteExpiredVoiceMessages = onSchedule(
  {
    schedule: "every 24 hours",
    region: "asia-southeast1",
    timeZone: "Asia/Phnom_Penh",
  },
  async () => {
    const admin = require("firebase-admin/firestore");
    const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const cutoff = admin.Timestamp.fromMillis(cutoffMs);

    let snap;
    try {
      snap = await db.collectionGroup('messages')
        .where('type', '==', 'voice')
        .where('createdAt', '<', cutoff)
        .limit(500)
        .get();
    } catch (e) {
      console.error('deleteExpiredVoiceMessages query failed (collectionGroup index required?):', e.message);
      return;
    }
    if (snap.empty) {
      console.log('deleteExpiredVoiceMessages: nothing to delete');
      return;
    }

    const bucket = getStorage().bucket();
    let deleted = 0;
    let cleared = 0;
    let skipped = 0;

    for (const docSnap of snap.docs) {
      const data = docSnap.data();
      // 既に voiceExpired 済みなら Storage 削除はスキップ（doc は前回処理済みのはず）
      if (data.voiceExpired === true) { skipped++; continue; }

      if (data.voiceStoragePath) {
        try {
          await bucket.file(data.voiceStoragePath).delete();
          deleted++;
        } catch (e) {
          // 既に削除済み（404）は無視
          if (e?.code !== 404) {
            console.warn('voice storage delete failed:', data.voiceStoragePath, e.message);
          }
        }
      }

      try {
        await docSnap.ref.update({
          voiceUrl: null,
          voiceStoragePath: null,
          voiceExpired: true,
        });
        cleared++;
      } catch (e) {
        console.warn('voice msg update failed:', docSnap.ref.path, e.message);
      }
    }

    console.log('deleteExpiredVoiceMessages done:', {
      scanned: snap.size, storageDeleted: deleted, docsCleared: cleared, alreadyExpired: skipped,
    });
  }
);
