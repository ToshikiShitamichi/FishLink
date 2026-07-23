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
//   ⚠ 2026-07-17 #205⑮: 音声を低ビットレートで残す（魚の跳ね・水音＝"活きてる感"／30秒でも +0.5MB 程度）。
//     旧実装は canvas ストリーム（映像のみ）を録っていたため 🔊 にしても永久に無音だった。
//   失敗/非対応/効果なしのときは必ず原本にフォールバック＝アップロードは絶対に止めない。
const COMPRESS_MAX_DIM = 720;
const COMPRESS_BITRATE = 1200000;   // ~1.2Mbps（480〜720p・短尺で概ね1〜3MB）
const COMPRESS_AUDIO_BITRATE = 64000; // 64kbps（低ビットレート＝30秒で +0.2〜0.3MB 程度・#205⑮の許容範囲）
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

// #205⑮: 映像+音声（H.264 + AAC）の候補。音を残すため必ずこちらを先に試す。
const MP4_AV_TYPES = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2'];
// 映像のみの候補（従来）。⚠ 素の 'video/mp4' は音声コーデックを宣言していない＝映像のみ扱いにする
//   （音声コーデック未宣言の recorder に音声トラックを渡すと start() で落ちる端末があるため保守的に）。
const MP4_V_TYPES = ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4'];

function supportedRecorderType(list) {
    if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return null;
    for (const t of list) {
        try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (e) { /* ignore */ }
    }
    return null;
}

/**
 * mp4(H.264) を出せる MediaRecorder mimeType を探す。無ければ null＝圧縮しない（原本を上げる）。
 * #205⑮: 音声つき候補 → 映像のみ候補 の順に試し、どちらだったかを呼び出し側に返す。
 * @returns {{type:string, withAudio:boolean}|null}
 */
function pickMp4RecorderType() {
    const av = supportedRecorderType(MP4_AV_TYPES);
    if (av) return { type: av, withAudio: true };
    const v = supportedRecorderType(MP4_V_TYPES);
    return v ? { type: v, withAudio: false } : null;
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
 *   ⚠ 音声は低ビットレート（64kbps）で残す（#205⑮・魚の跳ね/水音は"活きてる感"に効く）。
 *     音声つき mp4 を出せない端末・音声の取り出しに失敗した端末では従来どおり映像のみ＝無音になる。
 *     ⚠ 圧縮中に端末のスピーカーから音を鳴らさない（下の Web Audio の注記を参照）。
 *   失敗/非対応/効果なし（＝原本以上）のときは原本を返す＝アップロードは絶対に止めない。
 * @returns {Promise<{blob:Blob|File, compressed:boolean}>}
 */
export async function compressReelVideo(file, opts = {}) {
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const picked = pickMp4RecorderType();
    if (!picked || typeof document === 'undefined') return { blob: file, compressed: false };
    const mp4Type = picked.type;

    let url = null, video = null, raf = 0, audioCtx = null, audioTrack = null;
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

        // #205⑮: 音声トラックを Web Audio 経由で「録音先だけ」に繋ぐ。
        //   ⚠ ここが肝＝video.captureStream() で取る／単に muted=false にする方式だと、
        //     「動画を処理中…」の裏で農家の端末からいきなり動画の音が鳴る（驚かせる）。
        //     createMediaElementSource は要素の音声出力を Web Audio グラフへ移すので、
        //     audioCtx.destination（スピーカー）に繋がず MediaStreamDestination だけに繋げば無音のまま録れる。
        //   ⚠ createMediaElementSource は muted の要素からは音を拾えないので video.muted=false にするが、
        //     上記のとおりスピーカーへは出ない。要素は本関数内で使い捨て（finally で破棄）＝副作用は残らない。
        if (picked.withAudio) {
            try {
                const AC = window.AudioContext || window.webkitAudioContext;
                if (AC) {
                    audioCtx = new AC();
                    try { await audioCtx.resume(); } catch (e) { /* 握る＝下の state 判定で音声を諦める */ }
                    // ⚠ suspended のまま createMediaElementSource すると要素の音声経路が止まったままになり、
                    //   再生が進まない＝ended が来ず「動画を処理中…」で固まる端末がある（iOS はユーザー操作外だと
                    //   resume できないことがある）。running のときだけ音声を録る＝固まらせない方を優先。
                    if (audioCtx.state === 'running') {
                        const srcNode = audioCtx.createMediaElementSource(video);
                        const dest = audioCtx.createMediaStreamDestination();
                        srcNode.connect(dest);   // ⚠ audioCtx.destination には繋がない（＝スピーカーから鳴らさない）
                        const tr = dest.stream.getAudioTracks()[0];
                        if (tr) {
                            video.muted = false; // ソースを有音に（出力先は dest のみ）
                            stream.addTrack(tr);
                            audioTrack = tr;
                        }
                    }
                }
            } catch (e) {
                // AudioContext 非対応／createMediaElementSource が投げる等＝音声なしで圧縮を続行（従来どおり無音）。
                // ⚠ 途中で落ちた場合に備えて muted に戻す（unmuted のまま play() して自動再生拒否を招かないため）。
                audioTrack = null;
                try { video.muted = true; } catch (e2) { /* ignore */ }
            }
        }

        // 再生終了（or エラー）で録画停止。エラーでも原本 fallback に落とす。
        const ended = new Promise((res) => { video.onended = res; video.onerror = res; });

        // ⚠ 録画開始より先に再生を確定させる＝音あり再生が拒否されたときに、録画開始前なら
        //   安全に音声トラックを外して映像のみで作り直せる（ここで諦めると圧縮ごと失敗し、
        //   非圧縮の巨大ファイルが上がって再生が激遅になる＝⑦の悪化）。
        try {
            await video.play();
        } catch (e) {
            if (!audioTrack) throw e;
            // unmuted の自動再生がブラウザに拒否された＝音声を諦めて muted に戻して再試行
            try { stream.removeTrack(audioTrack); } catch (e2) { /* ignore */ }
            try { audioTrack.stop(); } catch (e2) { /* ignore */ }
            audioTrack = null;
            video.muted = true;
            await video.play();   // これも駄目なら catch へ＝原本フォールバック
        }

        // ⚠ #205⑮: 音声つきの mimeType（AAC宣言）を選んだのに音声トラックを取れなかった場合は、
        //   宣言だけ AAC の映像のみ録画になる。端末によっては MediaRecorder 生成で落ちて
        //   「圧縮せず原本を上げる」（＝ファイルが大きいまま）に落ちるので、先に映像のみ型へ降格しておく。
        const recType = (picked.withAudio && !audioTrack)
            ? (supportedRecorderType(MP4_V_TYPES) || mp4Type)
            : mp4Type;
        const recOpts = { mimeType: recType, videoBitsPerSecond: COMPRESS_BITRATE };
        if (audioTrack) recOpts.audioBitsPerSecond = COMPRESS_AUDIO_BITRATE;
        let rec;
        try {
            rec = new MediaRecorder(stream, recOpts);
        } catch (e) {
            if (!audioTrack) return { blob: file, compressed: false };
            // 音声つきでは作れない端末＝音声を捨てて映像のみで作り直す（圧縮自体は諦めない）
            try { stream.removeTrack(audioTrack); } catch (e2) { /* ignore */ }
            try { audioTrack.stop(); } catch (e2) { /* ignore */ }
            audioTrack = null;
            video.muted = true;
            const vOnlyType = supportedRecorderType(MP4_V_TYPES);
            if (!vOnlyType) return { blob: file, compressed: false };
            try { rec = new MediaRecorder(stream, { mimeType: vOnlyType, videoBitsPerSecond: COMPRESS_BITRATE }); }
            catch (e3) { return { blob: file, compressed: false }; }
        }
        const chunks = [];
        rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        const stopped = new Promise((res) => { rec.onstop = res; });

        const draw = () => {
            try { ctx.drawImage(video, 0, 0, cw, ch); } catch (e) { /* ignore frame */ }
            if (onProgress && dur) onProgress(Math.min(1, (video.currentTime || 0) / dur));
            raf = requestAnimationFrame(draw);
        };
        rec.start();
        draw();
        // ⚠ #215⑰: 「await ended」に無制限で待つと、デコードが詰まった端末で永久にハングする（アップロード全体が固まる）。
        //   ended と「尺+20秒（尺が不明なら固定60秒）」のタイマーを競走させ、タイムアウト時は原本フォールバック＝絶対に止めない。
        const compressTimeoutMs = dur > 0 ? (Math.max(30, dur) + 20) * 1000 : 60000;
        let timedOut = false;
        await Promise.race([
            ended,
            new Promise((res) => setTimeout(() => { timedOut = true; res(); }, compressTimeoutMs)),
        ]);
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        if (rec.state !== 'inactive') { try { rec.stop(); } catch (e) { /* ignore */ } }
        if (timedOut) return { blob: file, compressed: false };   // 詰まった＝原本を返す（finally で後始末は走る）
        // onstop も詰まりうる＝短いタイマーで保険（chunks は stop 前に出揃っているのが通常）
        await Promise.race([stopped, new Promise((res) => setTimeout(res, 4000))]);

        const blob = new Blob(chunks, { type: 'video/mp4' });
        if (!blob.size || blob.size >= file.size) return { blob: file, compressed: false }; // 効果なければ原本
        return { blob, compressed: true };
    } catch (e) {
        return { blob: file, compressed: false };
    } finally {
        if (raf) cancelAnimationFrame(raf);
        // #205⑮: 音声トラック／AudioContext の後始末（開きっぱなしにしない）。
        try { if (audioTrack) audioTrack.stop(); } catch (e) { /* ignore */ }
        try {
            if (audioCtx && typeof audioCtx.close === 'function') {
                const p = audioCtx.close();
                if (p && typeof p.catch === 'function') p.catch(() => { /* ignore */ });
            }
        } catch (e) { /* ignore */ }
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
        video.muted = true;
        video.playsInline = true;
        video.setAttribute('webkit-playsinline', '');
        video.preload = 'auto';
        // ⚠ #215①: iOS Safari は DOM から切り離した（もしくは display:none の）<video> を 1 フレームも
        //   デコードしない＝seek しても canvas が真っ黒／そもそも loadeddata・seeked が来ずハングする。
        //   画面外に極小で貼り付けて（display:none にせず）実際にデコードさせる。
        video.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
        document.body.appendChild(video);
        url = URL.createObjectURL(source);   // ローカル blob から抽出（正しい・変更しない）
        video.src = url;
        await onceEvent(video, 'loadeddata', 8000);
        const w = video.videoWidth, h = video.videoHeight;
        if (!w || !h) return null;
        const dur = video.duration || 0;
        // ⚠ #215①: iOS はデコーダを「暖める」ために一度 play() が要る（seek 前に再生してフレームを描かせる）。
        //   muted 再生なので自動再生ポリシーには掛からない。拒否されても握って続行（seek で拾えることもある）。
        try { await video.play(); } catch (e) { /* デコーダ暖機の best-effort */ }
        // 0秒は真っ黒になりがち＝少し進めた位置（0.1〜1秒 or 尺の10%）へシーク
        const target = dur > 0 ? Math.min(Math.max(0.1, dur * 0.1), Math.min(1, dur)) : 0;
        if (target > 0) {
            try { video.currentTime = target; await onceEvent(video, 'seeked', 8000); }
            catch (e) { /* シーク不可なら現フレームで続行 */ }
        }
        try { video.pause(); } catch (e) { /* ignore */ }
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
        // ⚠ #215①: 旧実装は失敗を握りつぶしていた＝原因が分からなかった。理由をログに残す（返り値は従来どおり null）。
        console.warn('[reel] thumbnail extraction failed:', e);
        return null;
    } finally {
        // DOM から必ず外す（画面外の使い捨て要素を残さない）＋ blob URL を解放
        try { if (video) { video.pause(); video.removeAttribute('src'); video.load(); video.remove(); } } catch (e) { /* ignore */ }
        if (url) URL.revokeObjectURL(url);
    }
}

// ─────────────────────────────────────────────────────────────
// 2026-07-17 #209⑦-1: faststart（moov atom を先頭へ）
// ─────────────────────────────────────────────────────────────

// mp4-faststart.js を「動的 import」で読む理由（静的 import にしない）：
//   ① reel-utils.js は買い手側（Home / 商品詳細 / 生産者ページ / reel-ui）からも import される。
//      静的にすると faststart パーサを全ページに配るうえ、mp4-faststart.js の読み込み失敗が
//      リール表示ごと巻き添えで壊す（＝ blast radius が広すぎる）。
//   ② faststart が要るのは農家のアップロード時だけ。
//   読み込めなければ null＝faststart せず元の blob を上げる（＝速くならないだけ・投稿は必ず成功する）。
let faststartModPromise = null;
async function loadFaststartFn() {
    if (!faststartModPromise) {
        faststartModPromise = import('/js/mp4-faststart.js').catch(() => null);
    }
    const mod = await faststartModPromise;
    return (mod && typeof mod.faststartMp4 === 'function') ? mod.faststartMp4 : null;
}

/**
 * blob を隠し <video> に読ませて「①メタデータが取れるか ②尺」を返す（faststart 後の検証用）。
 * ＝壊れた mp4 を絶対にアップロードしないための門番。ok:false は「読めない／タイムアウト」。
 * durationSec:0 は「読めたが尺が不明（Infinity 等）」＝比較対象にしない。
 */
async function probeBlobMeta(blob, timeoutMs = 4000) {
    let url = null, video = null;
    try {
        video = document.createElement('video');
        video.muted = true; video.playsInline = true; video.preload = 'metadata';
        url = URL.createObjectURL(blob);
        video.src = url;
        await onceEvent(video, 'loadedmetadata', timeoutMs);
        const d = Number(video.duration);
        return { ok: true, durationSec: (Number.isFinite(d) && d > 0) ? d : 0 };
    } catch (e) {
        return { ok: false, durationSec: 0 };
    } finally {
        try { if (video) { video.removeAttribute('src'); video.load(); } } catch (e) { /* ignore */ }
        if (url) URL.revokeObjectURL(url);   // ⚠ 解放必須（48MB の blob URL が居座る）
    }
}

/**
 * アップロード直前に mp4 を faststart 化（moov atom を先頭へ）。#209⑦-1
 *   ＝実機（iPhone・モバイル回線）で「動画がなかなか出てこない／黒いまま」の最有力原因。
 *     moov が末尾だと再生開始前にファイル全体を読む必要があり、progressive 再生ができない。
 *   ⚠ 圧縮した場合も、圧縮せず原本を上げる場合も通す。とくに原本パスが重要＝端末カメラの mp4 は
 *     moov が末尾のことが多く、mp4 録画非対応の Android（＝圧縮がスキップされる端末）では
 *     これが唯一の高速化手段になる。
 *   ⚠ 変換後は必ず <video> で読めることを確認してから採用する（壊れたものは絶対に上げない）。
 *     確認できなければ元の blob を返す＝再生が速くならないだけで投稿は必ず成功する。
 * @returns {Promise<Blob|File>} 採用する blob（元 blob をそのまま返すこともある）
 */
async function toFaststartBlob(src) {
    if (!src || typeof document === 'undefined') return src;
    try {
        const faststartMp4 = await loadFaststartFn();
        if (!faststartMp4) return src;
        const out = await faststartMp4(src);
        // 契約：既に先頭／非対応／失敗なら「引数の blob をそのまま」返す＝同一なら検証も不要
        if (!out || out === src || !out.size) return src;

        // 検証①：メタデータが読めるか（＝並べ替えでファイルを壊していないか）
        const outMeta = await probeBlobMeta(out);
        if (!outMeta.ok) return src;
        // 検証②：尺が元と概ね一致するか。⚠ 元も同じ方法で測る＝尺の意味を揃える
        //   （原本の duration と圧縮後の duration は微妙にずれるため、比較相手は「faststart 前の blob」）。
        //   どちらかが尺不明なら比較しない＝正常なファイルを誤って弾かない。
        const srcMeta = await probeBlobMeta(src);
        if (srcMeta.ok && srcMeta.durationSec > 0 && outMeta.durationSec > 0) {
            const tol = Math.max(0.5, srcMeta.durationSec * 0.1);
            if (Math.abs(outMeta.durationSec - srcMeta.durationSec) > tol) return src;
        }
        return out;
    } catch (e) {
        return src;   // ⚠ ここから例外を外に出さない（faststart の失敗で投稿を落とさない）
    }
}

/**
 * リール動画を「検証 → クライアント自動圧縮 → faststart → resumable アップロード → setDoc」で投稿する（＝その出品の最新1本）。
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

    // 2.5) 2026-07-17 #209⑦-1: faststart（moov を先頭へ）＝実機で「黒いまま出てこない」の最有力原因。
    //   圧縮した／しなかったに関わらず、実際に上げる blob を必ず通す（原本パスこそ moov が末尾のことが多い）。
    //   ⚠ 進捗の無表示区間を作らない：呼び出し側は「動画を処理中…」を出したままなので 100% で埋める
    //     （新しい i18n キーは作らない＝locales は編集しない方針）。48MB では数百ms〜数秒かかりうる。
    if (typeof onCompressProgress === 'function') { try { onCompressProgress(1); } catch (e) { /* ignore */ } }
    let uploadBlob = await toFaststartBlob(outBlob);

    // 3) アップロード上限（Storageルール50MBに余裕）を超えるなら弾く（圧縮しても収まらない＝もっと短く）
    //   ⚠ 判定は「実際に上げる blob」に対して行う＝rules が見るのはこのバイト数（超過を先回りで弾く意味を保つ）。
    //     faststart は atom を並べ替えるだけでサイズはほぼ変わらないが、万一これで上限を跨いだ場合は
    //     faststart 前に戻して投稿を通す（再生が速くならないだけ＝機能は落とさない）。
    if (uploadBlob !== outBlob && uploadBlob.size >= UPLOAD_MAX_BYTES && outBlob.size < UPLOAD_MAX_BYTES) {
        uploadBlob = outBlob;
    }
    if (uploadBlob.size >= UPLOAD_MAX_BYTES) { const e = new Error('reel-invalid:toolarge'); e.reason = 'toolarge'; throw e; }

    const contentType = compressed ? 'video/mp4' : (file.type || 'video/mp4');
    const docRef = doc(collection(db, COL));   // 先に id を採番（Storageパスに使う）
    const id = docRef.id;
    const ext = extFromMime(contentType);
    const storagePath = `reels/${farmerId}/${listingId}/${id}.${ext}`;
    const sref = ref(storage, storagePath);

    await new Promise((resolve, reject) => {
        const task = uploadBytesResumable(sref, uploadBlob, {
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
