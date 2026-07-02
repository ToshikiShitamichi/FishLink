// 5/23 #82: 紹介クーポン機能の共通ユーティリティ
//
// Phase 1（完了）：
//   - 紹介コードの生成（[A-Za-z0-9] 8桁）
//   - 既存ユーザー向けの遅延バックフィル（account.html 表示時）
// Phase 2 Chunk 1（完了・5/24）：
//   - register.html での紹介コード入力時に検証（形式・存在）→ pendingReferralCode 保存
//     ※ 旧 Phase 1 の「cart.html 注文時入力」は 5/24 仕様変更で廃止
// Phase 2 Chunk 2 以降：
//   - クーポン発行・農家ボーナス・referredBy 昇格・FCM 通知
// Phase 3：
//   - 運営設定・不正対策

import { db } from '/js/firebase-config.js';
import {
    doc, getDoc, updateDoc, collection, query, where, limit, getDocs
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';

const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const CODE_LEN = 8;
const CODE_REGEX = /^[A-Za-z0-9]{8}$/;

/**
 * 招待コードを生成（[A-Za-z0-9] × 8桁）。
 * 衝突確率は 62^8 ≈ 2.18e14 中なので Phase 1 では dedup チェックなし。
 */
export function generateReferralCode() {
    const arr = new Uint8Array(CODE_LEN);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        crypto.getRandomValues(arr);
    } else {
        for (let i = 0; i < CODE_LEN; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    let out = '';
    for (let i = 0; i < CODE_LEN; i++) out += CODE_CHARS[arr[i] % CODE_CHARS.length];
    return out;
}

/**
 * コード形式バリデーション（[A-Za-z0-9]{8}）。
 */
export function isValidReferralCode(code) {
    return typeof code === 'string' && CODE_REGEX.test(code);
}

/**
 * 6/27 #177: 運営設定 settings/referral を取得（紹介専用ページの動的金額表示用）。
 * { enabled, restaurantCouponKhr, farmerBonusKhr, couponValidDays } を返す（無い場合 null）。
 * 金額は直書きせず必ずこの設定値を表示する。
 * @returns {Promise<object|null>}
 */
export async function getReferralSettings() {
    const snap = await getDoc(doc(db, 'settings', 'referral'));
    return snap.exists() ? snap.data() : null;
}

/**
 * 6/27 #177: 買い手の「使えるクーポン（ウォレット）」一覧を取得。
 * coupons where ownerUid==uid → クライアントで未使用・期限内のみ絞り込み（複合 index 不要）。
 * 各クーポン：{ code, amountKhr, sourceUid, expiresAtMs }。期限が近い（古い）順にソート。
 * @param {string} uid
 * @returns {Promise<Array<{code:string, amountKhr:number, sourceUid:string|null, expiresAtMs:number|null}>>}
 */
export async function fetchUsableCoupons(uid) {
    if (!uid) return [];
    const q = query(collection(db, 'coupons'), where('ownerUid', '==', uid));
    const snap = await getDocs(q);
    const now = Date.now();
    const list = snap.docs.map(d => {
        const c = d.data();
        const expMs = c.expiresAt?.toMillis?.() ?? (c.expiresAt instanceof Date ? c.expiresAt.getTime() : null);
        return {
            code: d.id,
            amountKhr: Number(c.amountKhr || 0),
            sourceUid: c.sourceUid || null,
            expiresAtMs: expMs,
            usedAt: c.usedAt,
            usedOrderId: c.usedOrderId,
        };
    }).filter(c => !c.usedAt && !c.usedOrderId)
      .filter(c => c.expiresAtMs == null || c.expiresAtMs > now);
    // 期限が近い順（null は末尾）
    list.sort((a, b) => {
        if (a.expiresAtMs == null && b.expiresAtMs == null) return 0;
        if (a.expiresAtMs == null) return 1;
        if (b.expiresAtMs == null) return -1;
        return a.expiresAtMs - b.expiresAtMs;
    });
    return list.map(({ code, amountKhr, sourceUid, expiresAtMs }) => ({ code, amountKhr, sourceUid, expiresAtMs }));
}

/**
 * 既存ユーザーが referralCode を持っていなければ生成して保存（lazy backfill）。
 * @param {string} uid users/{uid}
 * @param {object} userData 現在の users/{uid} データ（既知なら渡す。不要なら null）
 * @returns {Promise<string>} 自身の referralCode
 */
export async function ensureUserReferralCode(uid, userData = null) {
    if (!uid) throw new Error('ensureUserReferralCode: uid missing');
    let data = userData;
    if (!data) {
        const snap = await getDoc(doc(db, 'users', uid));
        data = snap.exists() ? snap.data() : null;
    }
    if (data?.referralCode && isValidReferralCode(data.referralCode)) {
        return data.referralCode;
    }
    const code = generateReferralCode();
    await updateDoc(doc(db, 'users', uid), { referralCode: code });
    return code;
}

/**
 * コード入力を検証：形式 → 存在（owner uid を返す）→ 自己コード排除。
 *
 * @param {string} code 入力されたコード
 * @param {string} myUid 入力したユーザーの uid（自己コード排除に使用）
 * @returns {Promise<{ok: boolean, ownerUid?: string, error?: string}>}
 *    error は i18n キー（'referral.errorFormat' / 'referral.errorNotFound' / 'referral.errorSelf'）
 */
export async function validateReferralCode(code, myUid) {
    if (!isValidReferralCode(code)) {
        return { ok: false, error: 'referral.errorFormat' };
    }
    // referralCode で users を引く（インデックスは単一フィールドのため自動）
    const q = query(collection(db, 'users'), where('referralCode', '==', code), limit(1));
    const snap = await getDocs(q);
    if (snap.empty) {
        return { ok: false, error: 'referral.errorNotFound' };
    }
    const ownerDoc = snap.docs[0];
    if (ownerDoc.id === myUid) {
        return { ok: false, error: 'referral.errorSelf' };
    }
    return { ok: true, ownerUid: ownerDoc.id };
}

/**
 * クーポンコード入力を検証：形式 → 存在 → 所有者一致 → 未使用 → 期限内。
 * coupons/{couponCode} の doc ID = コード文字列なので直接 getDoc。
 *
 * @param {string} code 入力されたクーポンコード
 * @param {string} restaurantUid 入力したレストランの uid
 * @returns {Promise<{ok: boolean, amountKhr?: number, expiresAt?: Date, error?: string}>}
 *    error は i18n キー（'coupon.invalidFormat' / 'coupon.notFound' / 'coupon.notOwned' /
 *    'coupon.alreadyUsed' / 'coupon.expired' / 'coupon.errorGeneric'）
 */
export async function validateCouponCode(code, restaurantUid) {
    if (!isValidReferralCode(code)) {
        return { ok: false, error: 'coupon.invalidFormat' };
    }
    const snap = await getDoc(doc(db, 'coupons', code));
    if (!snap.exists()) {
        return { ok: false, error: 'coupon.notFound' };
    }
    const data = snap.data();
    if (data.ownerUid !== restaurantUid) {
        return { ok: false, error: 'coupon.notOwned' };
    }
    if (data.usedAt || data.usedOrderId) {
        return { ok: false, error: 'coupon.alreadyUsed' };
    }
    const expiresAtMs = data.expiresAt?.toMillis?.() ?? (data.expiresAt instanceof Date ? data.expiresAt.getTime() : null);
    if (expiresAtMs !== null && expiresAtMs < Date.now()) {
        return { ok: false, error: 'coupon.expired' };
    }
    return {
        ok: true,
        amountKhr: Number(data.amountKhr || 0),
        expiresAt: expiresAtMs ? new Date(expiresAtMs) : null,
    };
}
