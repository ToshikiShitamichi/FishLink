import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import { getFirestore, FieldValue } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getStorage } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-storage.js';

const firebaseConfig = {
    apiKey: "AIzaSyCVFFieinYqc3pqbigeQuhJ8KdVs6as9DU",
    authDomain: "fishlink-t-shitamichi.firebaseapp.com",
    projectId: "fishlink-t-shitamichi",
    storageBucket: "fishlink-t-shitamichi.firebasestorage.app",
    messagingSenderId: "54443009365",
    appId: "1:54443009365:web:a531106e41c4397ace7bdc"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

// 6/6 #131: 識別子をログインID → 電話番号に変更。
// Firebase Auth は email/password が必須なので、正規化した電話番号から
// 合成メール（例 85512345678@fishlink.local）を生成して内部IDにする。
// ＝ユーザーは電話番号しか入力しない／ログイン自体は SMS 不要。

// 電話番号 → Firebase Auth 用の内部メールに変換（正規化済みの値を受け取る）
// 例: 85512345678 → 85512345678@fishlink.local
function toInternalEmail(identifier) {
    return `${String(identifier).toLowerCase()}@fishlink.local`;
}

// 電話番号の正規化（表記ゆれを 1 形式に統一）
// 入力: "012 345 678" / "012345678" / "+855 12 345 678" / "85512345678" 等
// 出力: 国番号付き・記号なしの数字列（例 "85512345678"）／不正なら空文字
function normalizePhone(raw) {
    if (!raw) return '';
    // 数字と + 以外を除去
    let s = String(raw).replace(/[^\d+]/g, '');
    if (!s) return '';
    if (s.startsWith('+855')) {
        s = s.slice(1);              // +855... → 855...
    } else if (s.startsWith('855')) {
        // そのまま
    } else if (s.startsWith('0')) {
        s = '855' + s.slice(1);      // 0XX... → 855XX...
    } else {
        s = '855' + s;               // 国内番号（先頭0なし）→ 855 を付与
    }
    s = s.replace(/\D/g, '');        // 念のため数字のみ
    return s;
}

// カンボジアの電話番号形式チェック（正規化後の値で判定）
// 855 + 8〜9桁（国内番号 8〜9桁）。
function isValidCambodiaPhone(normalized) {
    return /^855\d{8,9}$/.test(normalized || '');
}

// 表示用フォーマット（読みやすさのためスペース区切り。内部は正規化形）
// 例: 85512345678 → 012 345 678（先頭0付きの国内表記）
function formatPhoneDisplay(normalized) {
    const n = normalizePhone(normalized);
    if (!isValidCambodiaPhone(n)) return normalized || '';
    const local = '0' + n.slice(3);            // 855 を 0 に
    // 3-3-3 / 3-3-4 区切り
    if (local.length <= 9) return local.replace(/(\d{3})(\d{3})(\d{0,3})/, (m, a, b, c) => c ? `${a} ${b} ${c}` : `${a} ${b}`);
    return local.replace(/(\d{3})(\d{3})(\d{0,4})/, (m, a, b, c) => c ? `${a} ${b} ${c}` : `${a} ${b}`);
}

export { app as firebaseApp, auth, db, storage, FieldValue, toInternalEmail, normalizePhone, isValidCambodiaPhone, formatPhoneDisplay };