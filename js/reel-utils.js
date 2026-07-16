// 🎬 7/9 #199: リール動画 データ層（アップロード・検証・照会・削除・鮮度表記）。
// reels-spec v2.1 の正本ロジック。UI（カード/全画面/④リスト）は各ページが本モジュールを import して使う。
//
// データモデル（reel_videos／独立コレクション・ポートフォリオ化＝1出品に最大N本）：
//   id, listingId(必須), farmerId(出品オーナー・Storageパス/照会用), videoUrl, storagePath(道連れ物理削除用),
//   thumbUrl(=出品写真を流用), fishType(denormalize), durationSec, postedAt(serverTimestamp)
// featured＝その出品の postedAt 最大（＝最新1本）。保持N上限・道連れ削除は functions（onReelVideoCreated /
//   onFishListingDeletedCascade）が担う＝クライアントは「最新を追加」するだけ。個別🗑削除のみクライアント実行。
//
// ⚠ インデックス不要方針：per-listing / per-farmer は equality のみで取得しクライアントで postedAt ソート
//   （equality+orderBy は複合インデックスを要するため避ける）。Home の新着のみ orderBy postedAt desc（単一フィールド＝自動index）。

import { db, storage } from '/js/firebase-config.js';
import {
    collection, doc, setDoc, deleteDoc, getDocs, query, where, orderBy, limit, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import {
    ref, uploadBytes, uploadBytesResumable, getDownloadURL, deleteObject
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-storage.js';

export const MAX_REELS_PER_LISTING = 10;   // 出品ごと保持上限（reels-spec §6 確定・N=10）
export const MAX_VIDEO_DURATION_SEC = 30;  // 上限30秒（＝再エンコード時間の上限も兼ねる・2026-07-12）
const THUMB_MAX_DIM = 720;                 // 2026-07-15 #205: 動画1コマ サムネ／poster の最大辺（カード/全画面に十分）

const ORIGINAL_MAX_BYTES = 120 * 1024 * 1024; // 原本の受け入れ上限（sanity・巨大4Kのdecode OOM回避）
const UPLOAD_MAX_BYTES = 48 * 1024 * 1024;    // アップロード後（圧縮後 or 原本）の上限（Storageルール50MBに余裕）

// クライアント自動圧縮（reels-spec §9「農家は撮る/選ぶだけ・圧縮は自動」）：
//   canvas + MediaRecorder で 720p / 低ビットレートの mp4(H.264) に再エンコードする。
//   ⚠ mp4(H.264)出力が可能な端末でのみ圧縮する。webm しか出せない端末（多くの Android Chrome）では
//     圧縮せず原本 mp4 をそのまま上げる＝webm化して iOS Safari 再生を壊さない（クロス再生を守る）。
//   失敗/非対応/効果なしのときは必ず原本にフォールバック＝アップロードは絶対に止めない。
const COMPRESS_MAX_DIM = 720;
const COMPRESS_BITRATE = 1200000;   // ~1.2Mbps（480〜720p・短尺で概ね1〜3MB）
const COMPRESS_FPS = 24;

const COL = 'reel_videos';

// ─────────────────────────────────────────────────────────────
// アップロード・検証
// ─────────────────────────────────────────────────────────────

/**
 * 選択された動画ファイルの受け入れ判定（種別・長さ・原本の sanity 上限）。圧縮は compressReelVideo が行う。
 * ＝長すぎ/種別違い/桁違いに大きい原本を友好メッセージで弾く（reels-spec §9）。
 * @returns {Promise<{ok:boolean, durationSec:number, reason?:'type'|'size'|'duration'}>}
 */
export async function validateVideoFile(file) {
    if (!file || !file.type || !file.type.startsWith('video/')) {
        return { ok: false, durationSec: 0, reason: 'type' };
    }
    if (file.size > ORIGINAL_MAX_BYTES) {
        return { ok: false, durationSec: 0, reason: 'size' };
    }
    const durationSec = await probeDurationSec(file);
    if (durationSec > MAX_VIDEO_DURATION_SEC + 0.5) {
        return { ok: false, durationSec, reason: 'duration' };
    }
    return { ok: true, durationSec };
}

// 隠し <video> に読み込んで再生時間を取得（取得不可なら 0＝サイズ上限で担保）。
function probeDurationSec(file) {
    return new Promise((resolve) => {
        try {
            const v = document.createElement('video');
            v.preload = 'metadata';
            v.muted = true;
            const url = URL.createObjectURL(file);
            let done = false;
            const finish = (sec) => {
                if (done) return;
                done = true;
                URL.revokeObjectURL(url);
                resolve(Number.isFinite(sec) && sec > 0 ? sec : 0);
            };
            v.onloadedmetadata = () => finish(v.duration);
            v.onerror = () => finish(0);
            // メタデータが来ないケースのタイムアウト
            setTimeout(() => finish(0), 8000);
            v.src = url;
        } catch (e) {
            resolve(0);
        }
    });
}

function extFromMime(mime) {
    if (!mime) return 'mp4';
    if (mime.includes('mp4')) return 'mp4';
    if (mime.includes('quicktime')) return 'mov';
    if (mime.includes('webm')) return 'webm';
    if (mime.includes('3gpp')) return '3gp';
    return 'mp4';
}

// mp4(H.264) を出せる MediaRecorder mimeType を探す。無ければ null＝圧縮しない（原本を上げる）。
function pickMp4RecorderType() {
    if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return null;
    for (const t of ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4']) {
        try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (e) { /* ignore */ }
    }
    return null;
}

function onceEvent(el, name, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        let done = false;
        const ok = () => { if (done) return; done = true; cleanup(); resolve(); };
        const bad = () => { if (done) return; done = true; cleanup(); reject(new Error('event failed: ' + name)); };
        const to = setTimeout(bad, timeoutMs);
        function cleanup() { clearTimeout(to); el.removeEventListener(name, ok); el.removeEventListener('error', bad); }
        el.addEventListener(name, ok, { once: true });
        el.addEventListener('error', bad, { once: true });
    });
}

/**
 * クライアント自動圧縮（reels-spec §9）：canvas + MediaRecorder で 720p / 低ビットレートの mp4 に再エンコード。
 *   ⚠ mp4(H.264)出力が可能な端末のみ実行。webm しか出せない端末では圧縮せず原本を返す（iOS再生を壊さない）。
 *   ⚠ 音声は落とす（鮮度証明は映像・自動再生はミュート／音声トラック合成の互換リスクを避ける・MVP）。
 *   失敗/非対応/効果なし（＝原本以上）のときは原本を返す＝アップロードは絶対に止めない。
 * @returns {Promise<{blob:Blob|File, compressed:boolean}>}
 */
export async function compressReelVideo(file, opts = {}) {
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const mp4Type = pickMp4RecorderType();
    if (!mp4Type || typeof document === 'undefined') return { blob: file, compressed: false };

    let url = null, video = null, raf = 0;
    try {
        video = document.createElement('video');
        video.muted = true; video.playsInline = true; video.preload = 'auto';
        url = URL.createObjectURL(file);
        video.src = url;
        await onceEvent(video, 'loadedmetadata', 8000);
        const w = video.videoWidth, h = video.videoHeight;
        const dur = video.duration || 0;
        if (!w || !h) return { blob: file, compressed: false };

        const scale = Math.min(1, COMPRESS_MAX_DIM / Math.max(w, h));
        const cw = Math.max(2, Math.round((w * scale) / 2) * 2);  // 偶数（エンコーダ要件）
        const ch = Math.max(2, Math.round((h * scale) / 2) * 2);
        const canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        const ctx = canvas.getContext('2d');
        if (!ctx || typeof canvas.captureStream !== 'function') return { blob: file, compressed: false };

        const stream = canvas.captureStream(COMPRESS_FPS);
        let rec;
        try {
            rec = new MediaRecorder(stream, { mimeType: mp4Type, videoBitsPerSecond: COMPRESS_BITRATE });
        } catch (e) {
            return { blob: file, compressed: false };
        }
        const chunks = [];
        rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        const stopped = new Promise((res) => { rec.onstop = res; });
        // 再生終了（or エラー）で録画停止。エラーでも原本 fallback に落とす。
        const ended = new Promise((res) => { video.onended = res; video.onerror = res; });

        const draw = () => {
            try { ctx.drawImage(video, 0, 0, cw, ch); } catch (e) { /* ignore frame */ }
            if (onProgress && dur) onProgress(Math.min(1, (video.currentTime || 0) / dur));
            raf = requestAnimationFrame(draw);
        };
        rec.start();
        await video.play();
        draw();
        await ended;
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        if (rec.state !== 'inactive') rec.stop();
        await stopped;

        const blob = new Blob(chunks, { type: 'video/mp4' });
        if (!blob.size || blob.size >= file.size) return { blob: file, compressed: false }; // 効果なければ原本
        return { blob, compressed: true };
    } catch (e) {
        return { blob: file, compressed: false };
    } finally {
        if (raf) cancelAnimationFrame(raf);
        try { if (video) { video.pause(); video.removeAttribute('src'); video.load(); } } catch (e) { /* ignore */ }
        if (url) URL.revokeObjectURL(url);
    }
}

/**
 * 2026-07-15 #205①④: 動画の1コマを canvas でキャプチャして小さい JPEG サムネを作る（サーバ変換なし）。
 *   ＝新着カルーセルのサムネ＋全画面を開いた瞬間の poster（黒画面解消）に兼用（reels-spec §8）。
 *   序盤（真っ黒になりがちな0秒を避けた位置）の1フレームを 720p 以内に縮小して JPEG 化。
 *   失敗（デコード不可・toBlob 非対応・OOM 等）は null を返す＝呼び出し側は写真サムネにフォールバック。
 * @returns {Promise<Blob|null>}
 */
export async function captureVideoThumbnail(source) {
    if (!source || typeof document === 'undefined') return null;
    let url = null, video = null;
    try {
        video = document.createElement('video');
        video.muted = true; video.playsInline = true; video.preload = 'auto';
        url = URL.createObjectURL(source);
        video.src = url;
        await onceEvent(video, 'loadeddata', 8000);
        const w = video.videoWidth, h = video.videoHeight;
        if (!w || !h) return null;
        const dur = video.duration || 0;
        // 0秒は真っ黒になりがち＝少し進めた位置（0.1〜1秒 or 尺の10%）へシーク
        const target = dur > 0 ? Math.min(Math.max(0.1, dur * 0.1), Math.min(1, dur)) : 0;
        if (target > 0) {
            try { video.currentTime = target; await onceEvent(video, 'seeked', 8000); }
            catch (e) { /* シーク不可なら現フレームで続行 */ }
        }
        const scale = Math.min(1, THUMB_MAX_DIM / Math.max(w, h));
        const cw = Math.max(2, Math.round(w * scale));
        const ch = Math.max(2, Math.round(h * scale));
        const canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(video, 0, 0, cw, ch);
        const blob = await new Promise((resolve) => {
            try { canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.8); }
            catch (e) { resolve(null); }
        });
        return (blob && blob.size) ? blob : null;
    } catch (e) {
        return null;
    } finally {
        try { if (video) { video.removeAttribute('src'); video.load(); } } catch (e) { /* ignore */ }
        if (url) URL.revokeObjectURL(url);
    }
}

/**
 * リール動画を「検証 → クライアント自動圧縮 → resumable アップロード → setDoc」で投稿する（＝その出品の最新1本）。
 * 完了後にだけ doc を作る（半端を表示しない）。保持N上限の物理削除は functions onReelVideoCreated が自動で行う。
 * @param {{file:File, listingId:string, farmerId:string, fishType?:string, thumbUrl?:string,
 *          onCompressProgress?:(ratio:number)=>void, onProgress?:(ratio:number)=>void}} args
 * @returns {Promise<{id:string, videoUrl:string, storagePath:string, compressed:boolean}>}
 */
export async function uploadReelVideo(args) {
    const { file, listingId, farmerId, fishType, thumbUrl, onProgress, onCompressProgress } = args || {};
    if (!file || !listingId || !farmerId) throw new Error('uploadReelVideo: missing file/listingId/farmerId');

    // 1) 受け入れ判定（種別・長さ・原本 sanity 上限）
    const v = await validateVideoFile(file);
    if (!v.ok) { const e = new Error('reel-invalid:' + v.reason); e.reason = v.reason; throw e; }
    const durationSec = v.durationSec;

    // 2) クライアント自動圧縮（best-effort・mp4 出力可能な端末のみ・失敗時は原本）
    const { blob: outBlob, compressed } = await compressReelVideo(file, { onProgress: onCompressProgress });

    // 3) アップロード上限（Storageルール50MBに余裕）を超えるなら弾く（圧縮しても収まらない＝もっと短く）
    if (outBlob.size >= UPLOAD_MAX_BYTES) { const e = new Error('reel-invalid:toolarge'); e.reason = 'toolarge'; throw e; }

    const contentType = compressed ? 'video/mp4' : (file.type || 'video/mp4');
    const docRef = doc(collection(db, COL));   // 先に id を採番（Storageパスに使う）
    const id = docRef.id;
    const ext = extFromMime(contentType);
    const storagePath = `reels/${farmerId}/${listingId}/${id}.${ext}`;
    const sref = ref(storage, storagePath);

    await new Promise((resolve, reject) => {
        const task = uploadBytesResumable(sref, outBlob, {
            contentType,
            cacheControl: 'public, max-age=31536000',
        });
        task.on('state_changed',
            (snap) => {
                if (typeof onProgress === 'function' && snap.totalBytes) {
                    onProgress(snap.bytesTransferred / snap.totalBytes);
                }
            },
            (err) => reject(err),
            () => resolve()
        );
    });

    const videoUrl = await getDownloadURL(sref);

    // 2026-07-15 #205①④: 動画の1コマをサムネにする（新着カルーセル＋全画面 poster 兼用）。
    //   ⚠ サムネ生成/アップロード失敗でリール作成を止めない＝写真（thumbUrl 引数）にフォールバック。
    //   thumbStoragePath を doc に保存＝削除時（個別/保持N超過/道連れ）にサムネも物理削除＝orphan を作らない。
    let finalThumbUrl = thumbUrl || '';
    let thumbStoragePath = '';
    try {
        const thumbBlob = await captureVideoThumbnail(outBlob);
        if (thumbBlob) {
            const tp = `reels/${farmerId}/${listingId}/${id}_thumb.jpg`;
            const tref = ref(storage, tp);
            await uploadBytes(tref, thumbBlob, { contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000' });
            finalThumbUrl = await getDownloadURL(tref);
            thumbStoragePath = tp;
        }
    } catch (e) { /* サムネ失敗＝写真フォールバック（reel は成立させる） */ }

    await setDoc(docRef, {
        listingId,
        farmerId,
        fishType: fishType || '',
        videoUrl,
        storagePath,
        thumbUrl: finalThumbUrl,
        thumbStoragePath,
        durationSec: Math.round(durationSec || 0),
        postedAt: serverTimestamp(),
    });
    return { id, videoUrl, storagePath, thumbStoragePath, compressed };
}

/** 個別削除（④の🗑・撮り直しミス等）。Storage 実体 → doc の順で消す（本人のみ・rules で担保）。 */
export async function deleteReelVideo(reel) {
    if (!reel) return;
    if (reel.storagePath) {
        try { await deleteObject(ref(storage, reel.storagePath)); }
        catch (e) { /* 既に無い(404)等は無視 */ }
    }
    // #205: 動画1コマ サムネ（_thumb.jpg）も道連れ物理削除（orphan を作らない）。
    if (reel.thumbStoragePath) {
        try { await deleteObject(ref(storage, reel.thumbStoragePath)); }
        catch (e) { /* 404 等は無視 */ }
    }
    if (reel.id) {
        try { await deleteDoc(doc(db, COL, reel.id)); } catch (e) { /* ignore */ }
    }
}

// ─────────────────────────────────────────────────────────────
// 照会（equality のみ＋クライアントソート＝複合インデックス不要）
// ─────────────────────────────────────────────────────────────

function mapDocs(qs) {
    const out = [];
    qs.forEach((d) => out.push({ id: d.id, ...d.data() }));
    return out;
}

/** その出品の保持動画を postedAt 降順（最大 max 本）。商品詳細「この魚の動画」・④リスト・全画面フィード用。 */
export async function getReelsForListing(listingId, max = MAX_REELS_PER_LISTING) {
    if (!listingId) return [];
    const qs = await getDocs(query(collection(db, COL), where('listingId', '==', listingId)));
    const arr = mapDocs(qs).sort(byPostedDesc);
    return typeof max === 'number' ? arr.slice(0, max) : arr;
}

/** その出品の featured（＝最新1本）。カード🎬バッジ・Home用の「1出品1本」判定に。 */
export async function getFeaturedReel(listingId) {
    const arr = await getReelsForListing(listingId, 1);
    return arr[0] || null;
}

/** その農家の全出品の全保持動画を postedAt 降順で合算。生産者ページ ポートフォリオ用。 */
export async function getFarmerPortfolio(farmerId) {
    if (!farmerId) return [];
    const qs = await getDocs(query(collection(db, COL), where('farmerId', '==', farmerId)));
    return mapDocs(qs).sort(byPostedDesc);
}

/**
 * 直近のリールを新着順で取得（Home 新着リール・全画面フィードの母集団）。
 * 単一フィールド orderBy（自動index）。呼び出し側で「配達圏内×在庫×販売中」で絞り、listingId ごとに featured 1本へ dedupe する。
 */
export async function getRecentReels(max = 60) {
    const qs = await getDocs(query(collection(db, COL), orderBy('postedAt', 'desc'), limit(max)));
    return mapDocs(qs);
}

/** listingId 単位で最新1本だけ残す（Home「1出品につき featured 1本」）。入力は postedAt 降順前提。 */
export function dedupeFeaturedByListing(reels) {
    const seen = new Set();
    const out = [];
    for (const r of reels || []) {
        if (seen.has(r.listingId)) continue;
        seen.add(r.listingId);
        out.push(r);
    }
    return out;
}

function byPostedDesc(a, b) { return postedMillis(b.postedAt) - postedMillis(a.postedAt); }

// ─────────────────────────────────────────────────────────────
// 鮮度表記（「○時間前に投稿」＝事実）
// ─────────────────────────────────────────────────────────────

/** Firestore Timestamp / {seconds} / millis / Date を millis に。 */
export function postedMillis(v) {
    if (!v) return 0;
    if (typeof v === 'number') return v;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    if (v instanceof Date) return v.getTime();
    return 0;
}

/**
 * 「たった今 / N分前 / N時間前 / N日前」の相対表記を i18next で組み立てる。
 * i18n キー：reel.justNow / reel.minutesAgo{{n}} / reel.hoursAgo{{n}} / reel.daysAgo{{n}}
 * @param {*} postedAt Firestore値/millis
 * @param {(key:string,opts?:object)=>string} t  i18next.t
 */
export function relativePostedText(postedAt, t) {
    const ms = postedMillis(postedAt);
    if (!ms) return '';
    const diff = Math.max(0, Date.now() - ms);
    const min = Math.floor(diff / 60000);
    if (min < 1) return t('reel.justNow');
    if (min < 60) return t('reel.minutesAgo', { n: min });
    const hr = Math.floor(min / 60);
    if (hr < 24) return t('reel.hoursAgo', { n: hr });
    const day = Math.floor(hr / 24);
    return t('reel.daysAgo', { n: day });
}

/** 秒数を "M:SS" に（デュレーションピル用）。 */
export function formatDuration(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
}
