// 🎬 2026-07-19 #209⑦-1: MP4 の faststart 化（moov atom をファイルの先頭へ移す）。
//
// なぜ必要か（⑦「実機で全画面リールが黒いまま出てこない」の最有力原因）：
//   MP4 の再生に必要な索引（moov＝どのフレームがファイルのどこにあるか）は、スマホのカメラや
//   MediaRecorder が書き出したファイルでは **末尾** に置かれることが多い。moov が末尾だと
//   プレイヤーは「最後まで落とし切るまで1フレームも描けない」＝カンボジアのモバイル回線では
//   全画面リールが黒いまま何秒も止まる。moov を先頭へ移すと、頭から少しだけ落とした時点で
//   再生を始められる＝Range/206 の progressive 再生が初めて意味を持つ。
//   （⑦は「faststart化」「SWが動画に手を出さない」「全DL待ちをやめる」の3点セットで初めて直る）
//
// 方針：
//   ・外部ライブラリ・WASM は使わない（弱電波でダウンロード量を増やす＝⑦の趣旨に反する）。
//   ・再エンコードしない＝画質・音声はそのまま。トップレベルの box を並べ替え、moov 内の
//     チャンクオフセット（stco/co64）を移動量ぶんだけ加算するだけ（ffmpeg の qt-faststart 相当）。
//   ・少しでも怪しければ「何もしない」＝元の Blob をそのまま返す。壊れた動画を絶対に上げさせない。
//     （リールが少し遅いのは我慢できるが、再生できない動画が上がるのは農家の売上に直結する）
//   ・巨大ファイル（最大48MB）を無駄にコピーしない＝moov（数十KB〜）だけ ArrayBuffer に読み、
//     残りは Blob.slice()（実データをコピーしないビュー）のまま組み直す。

// moov を読み込む上限。実際の30秒リールの moov は数十KB〜数百KB＝これを超えるのは異常か、
// そもそも我々が扱う動画ではない。無駄な巨大アロケーションを避けるためのガード。
const MOOV_MAX_BYTES = 32 * 1024 * 1024;

// 32bit の stco が表現できる最大オフセット（これを超えるなら諦める＝壊すより何もしない方が良い）
const UINT32_MAX = 4294967295;

// 再帰的に中を辿ってよい container box。
//   stco / co64 が居るのは moov > trak > mdia > minf > stbl だけなので、その経路＋
//   確実に box 列だけを含む物に限定する。⚠ udta / meta は中身が規格外・レガシーな
//   バイト列を含むことがあり、box として読み進めると誤読して「壊れている」と誤判定するため辿らない
//   （そこに stco は居ないので辿る必要もない）。
const CONTAINER_TYPES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'mvex', 'dinf']);

/**
 * この環境で faststart 処理が実行できるか（Blob.slice / arrayBuffer が使えるか）。
 * 呼び出し側の分岐用。faststartMp4 自体は非対応でも安全に元 Blob を返すので必須ではない。
 */
export function isFaststartSupported() {
    return typeof Blob !== 'undefined'
        && typeof Blob.prototype.slice === 'function'
        && typeof Blob.prototype.arrayBuffer === 'function';
}

/**
 * MP4 の moov atom を先頭へ移した新しい Blob を返す（qt-faststart 相当）。
 *
 * ⚠ 絶対に throw しない。以下はすべて「元の blob をそのまま返す」：
 *   ・すでに moov が先頭（MediaRecorder の fragmented MP4 等）
 *   ・MP4/QuickTime ではない・box 構造が壊れている・切り詰められている
 *   ・moov より後ろに mdat がある（一律 +moovSize の前提が崩れる＝動画を壊す）
 *   ・cmov（圧縮 moov）を含む・オフセットが 32bit を溢れる
 *   ・組み立て後の自己検証に1つでも失敗した
 * 呼び出し元は農家の投稿フロー＝ここで例外が漏れると魚が売れなくなる。
 *
 * @param {Blob} blob 入力（撮影原本 or クライアント圧縮後の mp4）
 * @returns {Promise<Blob>} faststart 化した Blob（できなければ引数と同一の Blob）
 */
export async function faststartMp4(blob) {
    try {
        if (!blob || typeof blob.size !== 'number' || !blob.size) return blob;
        if (!isFaststartSupported()) return blob;

        const boxes = await scanTopLevelBoxes(blob);
        if (!boxes || !boxes.length) return blob;   // 壊れている/MP4ではない

        const moovIdx = boxes.findIndex((b) => b.type === 'moov');
        const firstMdatIdx = boxes.findIndex((b) => b.type === 'mdat');
        if (moovIdx < 0 || firstMdatIdx < 0) return blob;      // moov か mdat が無い＝触らない
        if (moovIdx < firstMdatIdx) return blob;               // すでに faststart
        // moov が複数ある＝規格外。どれを先頭に出すべきか決められないので触らない。
        if (boxes.filter((b) => b.type === 'moov').length !== 1) return blob;

        // ⚠ moov より後ろに mdat があると「moov 以前のデータが一律 +moovSize ずれる」前提が崩れ、
        //   パッチしたオフセットが実データを指さなくなる＝動画が壊れる。諦めて元を返す。
        const lastMdatIdx = findLastIndex(boxes, (b) => b.type === 'mdat');
        if (lastMdatIdx > moovIdx) return blob;

        // ftyp は必ず先頭に置く。元から先頭でない（前に別の box がある）場合は、ftyp を動かすと
        // ずれ幅が box ごとに変わってしまうので諦める（実ファイルでは ftyp は先頭が普通）。
        const ftypIdx = boxes.findIndex((b) => b.type === 'ftyp');
        if (ftypIdx > 0) return blob;

        const moovBox = boxes[moovIdx];
        if (moovBox.size > MOOV_MAX_BYTES) return blob;

        // moov だけを実体コピーして、その中のチャンクオフセットを +moovSize する。
        const moovBytes = await readBytes(blob, moovBox.start, moovBox.size);
        if (moovBytes.length !== moovBox.size) return blob;
        if (!patchMoovChunkOffsets(moovBytes, moovBox.headerSize, moovBox.size)) return blob;

        // 出力＝[ftyp（あれば）][パッチ済み moov][残りを元の順序で]
        //   残りは Blob.slice()＝実データをコピーしないビュー。連続する範囲はまとめて1枚にする。
        const parts = [];
        if (ftypIdx === 0) parts.push(blob.slice(boxes[0].start, boxes[0].end));
        parts.push(moovBytes);
        let runStart = -1, runEnd = -1;
        for (let i = 0; i < boxes.length; i++) {
            if (i === moovIdx || i === ftypIdx) continue;
            const b = boxes[i];
            if (runStart >= 0 && b.start === runEnd) {
                runEnd = b.end;                    // 直前の box と連続＝1枚にまとめる
            } else {
                if (runStart >= 0) parts.push(blob.slice(runStart, runEnd));
                runStart = b.start; runEnd = b.end;
            }
        }
        if (runStart >= 0) parts.push(blob.slice(runStart, runEnd));

        const out = new Blob(parts, { type: blob.type || 'video/mp4' });

        // 自己検証：壊れたものを絶対にアップロードさせない。1つでも合わなければ元を返す。
        if (!(await verifyOutput(out, blob.size, boxes))) return blob;
        return out;
    } catch (e) {
        // 想定外（アロケーション失敗・環境差異など）＝投稿を止めない
        return blob;
    }
}

// ─────────────────────────────────────────────────────────────
// box の走査
// ─────────────────────────────────────────────────────────────

async function readBytes(blob, start, len) {
    const buf = await blob.slice(start, start + len).arrayBuffer();
    return new Uint8Array(buf);
}

// box type（4文字）を読む。印字可能ASCII以外＝MP4ではない/壊れている とみなす。
function readType(bytes, off) {
    let s = '';
    for (let i = 0; i < 4; i++) {
        const c = bytes[off + i];
        if (c < 0x20 || c > 0x7e) return '';
        s += String.fromCharCode(c);
    }
    return s;
}

/**
 * トップレベルの box を先頭から順に走査する（[size:4][type:4]／size=1 は 64bit／size=0 は末尾まで）。
 * 途中で1つでも辻褄が合わなければ null＝呼び出し側は「何もしない」に倒す。
 * ⚠ 巨大な mdat を読まないようヘッダ16バイトずつしか読まない。
 * @returns {Promise<Array<{type:string,start:number,end:number,size:number,headerSize:number}>|null>}
 */
async function scanTopLevelBoxes(blob) {
    const total = blob.size;
    const boxes = [];
    let pos = 0;
    while (pos < total) {
        if (total - pos < 8) return null;               // 端数が残った＝壊れている
        const head = await readBytes(blob, pos, Math.min(16, total - pos));
        if (head.length < 8) return null;
        const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
        const type = readType(head, 4);
        if (!type) return null;
        let size = dv.getUint32(0);
        let headerSize = 8;
        if (size === 1) {
            // 64bit size（4GB超の mdat 等）。我々の動画では出ないが、走査だけはできるようにする。
            if (head.length < 16) return null;
            const big = dv.getBigUint64(8);
            if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
            size = Number(big);
            headerSize = 16;
        } else if (size === 0) {
            size = total - pos;                          // 「ファイル末尾まで」＝最後の box
        }
        if (size < headerSize || pos + size > total) return null;
        boxes.push({ type, start: pos, end: pos + size, size, headerSize });
        pos += size;
    }
    return boxes.length ? boxes : null;
}

function findLastIndex(arr, pred) {
    for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
    return -1;
}

// ─────────────────────────────────────────────────────────────
// moov 内のチャンクオフセット（stco/co64）のパッチ
// ─────────────────────────────────────────────────────────────

/**
 * moov を先頭へ動かすと、それより前にあった実データ（mdat）が一律 +moovSize ずれる。
 * よって moov 内の全チャンクオフセットに +moovSize する。
 * @param {Uint8Array} moovBytes moov box 全体（ヘッダ込み）のコピー。ここを直接書き換える。
 * @returns {boolean} 成功したか（false＝諦めて元の Blob を返す）
 */
function patchMoovChunkOffsets(moovBytes, headerSize, moovSize) {
    const dv = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength);
    return walkAndPatch(moovBytes, dv, headerSize, moovSize, moovSize, 0);
}

function walkAndPatch(bytes, dv, start, end, delta, depth) {
    if (depth > 8) return false;     // 異常な入れ子＝諦める（実ファイルは stbl まで5段）
    let pos = start;
    while (pos < end) {
        if (end - pos < 8) return false;
        const type = readType(bytes, pos + 4);
        if (!type) return false;
        // ⚠ cmov＝圧縮された moov。中の stco を書き換えられない＝触らない（qt-faststart も同様に諦める）。
        if (type === 'cmov') return false;
        let size = dv.getUint32(pos);
        let headerSize = 8;
        if (size === 1) {
            if (end - pos < 16) return false;
            const big = dv.getBigUint64(pos + 8);
            if (big > BigInt(Number.MAX_SAFE_INTEGER)) return false;
            size = Number(big);
            headerSize = 16;
        } else if (size === 0) {
            size = end - pos;
        }
        if (size < headerSize || pos + size > end) return false;

        if (type === 'stco') {
            if (!patchStco(dv, pos + headerSize, pos + size, delta)) return false;
        } else if (type === 'co64') {
            if (!patchCo64(dv, pos + headerSize, pos + size, delta)) return false;
        } else if (CONTAINER_TYPES.has(type)) {
            if (!walkAndPatch(bytes, dv, pos + headerSize, pos + size, delta, depth + 1)) return false;
        }
        pos += size;
    }
    return pos === end;
}

// stco: version(1)+flags(3) + entryCount(4) + 32bit オフセット × entryCount
function patchStco(dv, payloadStart, boxEnd, delta) {
    if (boxEnd - payloadStart < 8) return false;
    const count = dv.getUint32(payloadStart + 4);
    const first = payloadStart + 8;
    if (first + count * 4 > boxEnd) return false;   // entryCount が box に収まらない＝壊れている
    for (let i = 0; i < count; i++) {
        const off = first + i * 4;
        const next = dv.getUint32(off) + delta;
        if (next > UINT32_MAX) return false;   // 32bit を溢れる＝壊すくらいなら何もしない
        dv.setUint32(off, next);
    }
    return true;
}

// co64: version(1)+flags(3) + entryCount(4) + 64bit オフセット × entryCount
function patchCo64(dv, payloadStart, boxEnd, delta) {
    if (boxEnd - payloadStart < 8) return false;
    const count = dv.getUint32(payloadStart + 4);
    const first = payloadStart + 8;
    if (first + count * 8 > boxEnd) return false;   // entryCount が box に収まらない＝壊れている
    const d = BigInt(delta);
    const max = 18446744073709551615n;   // 2^64-1
    for (let i = 0; i < count; i++) {
        const off = first + i * 8;
        const next = dv.getBigUint64(off) + d;
        if (next > max) return false;
        dv.setBigUint64(off, next);
    }
    return true;
}

// ─────────────────────────────────────────────────────────────
// 自己検証（壊れたものを絶対にアップロードさせない）
// ─────────────────────────────────────────────────────────────

/**
 * 組み立てた出力を読み直して検証する：
 *   (a) 全 box のサイズ合計＝ファイル長（並べ直しで隙間/はみ出しが出ていない）
 *   (b) moov が mdat より前にある（＝faststart になった）
 *   (c) box 種別の集合が元と同じ（取りこぼし/重複がない）
 *   さらに (d) 出力の総バイト数が入力と同じ（並べ替えただけ＝増減しない）
 */
async function verifyOutput(out, originalSize, originalBoxes) {
    if (out.size !== originalSize) return false;                        // (d)
    const boxes = await scanTopLevelBoxes(out);
    if (!boxes || !boxes.length) return false;

    let sum = 0;
    for (const b of boxes) sum += b.size;
    if (sum !== out.size) return false;                                  // (a)

    const moovIdx = boxes.findIndex((b) => b.type === 'moov');
    const mdatIdx = boxes.findIndex((b) => b.type === 'mdat');
    if (moovIdx < 0 || mdatIdx < 0 || moovIdx > mdatIdx) return false;   // (b)

    const before = originalBoxes.map((b) => b.type).sort().join(',');
    const after = boxes.map((b) => b.type).sort().join(',');
    if (before !== after) return false;                                  // (c)
    return true;
}
