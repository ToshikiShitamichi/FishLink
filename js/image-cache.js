// 5/23 #69 改善: メモリ画像キャッシュ + IndexedDB 永続キャッシュ（Phase D）。
//
// 背景：
//   SW (stale-while-revalidate) で Storage 画像はディスクキャッシュ済みだが、
//   ブラウザが <img> をデコード→ペイントするまでに微小な遅延があり、
//   ページ遷移時に「真っ白→スピナー→画像」というフラッシュが発生していた。
//
// 戦略（3 レイヤー）：
//   Layer 1: Map<url, blobUrl>（メモリ・同一ページ内・同期アクセス）
//     - <img src="${getCachedImageUrl(url)}"> のように同期 API で使う
//     - キャッシュヒット → 即 blob URL を返す（ネットワーク要求ゼロで描画）
//     - ミス → original URL を返す（今回は SW キャッシュ頼り）+ 裏で fetch して次回に備える
//     - LRU eviction（上限 200 件、超過時は古い順に 1/4 削除）
//   Layer 2: IndexedDB（永続・タブ間・セッション間共有・5/23 Phase D 追加）
//     - prefetch / revalidate で取得した Blob を IndexedDB に保存
//     - ページ起動時に LRU で最大 200 件を memory に preload → 描画前に warm-up
//     - 上限 500 件で eviction（lastUsedAt 古い順から削除）
//     - ログアウト時に clearAll() で全クリア（プライバシー保護）
//   Layer 3: Service Worker（ディスクキャッシュ・HTTP レスポンス層・既存）
//
// 使い方：
//   import { getCachedImageUrl, asCachedImgAttrs } from '/js/image-cache.js';
//   const html = `<img ${asCachedImgAttrs(photoUrl)} loading="lazy">`;
//   img.src = getCachedImageUrl(photoUrl);
//
//   // ログアウト時にプライバシー保護のためクリア（auth.js から呼ぶ）：
//   import { clearAll } from '/js/image-cache.js';
//   clearAll();

const MAX_ENTRIES = 200;
// 5/23 Phase H: 60秒 → 1時間 に延長。
// 理由: Firebase Storage の download URL は token を URL に含むため、同一 URL の
//   ファイル内容は事実上 immutable。新しいアップロードでは token が変わり URL も
//   別物になるためキャッシュキーも別。したがって HEAD ETag 確認はほぼ無駄。
//   60秒間隔だと 20件キャッシュで毎分最大 20 HEAD リクエストが飛んでいた（実機ログで確認）。
//   1時間に延長して Cambodia 4G の帯域とリクエスト数を大幅削減。
const REVALIDATE_AFTER_MS = 60 * 60 * 1000;
const EVICT_FRACTION = 0.25;           // 上限超過時に削除する割合

// 5/23 Phase D: IndexedDB 設定
const IDB_NAME = 'fishlink-image-cache';
const IDB_VERSION = 1;
const IDB_STORE = 'images';
const IDB_MAX_ENTRIES = 500;          // 永続層の上限件数
const IDB_EVICT_BATCH = 50;           // 一度に削除する件数（IDB_MAX_ENTRIES 超過時）

const cache = new Map();       // url -> { blobUrl, fetchedAt, lastUsedAt, etag }
const inflight = new Map();    // url -> Promise（重複フェッチ抑止）

function escapeAttr(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/**
 * 同期：メモリにあれば blob URL、なければ original URL を返す。
 * 副作用：
 *  - ミス時は裏で fetch してキャッシュに積む
 *  - ヒットでも fetchedAt が古ければ裏で revalidate
 */
export function getCachedImageUrl(originalUrl) {
    if (!originalUrl || typeof originalUrl !== 'string') return originalUrl;
    // data: / blob: はキャッシュ対象外
    if (originalUrl.startsWith('data:') || originalUrl.startsWith('blob:')) return originalUrl;

    const cached = cache.get(originalUrl);
    if (cached) {
        cached.lastUsedAt = Date.now();
        if (Date.now() - cached.fetchedAt > REVALIDATE_AFTER_MS) {
            revalidate(originalUrl, cached);
        }
        return cached.blobUrl;
    }
    // 未キャッシュ → 裏で fetch して次回に備える
    prefetch(originalUrl);
    return originalUrl;
}

/**
 * `<img ${asCachedImgAttrs(url)}>` の形で使う省略記法。
 * src と data-original-url を同時にセット（revalidate で DOM 上の img を更新するため）。
 * 引数の url が空なら空文字を返す（caller 側で fallback を用意する想定）。
 *
 * 5/23 Phase I: opts.priority='high' で fetchpriority="high" を付与。
 *   LCP 候補画像（hero / above-the-fold の最初の数枚）に指定することで
 *   ブラウザにダウンロード優先度を伝え、LCP を改善する。
 *
 * @param {string} originalUrl
 * @param {{ priority?: 'high' | 'low' | 'auto' }} [opts]
 */
export function asCachedImgAttrs(originalUrl, opts = {}) {
    if (!originalUrl) return '';
    const src = getCachedImageUrl(originalUrl);
    let attrs = `src="${escapeAttr(src)}" data-original-url="${escapeAttr(originalUrl)}"`;
    if (opts.priority && (opts.priority === 'high' || opts.priority === 'low' || opts.priority === 'auto')) {
        attrs += ` fetchpriority="${opts.priority}"`;
    }
    return attrs;
}

/**
 * 手動で URL をプリフェッチ。複数画像をまとめて温めたいとき用。
 */
export function prefetchImages(urls) {
    if (!Array.isArray(urls)) return;
    for (const u of urls) {
        if (u && typeof u === 'string' && !cache.has(u) && !inflight.has(u)) {
            prefetch(u);
        }
    }
}

// 5/23 Phase G: prefetch 開始までの遅延（ms）。
// ブラウザの <img src> フェッチが SW キャッシュに収まる時間を待ってから、
// SW キャッシュ優先で取得することで二重ネットワーク要求を回避する。
const PREFETCH_DELAY_MS = 800;

function prefetch(url) {
    if (inflight.has(url)) return;
    const p = (async () => {
        try {
            // 5/23 Phase G: ブラウザの先行フェッチに SW キャッシュを populate させる時間を確保
            await new Promise(r => setTimeout(r, PREFETCH_DELAY_MS));
            // 並行 prefetch / preload で既にメモリに乗っていればスキップ
            if (cache.has(url)) return;

            let blob = null;
            let etag = '';
            // まず SW キャッシュから取得（ネットワーク無し）
            const swCached = await tryReadFromSWCache(url);
            if (swCached) {
                blob = swCached.blob;
                etag = swCached.etag;
            } else {
                // SW キャッシュにもなければネットワーク fetch
                const response = await fetch(url);
                if (!response.ok) {
                    logFetchProblem(url, new Error(`HTTP ${response.status}`));
                    return;
                }
                blob = await response.blob();
                etag = response.headers.get('etag') || response.headers.get('last-modified') || '';
            }

            // 5/27 #93: 空 blob ガード（CORS opaque や Safari の IDB 不具合で発生・描画すると "?" になる）
            if (!blob || blob.size === 0) {
                logFetchProblem(url, new Error('empty blob'));
                return;
            }

            const blobUrl = URL.createObjectURL(blob);
            evictIfNeeded();
            const old = cache.get(url);
            if (old) URL.revokeObjectURL(old.blobUrl);
            cache.set(url, {
                blobUrl,
                fetchedAt: Date.now(),
                lastUsedAt: Date.now(),
                etag,
            });
            // 5/23 Phase D: IndexedDB に永続化（タブ間/起動間で共有）
            persistToIDB(url, blob, etag).catch(() => {});
            // DOM 上の img を blob URL に切り替え（次回以降のネットワーク不要にする）
            updateLiveImages(url, blobUrl);
        } catch (e) {
            // 5/23 Phase E: CORS / network エラーを 1 回だけ警告（caller は original URL で動作続行）
            logFetchProblem(url, e);
        } finally {
            inflight.delete(url);
        }
    })();
    inflight.set(url, p);
}

// 5/23 Phase G: SW キャッシュ（caches API）から URL に対応する Response を探す。
// 見つかったら Blob + ETag を返す。見つからなければ null。
async function tryReadFromSWCache(url) {
    if (typeof caches === 'undefined') return null;
    try {
        const names = await caches.keys();
        for (const name of names) {
            if (!name.startsWith('fishlink-')) continue;
            const c = await caches.open(name);
            const resp = await c.match(url);
            if (resp && resp.ok) {
                const blob = await resp.blob();
                const etag = resp.headers.get('etag') || resp.headers.get('last-modified') || '';
                return { blob, etag };
            }
        }
    } catch (e) { /* ignore */ }
    return null;
}

async function revalidate(url, cached) {
    if (inflight.has(url)) return;
    const p = (async () => {
        try {
            const head = await fetch(url, { method: 'HEAD' });
            const newEtag = head.headers.get('etag') || head.headers.get('last-modified') || '';
            // ETag/Last-Modified 不明 or 同一 → fetchedAt のみ更新
            if (!newEtag || newEtag === cached.etag) {
                cached.fetchedAt = Date.now();
                return;
            }
            // 変化あり → 再フェッチ
            const response = await fetch(url);
            if (!response.ok) return;
            const blob = await response.blob();
            const newBlobUrl = URL.createObjectURL(blob);
            const oldBlobUrl = cached.blobUrl;
            cached.blobUrl = newBlobUrl;
            cached.fetchedAt = Date.now();
            cached.etag = newEtag;
            URL.revokeObjectURL(oldBlobUrl);
            // 5/23 Phase D: IndexedDB を更新
            persistToIDB(url, blob, newEtag).catch(() => {});
            updateLiveImages(url, newBlobUrl);
        } catch (e) {
            /* ignore */
        } finally {
            inflight.delete(url);
        }
    })();
    inflight.set(url, p);
}

function evictIfNeeded() {
    if (cache.size < MAX_ENTRIES) return;
    const entries = [...cache.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    const evictCount = Math.max(1, Math.floor(MAX_ENTRIES * EVICT_FRACTION));
    for (let i = 0; i < evictCount && i < entries.length; i++) {
        URL.revokeObjectURL(entries[i][1].blobUrl);
        cache.delete(entries[i][0]);
    }
}

function updateLiveImages(originalUrl, newBlobUrl) {
    // CSS セレクタに使う属性値内のクォートをエスケープ（簡易）
    const safe = String(originalUrl).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    let nodes;
    try {
        nodes = document.querySelectorAll(`img[data-original-url="${safe}"]`);
    } catch (e) {
        return;
    }
    nodes.forEach(img => {
        if (img.src !== newBlobUrl) img.src = newBlobUrl;
    });
}

// 5/23 Phase E: fetch エラーをページに 1 回だけ警告する（CORS 未設定の早期発見用）
let _fetchProblemWarned = false;
function logFetchProblem(url, err) {
    if (_fetchProblemWarned) return;
    _fetchProblemWarned = true;
    const msg = err?.message || String(err);
    const isCorsHint = msg.includes('CORS') || msg.includes('blocked') || (err?.name === 'TypeError' && /fetch/i.test(msg));
    if (isCorsHint) {
        console.warn(
            '[image-cache] 画像 fetch が失敗しました。Firebase Storage バケットの CORS 設定を確認してください。\n' +
            '  gcloud storage buckets update gs://fishlink-t-shitamichi.firebasestorage.app --cors-file=cors.json\n' +
            '  失敗 URL:', url, '\n  エラー:', err
        );
    } else {
        console.warn('[image-cache] 画像 fetch 失敗:', url, err);
    }
}

/**
 * デバッグ用：キャッシュ状態を返す
 */
export function getCacheStats() {
    return {
        size: cache.size,
        inflight: inflight.size,
        urls: [...cache.keys()].slice(0, 10),
    };
}

// ─────────────────────────────────────────────────────────────
// 5/23 Phase D: IndexedDB 永続キャッシュ層
// ─────────────────────────────────────────────────────────────

let _dbPromise = null;
function openIDB() {
    if (_dbPromise) return _dbPromise;
    if (typeof indexedDB === 'undefined') {
        _dbPromise = Promise.resolve(null);
        return _dbPromise;
    }
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
            req.onerror = () => { console.warn('[image-cache] IDB open failed:', req.error); resolve(null); };
            req.onblocked = () => resolve(null);
        } catch (e) {
            console.warn('[image-cache] IDB open exception:', e);
            resolve(null);
        }
    });
    return _dbPromise;
}

async function persistToIDB(url, blob, etag) {
    const db = await openIDB();
    if (!db) return;
    try {
        await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put({
                url,
                blob,
                fetchedAt: Date.now(),
                lastUsedAt: Date.now(),
                etag: etag || '',
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
        // 書き込みを契機に件数チェック（過度な eviction call を避けるため確率的に）
        if (Math.random() < 0.05) evictIDBIfNeeded().catch(() => {});
        // 5/23 Phase E: 30 件書き込みごとに quota チェック
        if (++_quotaCheckCounter >= 30) {
            _quotaCheckCounter = 0;
            checkQuotaAndEvictIfHigh().catch(() => {});
        }
    } catch (e) {
        // 5/23 Phase E: QuotaExceeded 系は強制 eviction を試みる
        if (e && (e.name === 'QuotaExceededError' || /quota/i.test(String(e.message || '')))) {
            console.warn('[image-cache] IDB quota exceeded — forcing aggressive eviction');
            forceEvictIDB(IDB_EVICT_BATCH * 2).catch(() => {});
        }
        // それ以外は best-effort なので無視
    }
}

/**
 * 5/23 Phase E: 強制 eviction（quota 圧迫時用・件数指定）
 * lastUsedAt が古い順から指定件数を削除。
 */
async function forceEvictIDB(deleteCount) {
    const db = await openIDB();
    if (!db) return;
    try {
        await new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            const idx = tx.objectStore(IDB_STORE).index('lastUsedAt');
            const cursorReq = idx.openCursor();
            let deleted = 0;
            cursorReq.onsuccess = (e) => {
                const cursor = e.target.result;
                if (!cursor || deleted >= deleteCount) { resolve(); return; }
                cursor.delete();
                deleted++;
                cursor.continue();
            };
            cursorReq.onerror = () => resolve();
            tx.onerror = () => resolve();
        });
    } catch (e) { /* ignore */ }
}

/**
 * 5/23 Phase E: navigator.storage.estimate() ベースの quota 監視。
 * 使用率が 80% を超えていれば proactive eviction を実行。
 * 起動時に 1 回 + 30 件書き込みごとに 1 回呼ぶ想定。
 */
let _quotaCheckCounter = 0;
async function checkQuotaAndEvictIfHigh() {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return;
    try {
        const { usage, quota } = await navigator.storage.estimate();
        if (!quota || !usage) return;
        const ratio = usage / quota;
        if (ratio >= 0.8) {
            console.warn(`[image-cache] storage usage ${Math.round(ratio*100)}% (${Math.round(usage/1e6)}MB / ${Math.round(quota/1e6)}MB) — evicting`);
            await forceEvictIDB(IDB_EVICT_BATCH * 2);
        }
    } catch (e) { /* ignore */ }
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
        const toDelete = Math.min(IDB_EVICT_BATCH, count - IDB_MAX_ENTRIES);
        await new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            const idx = tx.objectStore(IDB_STORE).index('lastUsedAt');
            const cursorReq = idx.openCursor();
            let deleted = 0;
            cursorReq.onsuccess = (e) => {
                const cursor = e.target.result;
                if (!cursor || deleted >= toDelete) { resolve(); return; }
                cursor.delete();
                deleted++;
                cursor.continue();
            };
            cursorReq.onerror = () => resolve();
            tx.onerror = () => resolve();
        });
    } catch (e) { /* ignore */ }
}

/**
 * アプリ起動時に IDB から最新の N 件を memory に流し込み。
 * 描画前に warm-up することで、画面遷移直後の cache hit 率を上げる。
 */
async function preloadFromIDB(limit = MAX_ENTRIES) {
    const db = await openIDB();
    if (!db) return;
    try {
        const entries = await new Promise((resolve) => {
            const result = [];
            const tx = db.transaction(IDB_STORE, 'readonly');
            const idx = tx.objectStore(IDB_STORE).index('lastUsedAt');
            // newest first
            const cursorReq = idx.openCursor(null, 'prev');
            cursorReq.onsuccess = (e) => {
                const cursor = e.target.result;
                if (!cursor || result.length >= limit) { resolve(result); return; }
                result.push(cursor.value);
                cursor.continue();
            };
            cursorReq.onerror = () => resolve(result);
            tx.onerror = () => resolve(result);
        });
        for (const entry of entries) {
            if (cache.has(entry.url)) continue; // 既にメモリ層にある（並行 fetch）
            // 5/27 #93: IDB から取り出した blob が空/不正なら skip（Safari で稀に発生し "?" 描画の原因に）
            if (!(entry.blob instanceof Blob) || entry.blob.size === 0) continue;
            try {
                const blobUrl = URL.createObjectURL(entry.blob);
                cache.set(entry.url, {
                    blobUrl,
                    fetchedAt: entry.fetchedAt || Date.now(),
                    lastUsedAt: entry.lastUsedAt || Date.now(),
                    etag: entry.etag || '',
                });
                // DOM に既に <img> が描画されていれば blob URL に差し替える
                updateLiveImages(entry.url, blobUrl);
            } catch (e) { /* invalid blob は無視 */ }
        }
        // 既存メモリ層と合算した結果が上限を超える可能性があるので一度整理
        evictIfNeeded();
    } catch (e) { /* ignore */ }
}

/**
 * メモリ + IndexedDB のキャッシュを全クリア（ログアウト時の呼び出し用）。
 * プライバシー保護：別ユーザーが同一デバイスでログインしたときに前ユーザーの
 * キャッシュを残さないため。
 */
export async function clearAll() {
    // メモリ
    for (const entry of cache.values()) {
        URL.revokeObjectURL(entry.blobUrl);
    }
    cache.clear();
    inflight.clear();
    // IndexedDB
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

// モジュールロード直後に IDB から memory に warm-up（非同期・描画をブロックしない）
preloadFromIDB().catch(() => {});
// 5/23 Phase E: 起動時に 1 回 quota チェック
checkQuotaAndEvictIfHigh().catch(() => {});

// 5/27 #93: Safari/iOS で blob URL の描画が失敗した場合に original URL へフォールバック。
// 原因例: 古いセッションの IDB blob が空、または Safari 特有の blob URL ライフサイクル問題。
// img の error イベントは bubble しないため capture 段階でグローバル捕捉する。
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    window.addEventListener('error', (e) => {
        const t = e.target;
        if (!t || t.tagName !== 'IMG') return;
        const original = t.dataset?.originalUrl;
        if (!original || t.src === original) return;
        if (!t.src.startsWith('blob:')) return;
        // 壊れた blob URL は cache からも除去して次回再フェッチさせる
        const cached = cache.get(original);
        if (cached && cached.blobUrl === t.src) {
            URL.revokeObjectURL(cached.blobUrl);
            cache.delete(original);
        }
        t.src = original;
    }, true);
}
