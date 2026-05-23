// 5/12 #69 追補：sessionStorage ベースの読取キャッシュ。
// React の useMemo に近い感覚で、同じ uid / listingId に対する Firestore 読取を
// セッション内で再利用する。ページ遷移をまたいでも tab が同じなら効く。
//
// 設計方針：
//  - 同一タブ内のページ遷移をまたぐデータ重複取得を削減
//  - TTL は短め（5分）にして「ほどよく古い」状態を許容（強整合は呼び出し側が必要なら bypassCache を使う）
//  - sessionStorage の容量上限は ~5MB／ドメインなので、ユーザドキュメント数百件程度なら余裕
//  - Firestore リアルタイム更新が必要な箇所では使わない（onSnapshot を併用）

import { db } from '/js/firebase-config.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';

const TTL_MS = 5 * 60 * 1000;     // 5 分
const PREFIX = 'fishlink_cache:';

// メモリ層（同一ページ内なら sessionStorage を経由せず即返す）
const memCache = new Map();
// 取得中の Promise を共有して同時並行の重複リクエストを束ねる
const inflight = new Map();

function readSession(key) {
    try {
        const raw = sessionStorage.getItem(PREFIX + key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.ts !== 'number') return null;
        if (Date.now() - parsed.ts > TTL_MS) return null;
        return parsed.data;
    } catch { return null; }
}

function writeSession(key, data) {
    try {
        sessionStorage.setItem(PREFIX + key, JSON.stringify({ ts: Date.now(), data }));
    } catch { /* quota exceeded などは無視 */ }
}

/**
 * Firestore ドキュメントをキャッシュ経由で取得。
 * @param {string} collectionPath コレクション名
 * @param {string} id ドキュメントID
 * @param {object} [opts]
 * @param {boolean} [opts.bypassCache=false] true なら最新を取り直す
 * @returns {Promise<object|null>} 取得した data() か、存在しない場合は null
 */
export async function getCachedDoc(collectionPath, id, opts = {}) {
    if (!id) return null;
    const key = `${collectionPath}/${id}`;
    if (!opts.bypassCache) {
        if (memCache.has(key)) return memCache.get(key);
        const fromSession = readSession(key);
        if (fromSession !== null) {
            memCache.set(key, fromSession);
            return fromSession;
        }
    }
    // 同じ key の取得が進行中なら、その Promise を共有
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
        try {
            const snap = await getDoc(doc(db, collectionPath, id));
            const data = snap.exists() ? snap.data() : null;
            memCache.set(key, data);
            writeSession(key, data);
            return data;
        } finally {
            inflight.delete(key);
        }
    })();
    inflight.set(key, p);
    return p;
}

// users / fishListings の薄いショートカット
export function getCachedUser(uid, opts) { return getCachedDoc('users', uid, opts); }
export function getCachedListing(id, opts) { return getCachedDoc('fishListings', id, opts); }

/**
 * キャッシュを破棄する。ユーザがプロフィールを更新したときなどに呼ぶ。
 * id を省略するとそのコレクション全部を破棄。
 */
export function invalidate(collectionPath, id) {
    if (id) {
        const key = `${collectionPath}/${id}`;
        memCache.delete(key);
        try { sessionStorage.removeItem(PREFIX + key); } catch {}
        return;
    }
    // コレクション全体破棄
    const prefix = `${collectionPath}/`;
    for (const k of [...memCache.keys()]) {
        if (k.startsWith(prefix)) memCache.delete(k);
    }
    try {
        const remove = [];
        for (let i = 0; i < sessionStorage.length; i++) {
            const k = sessionStorage.key(i);
            if (k && k.startsWith(PREFIX + prefix)) remove.push(k);
        }
        remove.forEach(k => sessionStorage.removeItem(k));
    } catch {}
}

/**
 * セッションキャッシュ全消去（ログアウト時などに）。
 */
export function clearAll() {
    memCache.clear();
    try {
        const remove = [];
        for (let i = 0; i < sessionStorage.length; i++) {
            const k = sessionStorage.key(i);
            if (k && k.startsWith(PREFIX)) remove.push(k);
        }
        remove.forEach(k => sessionStorage.removeItem(k));
    } catch {}
}
