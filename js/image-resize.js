// 5/11 #67: 画像リサイズ＋圧縮 + アップロードのタイムアウト/リトライ
// 5/3 #29 のタイムアウト処理（60秒）で見えた本質的な問題（4MB超の画像が
// カンボジアの通信環境で完了しない）への根本対策。
//
// 使い方:
//   import { uploadImageResized } from '/js/image-resize.js';
//   const url = await uploadImageResized(storageRef, file);
//
// 既存の `uploadBytes(storageRef, file, { cacheControl })` を
// `uploadImageResized(storageRef, file)` に置き換えるだけで以下が有効化される：
//   - Canvas でリサイズ＋JPEG圧縮（最大幅1280px・品質0.8 → 概ね 200–400KB）
//   - アップロードのタイムアウトを 60秒 → 180秒 に緩和
//   - 失敗時に最大3回まで指数バックオフでリトライ
//   - 戻り値: getDownloadURL の URL 文字列

import {
    uploadBytes, getDownloadURL
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-storage.js';

const DEFAULTS = {
    maxWidth: 1280,
    maxHeight: 1280,
    quality: 0.8,
    mimeType: 'image/jpeg',
    skipIfSmallerThanBytes: 200 * 1024,   // 200KB 未満ならリサイズ不要
    skipIfSmallerSidePx: 1280,            // 元画像が小さければリサイズ不要
};

/**
 * 画像ファイルをリサイズ＋圧縮して Blob を返す。
 * - 画像でない場合は元のファイルをそのまま返す
 * - 既に十分小さい場合（<200KB かつ <1280px）も元のままにする
 */
export async function resizeImage(file, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    if (!file || !file.type || !file.type.startsWith('image/')) {
        return file; // 画像以外はそのまま
    }

    // 1) 元画像を Image オブジェクトに読み込み
    const bitmap = await loadImage(file);
    try {
        const { width: srcW, height: srcH } = bitmap;
        // 既に十分小さければスキップ
        if (file.size <= o.skipIfSmallerThanBytes && srcW <= o.skipIfSmallerSidePx && srcH <= o.skipIfSmallerSidePx) {
            return file;
        }
        // 2) リサイズ計算（アスペクト比保持）
        let { width: dstW, height: dstH } = fitInside(srcW, srcH, o.maxWidth, o.maxHeight);
        if (dstW < 1) dstW = 1;
        if (dstH < 1) dstH = 1;
        // 3) Canvas に描画して toBlob
        const canvas = document.createElement('canvas');
        canvas.width = dstW;
        canvas.height = dstH;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, dstW, dstH);
        const blob = await new Promise((resolve, reject) => {
            canvas.toBlob((b) => {
                if (b) resolve(b);
                else reject(new Error('Canvas.toBlob returned null'));
            }, o.mimeType, o.quality);
        });
        return blob;
    } finally {
        // ImageBitmap の場合は close で解放
        if (typeof bitmap.close === 'function') bitmap.close();
    }
}

function fitInside(srcW, srcH, maxW, maxH) {
    const r = Math.min(maxW / srcW, maxH / srcH, 1);
    return { width: Math.round(srcW * r), height: Math.round(srcH * r) };
}

async function loadImage(file) {
    // モダンブラウザは createImageBitmap が高速
    if (typeof createImageBitmap === 'function') {
        try {
            return await createImageBitmap(file);
        } catch (e) {
            // フォールバックへ
        }
    }
    // フォールバック: HTMLImageElement
    return await new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
            URL.revokeObjectURL(url);
            resolve(img);
        };
        img.onerror = () => {
            // 5/23 #77: Event を生 reject すると caller 側で `[object Event]` になり
            //   原因不明になる問題への対策。decode 不可なファイル種別（HEIC など）の
            //   切り分けがしやすいよう name/type/size をメッセージに含める。
            URL.revokeObjectURL(url);
            reject(new Error(
                `Image decode failed (name=${file?.name || 'unknown'}, ` +
                `type=${file?.type || 'unknown'}, size=${file?.size || 0})`
            ));
        };
        img.src = url;
    });
}

/**
 * 指数バックオフで Promise をリトライ
 */
function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout: ${label} (${ms}ms)`)), ms)
        ),
    ]);
}

async function retry(fn, { tries = 3, baseDelayMs = 1000 } = {}) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
        try {
            return await fn(i);
        } catch (err) {
            lastErr = err;
            // 最後の試行ならリスロー
            if (i === tries - 1) throw err;
            const delay = baseDelayMs * Math.pow(2, i);
            console.warn(`upload retry (${i + 1}/${tries}) after ${delay}ms:`, err.message);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastErr;
}

const UPLOAD_TIMEOUT_MS = 180000; // 5/11 #67: 60秒 → 180秒
const DOWNLOAD_URL_TIMEOUT_MS = 30000;

/**
 * 5/23 #77: 例外を診断情報付き Error にラップする。
 * - phase: どのフェーズで失敗したか（resize / uploadBytes / getDownloadURL）
 * - FirebaseError の code / serverResponse を message に展開
 * - Event オブジェクトの場合は type を展開
 * - 元の値は wrapped.cause に保持
 * caller 側で `err.message` を表示するだけで原因が見える状態にする。
 */
function wrapUploadError(err, phase, file) {
    if (err && err.__uploadWrapped) return err; // 二重ラップ防止
    const parts = [`phase=${phase}`];
    if (err?.code) parts.push(`code=${err.code}`);
    if (err?.name && err.name !== 'Error') parts.push(`name=${err.name}`);
    if (err?.message) parts.push(`msg=${err.message}`);
    if (err?.serverResponse) parts.push(`server=${String(err.serverResponse).slice(0, 120)}`);
    // Event 系（ProgressEvent など）
    if (!err?.message && err?.type) parts.push(`event=${err.type}`);
    if (file?.name) parts.push(`file=${file.name}`);
    if (typeof file?.size === 'number') parts.push(`size=${file.size}`);
    if (file?.type) parts.push(`type=${file.type}`);
    const wrapped = new Error(parts.join(' | '));
    wrapped.__uploadWrapped = true;
    wrapped.uploadPhase = phase;
    wrapped.uploadCode = err?.code || null;
    wrapped.uploadServerResponse = err?.serverResponse || null;
    wrapped.cause = err;
    return wrapped;
}

/**
 * 画像をリサイズしてからアップロードし、URL を返す。
 * - 失敗時は最大3回までリトライ
 * - uploadBytes 自体に 180秒のタイムアウトを掛ける
 * - 5/23 #77: 全ての throw を診断情報付き Error にラップ
 */
export async function uploadImageResized(storageRef, file, opts = {}) {
    const resizeOpts = opts.resize || {};
    const uploadMeta = {
        cacheControl: 'public, max-age=31536000',
        ...(opts.metadata || {}),
    };

    let blob;
    try {
        // リサイズは1回だけ（リトライ毎にやり直すのは無駄）
        blob = await resizeImage(file, resizeOpts);
    } catch (err) {
        throw wrapUploadError(err, 'resize', file);
    }

    try {
        await retry(async () => {
            await withTimeout(
                uploadBytes(storageRef, blob, uploadMeta),
                UPLOAD_TIMEOUT_MS,
                `uploadBytes ${file?.name || 'blob'}`
            );
        }, { tries: 3, baseDelayMs: 1000 });
    } catch (err) {
        throw wrapUploadError(err, 'uploadBytes', file);
    }

    try {
        const url = await withTimeout(
            getDownloadURL(storageRef),
            DOWNLOAD_URL_TIMEOUT_MS,
            'getDownloadURL'
        );
        return url;
    } catch (err) {
        throw wrapUploadError(err, 'getDownloadURL', file);
    }
}
