// 🎬 2026-07-22 #215⑦: MP4 の faststart 化（moov atom をファイルの先頭へ移す）— サーバ側 CommonJS 版。
//
// ⚠️ これは js/mp4-faststart.js（ブラウザ ES module / Blob 前提）の EXACT な複製で、Cloud Functions が
//    admin SDK で download した Node Buffer に対して同一ロジックを適用する。
//    片方を変えたら必ず両方を EXACT に揃えること（constants・branch 条件・bail 条件・自己検証）。
//    クライアントは投稿時にこれを行うが、既存（旧）動画は moov が末尾のまま＝iOS 等で頭出しできない。
//    本ファイルは admin バックフィル callable（functions/index.js faststartReelBackfill）から使う。
//
// 方針（ブラウザ版と同一）：
//   ・外部ライブラリ・WASM は使わない。再エンコードしない＝画質・音声はそのまま。
//   ・トップレベルの box を並べ替え、moov 内のチャンクオフセット（stco/co64）を移動量ぶんだけ加算するだけ
//     （ffmpeg の qt-faststart 相当）。
//   ・少しでも怪しければ「何もしない」＝元の Buffer を **同一インスタンスのまま** 返す。壊れた動画を絶対に作らない。
//   ・絶対に throw しない。組み立て後の自己検証に失敗したら元を返す。
//
// 使い方（純粋関数）：
//   const { faststartBuffer } = require('./mp4-faststart');
//   const out = faststartBuffer(buf);       // out === buf なら「変換しなかった（既に faststart / 触れない）」
//                                           // out !== buf なら faststart 化した新しい Buffer

// moov を扱う上限。実際の30秒リールの moov は数十KB〜数百KB。これを超えるのは異常。
const MOOV_MAX_BYTES = 32 * 1024 * 1024;

// 32bit の stco が表現できる最大オフセット。
const UINT32_MAX = 4294967295;

// 再帰的に中を辿ってよい container box。stco / co64 が居る経路＋確実に box 列だけを含む物に限定する。
// ⚠ udta / meta は規格外・レガシーなバイト列を含むことがあり誤読する＝辿らない（そこに stco は居ない）。
const CONTAINER_TYPES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'mvex', 'dinf']);

/**
 * MP4 の moov atom を先頭へ移した新しい Buffer を返す（qt-faststart 相当）。
 *
 * ⚠ 絶対に throw しない。以下はすべて「元の Buffer（同一インスタンス）をそのまま返す」：
 *   ・すでに moov が先頭（MediaRecorder の fragmented MP4 等）
 *   ・MP4/QuickTime ではない・box 構造が壊れている・切り詰められている
 *   ・moov より後ろに mdat がある（一律 +moovSize の前提が崩れる＝動画を壊す）
 *   ・cmov（圧縮 moov）を含む・ftyp が先頭でない・moov が無い/複数・オフセットが 32bit を溢れる
 *   ・組み立て後の自己検証に1つでも失敗した
 *
 * @param {Buffer} buf 入力（Storage から download した mp4）
 * @returns {Buffer} faststart 化した新しい Buffer（できなければ引数と同一の Buffer インスタンス）
 */
function faststartBuffer(buf) {
    try {
        if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) return buf;

        const boxes = scanTopLevelBoxes(buf);
        if (!boxes || !boxes.length) return buf;   // 壊れている/MP4ではない

        const moovIdx = boxes.findIndex((b) => b.type === 'moov');
        const firstMdatIdx = boxes.findIndex((b) => b.type === 'mdat');
        if (moovIdx < 0 || firstMdatIdx < 0) return buf;       // moov か mdat が無い＝触らない
        if (moovIdx < firstMdatIdx) return buf;                // すでに faststart
        // moov が複数ある＝規格外。どれを先頭に出すべきか決められないので触らない。
        if (boxes.filter((b) => b.type === 'moov').length !== 1) return buf;

        // ⚠ moov より後ろに mdat があると「moov 以前のデータが一律 +moovSize ずれる」前提が崩れ、
        //   パッチしたオフセットが実データを指さなくなる＝動画が壊れる。諦めて元を返す。
        const lastMdatIdx = findLastIndex(boxes, (b) => b.type === 'mdat');
        if (lastMdatIdx > moovIdx) return buf;

        // ftyp は必ず先頭に置く。元から先頭でない場合は ftyp を動かすとずれ幅が box ごとに変わるので諦める。
        const ftypIdx = boxes.findIndex((b) => b.type === 'ftyp');
        if (ftypIdx > 0) return buf;

        const moovBox = boxes[moovIdx];
        if (moovBox.size > MOOV_MAX_BYTES) return buf;

        // moov だけを実体コピー（Buffer.from＝独立コピー）して、その中のチャンクオフセットを +moovSize する。
        const moovBytes = Buffer.from(buf.subarray(moovBox.start, moovBox.end));
        if (moovBytes.length !== moovBox.size) return buf;
        if (!patchMoovChunkOffsets(moovBytes, moovBox.headerSize, moovBox.size)) return buf;

        // 出力＝[ftyp（あれば）][パッチ済み moov][残りを元の順序で]
        //   残りは buf.subarray()＝実データをコピーしないビュー（concat 時に一度だけコピーされる）。
        //   連続する範囲はまとめて1枚にする。
        const parts = [];
        if (ftypIdx === 0) parts.push(buf.subarray(boxes[0].start, boxes[0].end));
        parts.push(moovBytes);
        let runStart = -1, runEnd = -1;
        for (let i = 0; i < boxes.length; i++) {
            if (i === moovIdx || i === ftypIdx) continue;
            const b = boxes[i];
            if (runStart >= 0 && b.start === runEnd) {
                runEnd = b.end;                    // 直前の box と連続＝1枚にまとめる
            } else {
                if (runStart >= 0) parts.push(buf.subarray(runStart, runEnd));
                runStart = b.start; runEnd = b.end;
            }
        }
        if (runStart >= 0) parts.push(buf.subarray(runStart, runEnd));

        const out = Buffer.concat(parts);

        // 自己検証：壊れたものを絶対に作らない。1つでも合わなければ元を返す。
        if (!verifyOutput(out, buf.length, boxes)) return buf;
        return out;
    } catch (e) {
        // 想定外（アロケーション失敗など）＝元を返す（絶対に throw しない）
        return buf;
    }
}

// ─────────────────────────────────────────────────────────────
// box の走査
// ─────────────────────────────────────────────────────────────

// box type（4文字）を読む。印字可能ASCII以外＝MP4ではない/壊れている とみなす。
function readType(buf, off) {
    let s = '';
    for (let i = 0; i < 4; i++) {
        const c = buf[off + i];
        if (c === undefined || c < 0x20 || c > 0x7e) return '';
        s += String.fromCharCode(c);
    }
    return s;
}

/**
 * トップレベルの box を先頭から順に走査する（[size:4][type:4]／size=1 は 64bit／size=0 は末尾まで）。
 * 途中で1つでも辻褄が合わなければ null＝呼び出し側は「何もしない」に倒す。
 * @returns {Array<{type:string,start:number,end:number,size:number,headerSize:number}>|null}
 */
function scanTopLevelBoxes(buf) {
    const total = buf.length;
    const boxes = [];
    let pos = 0;
    while (pos < total) {
        if (total - pos < 8) return null;               // 端数が残った＝壊れている
        const type = readType(buf, pos + 4);
        if (!type) return null;
        let size = buf.readUInt32BE(pos);
        let headerSize = 8;
        if (size === 1) {
            // 64bit size（4GB超の mdat 等）。
            if (total - pos < 16) return null;
            const big = buf.readBigUInt64BE(pos + 8);
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
 * @param {Buffer} moovBytes moov box 全体（ヘッダ込み）のコピー。ここを直接書き換える。
 * @returns {boolean} 成功したか（false＝諦めて元の Buffer を返す）
 */
function patchMoovChunkOffsets(moovBytes, headerSize, moovSize) {
    return walkAndPatch(moovBytes, headerSize, moovSize, moovSize, 0);
}

function walkAndPatch(buf, start, end, delta, depth) {
    if (depth > 8) return false;     // 異常な入れ子＝諦める（実ファイルは stbl まで5段）
    let pos = start;
    while (pos < end) {
        if (end - pos < 8) return false;
        const type = readType(buf, pos + 4);
        if (!type) return false;
        // ⚠ cmov＝圧縮された moov。中の stco を書き換えられない＝触らない（qt-faststart も同様に諦める）。
        if (type === 'cmov') return false;
        let size = buf.readUInt32BE(pos);
        let headerSize = 8;
        if (size === 1) {
            if (end - pos < 16) return false;
            const big = buf.readBigUInt64BE(pos + 8);
            if (big > BigInt(Number.MAX_SAFE_INTEGER)) return false;
            size = Number(big);
            headerSize = 16;
        } else if (size === 0) {
            size = end - pos;
        }
        if (size < headerSize || pos + size > end) return false;

        if (type === 'stco') {
            if (!patchStco(buf, pos + headerSize, pos + size, delta)) return false;
        } else if (type === 'co64') {
            if (!patchCo64(buf, pos + headerSize, pos + size, delta)) return false;
        } else if (CONTAINER_TYPES.has(type)) {
            if (!walkAndPatch(buf, pos + headerSize, pos + size, delta, depth + 1)) return false;
        }
        pos += size;
    }
    return pos === end;
}

// stco: version(1)+flags(3) + entryCount(4) + 32bit オフセット × entryCount
function patchStco(buf, payloadStart, boxEnd, delta) {
    if (boxEnd - payloadStart < 8) return false;
    const count = buf.readUInt32BE(payloadStart + 4);
    const first = payloadStart + 8;
    if (first + count * 4 > boxEnd) return false;   // entryCount が box に収まらない＝壊れている
    for (let i = 0; i < count; i++) {
        const off = first + i * 4;
        const next = buf.readUInt32BE(off) + delta;
        if (next > UINT32_MAX) return false;   // 32bit を溢れる＝壊すくらいなら何もしない
        buf.writeUInt32BE(next, off);
    }
    return true;
}

// co64: version(1)+flags(3) + entryCount(4) + 64bit オフセット × entryCount
function patchCo64(buf, payloadStart, boxEnd, delta) {
    if (boxEnd - payloadStart < 8) return false;
    const count = buf.readUInt32BE(payloadStart + 4);
    const first = payloadStart + 8;
    if (first + count * 8 > boxEnd) return false;   // entryCount が box に収まらない＝壊れている
    const d = BigInt(delta);
    const max = 18446744073709551615n;   // 2^64-1
    for (let i = 0; i < count; i++) {
        const off = first + i * 8;
        const next = buf.readBigUInt64BE(off) + d;
        if (next > max) return false;
        buf.writeBigUInt64BE(next, off);
    }
    return true;
}

// ─────────────────────────────────────────────────────────────
// 自己検証（壊れたものを絶対に作らない）
// ─────────────────────────────────────────────────────────────

/**
 * 組み立てた出力を読み直して検証する：
 *   (a) 全 box のサイズ合計＝ファイル長（並べ直しで隙間/はみ出しが出ていない）
 *   (b) moov が mdat より前にある（＝faststart になった）
 *   (c) box 種別の集合が元と同じ（取りこぼし/重複がない）
 *   (d) 出力の総バイト数が入力と同じ（並べ替えただけ＝増減しない）
 */
function verifyOutput(out, originalSize, originalBoxes) {
    if (out.length !== originalSize) return false;                        // (d)
    const boxes = scanTopLevelBoxes(out);
    if (!boxes || !boxes.length) return false;

    let sum = 0;
    for (const b of boxes) sum += b.size;
    if (sum !== out.length) return false;                                  // (a)

    const moovIdx = boxes.findIndex((b) => b.type === 'moov');
    const mdatIdx = boxes.findIndex((b) => b.type === 'mdat');
    if (moovIdx < 0 || mdatIdx < 0 || moovIdx > mdatIdx) return false;     // (b)

    const before = originalBoxes.map((b) => b.type).sort().join(',');
    const after = boxes.map((b) => b.type).sort().join(',');
    if (before !== after) return false;                                    // (c)
    return true;
}

module.exports = { faststartBuffer };

// ─────────────────────────────────────────────────────────────
// 自己検証テスト（`node functions/mp4-faststart.js` で実行）。
//   export される faststartBuffer は純粋関数のまま＝この block は直接実行時のみ走る。
//   ⚠ js/mp4-faststart.js は本体にアサーションを持たないため、CLAUDE.md 記載の
//     「合成MP4アサーション」相当を Buffer 版としてここに再現する。
// ─────────────────────────────────────────────────────────────
if (require.main === module) {
    let passed = 0, failed = 0;
    const assert = (cond, msg) => {
        if (cond) { passed++; }
        else { failed++; console.error('  ✗ FAIL:', msg); }
    };

    // ── 合成 box ビルダー ──
    const box = (type, payload) => {
        const size = 8 + payload.length;
        const b = Buffer.alloc(size);
        b.writeUInt32BE(size, 0);
        b.write(type, 4, 'ascii');
        payload.copy(b, 8);
        return b;
    };
    const container = (type, children) => box(type, Buffer.concat(children));
    const stcoBox = (offsets) => {
        const p = Buffer.alloc(8 + offsets.length * 4);
        p.writeUInt32BE(offsets.length, 4);           // version/flags=0, entryCount
        offsets.forEach((o, i) => p.writeUInt32BE(o, 8 + i * 4));
        return box('stco', p);
    };
    const co64Box = (offsets) => {
        const p = Buffer.alloc(8 + offsets.length * 8);
        p.writeUInt32BE(offsets.length, 4);
        offsets.forEach((o, i) => p.writeBigUInt64BE(BigInt(o), 8 + i * 8));
        return box('co64', p);
    };
    // test-local: moov 内の stco/co64 entries を探す（本体の内部関数には依存しない）
    const findChunkEntries = (buf, start, end, is64) => {
        let pos = start;
        while (pos + 8 <= end) {
            const size = buf.readUInt32BE(pos);
            const type = buf.toString('ascii', pos + 4, pos + 8);
            if (size < 8 || pos + size > end) return null;
            if (type === (is64 ? 'co64' : 'stco')) {
                const cnt = buf.readUInt32BE(pos + 12);
                const arr = [];
                for (let i = 0; i < cnt; i++) {
                    arr.push(is64 ? Number(buf.readBigUInt64BE(pos + 16 + i * 8))
                                  : buf.readUInt32BE(pos + 16 + i * 4));
                }
                return arr;
            }
            if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) {
                const r = findChunkEntries(buf, pos + 8, pos + size, is64);
                if (r) return r;
            }
            pos += size;
        }
        return null;
    };
    const topBoxTypes = (buf) => {
        const types = [];
        let pos = 0;
        while (pos + 8 <= buf.length) {
            const size = buf.readUInt32BE(pos);
            types.push(buf.toString('ascii', pos + 4, pos + 8));
            if (size < 8) break;
            pos += size;
        }
        return types;
    };

    const ftyp = box('ftyp', Buffer.from('isommp42', 'ascii')); // size 16

    // mdat: 100B payload, sentinel 0xCC at payload index 10
    const mdatPayload = Buffer.alloc(100, 0xAA);
    mdatPayload[10] = 0xCC;
    const mdat = box('mdat', mdatPayload);                      // size 108

    // ── Test 1: moov が末尾（stco）→ faststart 化される ──
    {
        // original layout: ftyp(16) mdat(108) moov
        //   sentinel abs offset = 16 + 8 + 10 = 34
        const SENT = 34;
        const moov = container('moov', [
            container('trak', [
                container('mdia', [
                    container('minf', [
                        container('stbl', [stcoBox([SENT])]),
                    ]),
                ]),
            ]),
        ]);
        const orig = Buffer.concat([ftyp, mdat, moov]);
        const moovSize = moov.length;
        const out = faststartBuffer(orig);

        assert(out !== orig, 'T1: 変換されたので新しい Buffer が返る');
        assert(Buffer.isBuffer(out), 'T1: 返り値は Buffer');
        assert(out.length === orig.length, 'T1: 長さ不変（並べ替えのみ）');
        const tt = topBoxTypes(out);
        assert(tt[0] === 'ftyp', 'T1: 先頭は ftyp');
        assert(tt[1] === 'moov', 'T1: 2番目に moov（faststart）');
        assert(tt[2] === 'mdat', 'T1: 3番目に mdat');
        const moovBoxStart = 16;                                 // ftyp の後
        const entries = findChunkEntries(out, moovBoxStart + 8, moovBoxStart + 8 + (moovSize - 8), false);
        assert(entries && entries.length === 1, 'T1: stco entry を1件読める');
        assert(entries[0] === SENT + moovSize, `T1: stco が +moovSize されている (${entries[0]} === ${SENT + moovSize})`);
        assert(out[entries[0]] === 0xCC, 'T1: パッチ後のオフセットが sentinel(0xCC) を指す');
        // 元の Buffer を破壊していない
        assert(orig[SENT] === 0xCC && orig[34] === 0xCC, 'T1: 入力 Buffer は不変');
    }

    // ── Test 2: すでに faststart（moov が mdat より前）→ 同一インスタンスを返す ──
    {
        const moov = container('moov', [container('stbl', [stcoBox([34])])]);
        const orig = Buffer.concat([ftyp, moov, mdat]);
        const out = faststartBuffer(orig);
        assert(out === orig, 'T2: 既に faststart は同一インスタンスを返す（no-op）');
    }

    // ── Test 3: co64（64bit オフセット）も +moovSize される ──
    {
        const SENT = 34;
        const moov = container('moov', [
            container('trak', [container('mdia', [container('minf', [container('stbl', [co64Box([SENT])])])])]),
        ]);
        const orig = Buffer.concat([ftyp, mdat, moov]);
        const moovSize = moov.length;
        const out = faststartBuffer(orig);
        assert(out !== orig, 'T3: co64 でも変換される');
        const entries = findChunkEntries(out, 16 + 8, 16 + moovSize, true);
        assert(entries && entries[0] === SENT + moovSize, 'T3: co64 が +moovSize されている');
        assert(out[entries[0]] === 0xCC, 'T3: co64 パッチ後が sentinel を指す');
    }

    // ── Test 4: cmov（圧縮 moov）を含む → 触らず同一インスタンス ──
    {
        const moov = container('moov', [box('cmov', Buffer.alloc(16, 0))]);
        const orig = Buffer.concat([ftyp, mdat, moov]);
        const out = faststartBuffer(orig);
        assert(out === orig, 'T4: cmov を含む moov は変換しない（同一）');
    }

    // ── Test 5: moov が無い → 同一インスタンス ──
    {
        const orig = Buffer.concat([ftyp, mdat]);
        assert(faststartBuffer(orig) === orig, 'T5: moov 無しは no-op');
    }

    // ── Test 6: mdat が無い → 同一インスタンス ──
    {
        const moov = container('moov', [container('stbl', [stcoBox([16])])]);
        const orig = Buffer.concat([ftyp, moov]);
        assert(faststartBuffer(orig) === orig, 'T6: mdat 無しは no-op');
    }

    // ── Test 7: ftyp が先頭でない → 同一インスタンス ──
    {
        const free = box('free', Buffer.alloc(8, 0));
        const moov = container('moov', [container('stbl', [stcoBox([34])])]);
        const orig = Buffer.concat([free, ftyp, mdat, moov]);
        assert(faststartBuffer(orig) === orig, 'T7: ftyp が先頭でないと no-op');
    }

    // ── Test 8: moov が複数 → 同一インスタンス ──
    {
        const moovA = container('moov', [container('stbl', [stcoBox([34])])]);
        const moovB = container('moov', [container('stbl', [stcoBox([34])])]);
        const orig = Buffer.concat([ftyp, mdat, moovA, moovB]);
        assert(faststartBuffer(orig) === orig, 'T8: moov 複数は no-op');
    }

    // ── Test 9: 破損（box サイズがバッファ長を超える）→ 同一インスタンス ──
    {
        const bad = Buffer.alloc(16);
        bad.writeUInt32BE(9999, 0);           // 実際は 16 バイトしかない
        bad.write('moov', 4, 'ascii');
        assert(faststartBuffer(bad) === bad, 'T9: 破損 box は no-op');
    }

    // ── Test 10: mdat が moov より後ろ（moov, mdat, ... ではなく mdat が moov の後）→ no-op ──
    {
        // layout: ftyp, mdat(先), moov, mdat(後) → lastMdat が moov より後 ＝ 触らない
        const moov = container('moov', [container('stbl', [stcoBox([34])])]);
        const mdat2 = box('mdat', Buffer.alloc(20, 0xBB));
        const orig = Buffer.concat([ftyp, mdat, moov, mdat2]);
        assert(faststartBuffer(orig) === orig, 'T10: moov の後ろに mdat があると no-op');
    }

    // ── Test 11: 非 Buffer / 空 → そのまま返す（throw しない） ──
    {
        assert(faststartBuffer(null) === null, 'T11a: null は null');
        assert(faststartBuffer(Buffer.alloc(0)).length === 0, 'T11b: 空 Buffer は空');
        const notBuf = 'not a buffer';
        assert(faststartBuffer(notBuf) === notBuf, 'T11c: 非 Buffer はそのまま');
    }

    // ── Test 12: 出力の box 種別集合が入力と一致（取りこぼし無し） ──
    {
        const moov = container('moov', [container('stbl', [stcoBox([34])])]);
        const orig = Buffer.concat([ftyp, mdat, moov]);
        const out = faststartBuffer(orig);
        const inTypes = topBoxTypes(orig).sort().join(',');
        const outTypes = topBoxTypes(out).sort().join(',');
        assert(inTypes === outTypes, 'T12: box 種別集合が保存される');
    }

    console.log(`\nmp4-faststart self-check: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}
