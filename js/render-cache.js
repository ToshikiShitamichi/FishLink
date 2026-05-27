// 5/23 #69 Phase J: ページ描画状態の localStorage キャッシュ。
//
// 目的：
//   stale-while-revalidate を画面レベルで実現する。
//   2 回目以降のページ訪問時に「ローディング → 表示」を「即時表示 → 裏で更新」に変える。
//
// 使い方：
//   import { saveRenderState, loadRenderState } from '/js/render-cache.js';
//
//   // 初期化（ページ起動直後）
//   const cached = loadRenderState('dashboard');
//   if (cached) {
//       renderFromData(cached);          // 即時描画
//       document.body.classList.add('app-ready');  // スピナー解除
//   }
//
//   // データ取得後（毎回）
//   const fresh = await fetchData();
//   renderFromData(fresh);
//   saveRenderState('dashboard', fresh);  // 次回用に保存
//
// 設計：
//   - 5/23 Phase J 改2：sessionStorage → localStorage に変更（タブ閉じても残す）
//   - デフォルト TTL: 24 時間（古すぎるデータは返さない・logout 時には clearAll で消去）
//   - JSON.stringify できるデータのみ保存可能（Map は Object.fromEntries で変換）
//   - data-cache.js（個別 doc 用）とは別レイヤー（こちらはクエリ結果や集約データ用）

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;  // 24時間
const PREFIX = 'fishlink_render:';
// 永続層 = localStorage（タブを閉じても残る）
const STORE = (typeof localStorage !== 'undefined') ? localStorage : null;

/**
 * 描画状態を保存。
 * @param {string} key 識別子（ページ単位推奨：'dashboard' / 'fish-list' / 'order:<listingId>' など）
 * @param {any} data JSON 化可能なデータ
 * @param {number} [ttlMs=15min] 有効期限
 * @returns {boolean} 保存成功か
 */
export function saveRenderState(key, data, ttlMs = DEFAULT_TTL_MS) {
    if (!STORE) return false;
    try {
        STORE.setItem(PREFIX + key, JSON.stringify({
            ts: Date.now(),
            ttl: ttlMs,
            data,
        }));
        return true;
    } catch (e) {
        // QuotaExceeded や cyclic ref など。サイレントに失敗（描画自体は問題なく続行）
        return false;
    }
}

/**
 * 描画状態を取得。TTL 超過なら null。
 * @param {string} key
 * @returns {any|null}
 */
export function loadRenderState(key) {
    if (!STORE) return null;
    try {
        const raw = STORE.getItem(PREFIX + key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.ts !== 'number' || parsed.data === undefined) return null;
        const ttl = (typeof parsed.ttl === 'number') ? parsed.ttl : DEFAULT_TTL_MS;
        if (Date.now() - parsed.ts > ttl) return null;
        return parsed.data;
    } catch {
        return null;
    }
}

// ── Firestore Timestamp ←→ JSON 変換ヘルパー（5/25 #91/#92 拡張） ──
// render-cache は JSON.stringify を使うため Firestore Timestamp が落ちる。
// 保存前に serializeTimestamps、復元後に reviveTimestamps を呼ぶことで、
// cached render 側でも .toMillis() / .toDate() を使う既存コードを変更せずに済む。

/**
 * 値の中の Firestore Timestamp（toMillis を持つオブジェクト）を { __ts: ms } マーカーに変換。
 * 配列・オブジェクトを再帰的に走査。
 */
export function serializeTimestamps(v) {
    if (v == null) return v;
    if (Array.isArray(v)) return v.map(serializeTimestamps);
    if (typeof v === 'object') {
        if (typeof v.toMillis === 'function') {
            return { __ts: v.toMillis() };
        }
        const out = {};
        for (const k of Object.keys(v)) out[k] = serializeTimestamps(v[k]);
        return out;
    }
    return v;
}

/**
 * { __ts: ms } マーカーを {toMillis(), toDate()} を持つ最小限の Timestamp 互換オブジェクトに復元。
 * 配列・オブジェクトを再帰的に走査。
 */
export function reviveTimestamps(v) {
    if (v == null) return v;
    if (Array.isArray(v)) return v.map(reviveTimestamps);
    if (typeof v === 'object') {
        if (typeof v.__ts === 'number' && Object.keys(v).length === 1) {
            const ms = v.__ts;
            return { toMillis: () => ms, toDate: () => new Date(ms) };
        }
        const out = {};
        for (const k of Object.keys(v)) out[k] = reviveTimestamps(v[k]);
        return out;
    }
    return v;
}

/**
 * 描画状態をクリア。
 * key を省略すると全 fishlink_render:* キーを削除。
 */
export function clearRenderState(key) {
    if (!STORE) return;
    try {
        if (key) {
            STORE.removeItem(PREFIX + key);
            return;
        }
        const remove = [];
        for (let i = 0; i < STORE.length; i++) {
            const k = STORE.key(i);
            if (k && k.startsWith(PREFIX)) remove.push(k);
        }
        remove.forEach(k => STORE.removeItem(k));
    } catch { /* ignore */ }
}
