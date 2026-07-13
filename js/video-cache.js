// 🎬 7/9 #199: リール動画 端末キャッシュ（メモリ + IndexedDB）。
//
// 背景（reels-spec §4/§9・下道さんコスト分析の「要対処」）：
//   現行 Service Worker (sw.js L545) は `response.status === 200` のみキャッシュする。
//   ところが <video> 再生は HTTP Range → 206 Partial Content で取得するため、
//   206 動画レスポンスが一切キャッシュされず「再生のたびに再ダウンロード」＝egress（＝コスト）が膨らむ。
//
// 対策（image-cache.js と同じ3層機構を動画用に複製・予算だけ動画向けに縮小）：
//   ファイル全体を 1 回だけ fetch()（＝200・Range なし）→ Blob を IndexedDB 保存 →
//   object URL を <video src=blobUrl> に渡す。＝SW の 206 問題を回避し、セッションを跨いで即再生。
//   ・クリップは 2〜6MB と小さいので全取得で問題ない（reels-spec §9）。
//   ・動画は画像の ~10 倍サイズ＝専用の小さい LRU 予算（メモリ 20 / IDB 40）を別建てにして
//     画像キャッシュ（500件・#69 の LCP 最適化）を圧迫しない。
//   ・spec は「先読みしない」＝タップ時に loadVideoObjectUrl() を呼ぶ pull 型のみ（prefetch は用意しない）。
//
// 使い方：
//   import { loadVideoObjectUrl } from '/js/video-cache.js';
//   videoEl.src = await loadVideoObjectUrl(videoUrl);  // キャッシュ or 全取得
//   videoEl.play();
//   // ログアウト時（プライバシー・auth.js から）：
//   import { clearAllVideos } from '/js/video-cache.js';
//   await clearAllVideos();

const MEM_MAX_ENTRIES = 20;         // メモリ層の上限（動画は大きいので画像より小さく）
const MEM_EVICT_FRACTION = 0.25;

const IDB_NAME = 'fishlink-video-cache';
const IDB_VERSION = 1;
const IDB_STORE = 'videos';
const IDB_MAX_ENTRIES = 40;          // 永続層の上限件数（20〜40クリップ想定）
const IDB_EVICT_BATCH = 8;

const cache = new Map();      // url -> { blobUrl, fetchedAt, lastUsedAt }
const inflight = new Map();   // url -> Promise<blobUrl>

/**
 * 動画URLを「端末キャッシュ or 全取得」で object URL にして返す（非同期）。
 * - メモリヒット → 即 blobUrl
 * - IDB ヒット → Blob から blobUrl を復元
 * - ミス → fetch(url)（全体・200）→ Blob → blobUrl（＋IDB永続化）
 * 失敗時は throw（呼び出し側で「タップで再生/リトライ」導線を出す）。
 */
export async function loadVideoObjectUrl(url) {
    if (!url || typeof url !== 'string') return url;
    if (url.startsWith('blob:') || url.startsWith('data:')) return url;

    const hit = cache.get(url);
    if (hit) {
        hit.lastUsedAt = Date.now();
        return hit.blobUrl;
    }
    if (inflight.has(url)) return inflight.get(url);

    const p = (async () => {
        let blob = await readFromIDB(url);
        if (!blob || blob.size === 0) {
            // 全体取得（Range を投げない＝200・SW/HTTP でキャッシュ可）
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`video fetch HTTP ${resp.status}`);
            blob = await resp.blob();
            if (!blob || blob.size === 0) throw new Error('empty video blob');
            persistToIDB(url, blob).catch(() => {});
        }
        const blobUrl = URL.createObjectURL(blob);
        evictMemIfNeeded();
        const old = cache.get(url);
        if (old) URL.revokeObjectURL(old.blobUrl);
        cache.set(url, { blobUrl, fetchedAt: Date.now(), lastUsedAt: Date.now() });
        return blobUrl;
    })();
    inflight.set(url, p);
    try {
        return await p;
    } finally {
        inflight.delete(url);
    }
}

/** そのURLが既にメモリキャッシュ済みか（同期・ポスター→即再生の判定用）。 */
export function isVideoCached(url) {
    return typeof url === 'string' && cache.has(url);
}

function evictMemIfNeeded() {
    if (cache.size < MEM_MAX_ENTRIES) return;
    const entries = [...cache.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    const n = Math.max(1, Math.floor(MEM_MAX_ENTRIES * MEM_EVICT_FRACTION));
    for (let i = 0; i < n && i < entries.length; i++) {
        URL.revokeObjectURL(entries[i][1].blobUrl);
        cache.delete(entries[i][0]);
    }
}

// ── IndexedDB 永続層（image-cache.js と同型・別DB/別予算） ──
let _dbPromise = null;
function openIDB() {
    if (_dbPromise) return _dbPromise;
    if (typeof indexedDB === 'undefined') { _dbPromise = Promise.resolve(null); return _dbPromise; }
    _dbPromise = new Promise((resolve) => {
        try {
            const req = indexedDB.open(IDB_NAME, IDB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(IDB_STORE)) {
                    const store = db.createObjectStore(IDB_STORE, { keyPath: 'url' });
                    store.createIndex('lastUsedAt', 'lastUsedAt');
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
            req.onblocked = () => resolve(null);
        } catch (e) { resolve(null); }
    });
    return _dbPromise;
}

async function readFromIDB(url) {
    const db = await openIDB();
    if (!db) return null;
    try {
        const rec = await new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).get(url);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        });
        if (!rec || !(rec.blob instanceof Blob) || rec.blob.size === 0) return null;
        // lastUsedAt を更新（best-effort・LRU精度用）
        touchIDB(url).catch(() => {});
        return rec.blob;
    } catch (e) { return null; }
}

async function touchIDB(url) {
    const db = await openIDB();
    if (!db) return;
    try {
        await new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            const store = tx.objectStore(IDB_STORE);
            const g = store.get(url);
            g.onsuccess = () => {
                const rec = g.result;
                if (rec) { rec.lastUsedAt = Date.now(); store.put(rec); }
                resolve();
            };
            g.onerror = () => resolve();
        });
    } catch (e) { /* ignore */ }
}

async function persistToIDB(url, blob) {
    const db = await openIDB();
    if (!db) return;
    try {
        await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put({ url, blob, fetchedAt: Date.now(), lastUsedAt: Date.now() });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
        evictIDBIfNeeded().catch(() => {});
        checkQuotaAndEvictIfHigh().catch(() => {});
    } catch (e) {
        if (e && (e.name === 'QuotaExceededError' || /quota/i.test(String(e.message || '')))) {
            forceEvictIDB(IDB_EVICT_BATCH * 2).catch(() => {});
        }
    }
}

async function evictIDBIfNeeded() {
    const db = await openIDB();
    if (!db) return;
    try {
        const count = await new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).count();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(0);
        });
        if (count <= IDB_MAX_ENTRIES) return;
        await forceEvictIDB(Math.min(IDB_EVICT_BATCH, count - IDB_MAX_ENTRIES));
    } catch (e) { /* ignore */ }
}

async function forceEvictIDB(deleteCount) {
    const db = await openIDB();
    if (!db) return;
    try {
        await new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            const idx = tx.objectStore(IDB_STORE).index('lastUsedAt');
            const cur = idx.openCursor();  // 古い順（lastUsedAt 昇順）
            let deleted = 0;
            cur.onsuccess = (e) => {
                const c = e.target.result;
                if (!c || deleted >= deleteCount) { resolve(); return; }
                c.delete(); deleted++; c.continue();
            };
            cur.onerror = () => resolve();
        });
    } catch (e) { /* ignore */ }
}

async function checkQuotaAndEvictIfHigh() {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return;
    try {
        const { usage, quota } = await navigator.storage.estimate();
        if (!quota || !usage) return;
        if (usage / quota >= 0.8) await forceEvictIDB(IDB_EVICT_BATCH * 2);
    } catch (e) { /* ignore */ }
}

/** ログアウト時：メモリ + IDB の動画キャッシュを全消去（プライバシー）。 */
export async function clearAllVideos() {
    for (const e of cache.values()) URL.revokeObjectURL(e.blobUrl);
    cache.clear();
    inflight.clear();
    const db = await openIDB();
    if (!db) return;
    try {
        await new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
            tx.onabort = () => resolve();
        });
    } catch (e) { /* ignore */ }
}
