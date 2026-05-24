// 5/23 #82 Phase 1: 紹介クーポン機能の共通ユーティリティ
//
// Phase 1 スコープ：
//   - 招待コードの生成（[A-Za-z0-9] 8桁）
//   - 既存ユーザー向けの遅延バックフィル（account.html 表示時）
//   - 注文時のコード入力 → 形式・存在・自己コード排除を検証
//   - order doc に appliedReferralCode を記録するだけ（クーポン適用なし）
// Phase 2: 実際のクーポン適用・農家ボーナス
// Phase 3: 運営設定・不正対策

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
