// 🎬 7/9 #201/#202: リール共有UI（買い手向け）。カード（Homeカルーセル）・全画面プレーヤー（縦フィード・
//   販売中/アーカイブ2状態）・商品カードの🎬バッジ を1本化＝Home/生産者ページ/商品詳細で同じ描画。
//   CSS は toast.js / push-optin.js と同様に自己注入（style.css 非依存・どのページでも同一見た目）。
//   再生は progressive（ネットワークURL直挿し＝ブラウザのネイティブ Range/206）＋ video-cache.js の先読み。
//   ⚠ カルーセルのカードは静止サムネのみで動画を再生しない（reels-spec §3 節約構成＝一覧で動画を流さない）。
//   #209⑭（2026-07-17）: 全画面フィードは「タップ再生」→「ミュート自動再生」に変更（spec §4・TikTok/IG型）。
//     ・開いた1本／スワイプで来た1本を自動再生（muted）。画面タップ＝一時停止/再開。
//     ・ループはネイティブ loop でなく JS 制御（終端手前で頭に seek）＝継ぎ目の黒フレームを出さない。
//     ・次の1本だけ軽く先読み（2本先以上はしない／saveData・2g では先読みしない）。
//   #209⑦-3（2026-07-19）: 再生を「全DL待ち」から progressive へ（実機で黒いまま出てこない件の本丸）。
//     ・旧：video-cache がファイル全体を fetch→Blob 化してから src に渡していた＝4〜12MB を
//       落とし切るまで1フレームも出ない（弱電波では十数秒〜）。faststart にしても効かない。
//     ・新：端末キャッシュにあれば blobURL（先読み済み＝即再生・オフライン可）、無ければ
//       ネットワークURLを直接 src に渡してブラウザに Range/206 で頭から流させる。
//     ・トレードオフ＝初回視聴分は端末キャッシュに残らない（裏で全取得し直すと同じ動画を
//       2回落として egress が倍になるのでやらない）。端末キャッシュは「先読みした次の1本」と
//       「blobURL で見た2回目以降」で担保する＝spec §4 より「そもそも再生が始まらない」を優先。
//   #209⑦-4（2026-07-19）: 全画面の表示状態を4つに整理して排他にする（読み込み中／失敗／一時停止／再生中）。
//     ・旧実装は読み込み失敗でも▶を出していた＝「一時停止中」と見分けがつかず、失敗が伝わらなかった。
//       弱電波（＝本番のカンボジア）では失敗が普通に起きるので、伝わらない＝「壊れている」と受け取られる。
//     ・失敗時は poster の上に「読み込めませんでした・再試行」を出す（永久に黒／▶のまま放置しない）。
//
// 使い方（各画面が view model を組んで渡す）：
//   import { reelCardHtml, reelVideoBadge, openReelFeed } from '/js/reel-ui.js';
//   row.innerHTML = items.map((vm,i)=>reelCardHtml(vm,i,t)).join('');
//   row.addEventListener('click', e => { const c=e.target.closest('[data-reel-idx]');
//     if(c) openReelFeed(items, +c.dataset.reelIdx, { t, onAddToCart, onViewFish, onViewFarmer }); });
//
// view model（1リール）：
//   { videoUrl, thumbUrl, durationSec, postedAt,   // reel_videos 由来
//     listingId, farmerId,
//     farmerName, avatarUrl, ratingPct, ratingCount,
//     province, distanceKm,                         // province=表示用文字列 / distanceKm=number|null
//     fishName, sizeLabel, stockKg, gutIncluded, priceKhr,
//     isNew,          // カードの「新着」ピル
//     buyable }       // 販売中×在庫あり（配達圏内は無視・spec §7）＝全画面の販売中/アーカイブ分岐
//   ⚠ sizeLabel は「単位付きの完成した文字列」を呼び出し側で組んで渡すこと（例 '8 head/kg'・#209⑯）。
//     reel-ui 側では単位を足さない（呼び出し側が既に付けているので "8 head/kg head/kg" になるため）。
//     ※全画面だけサイズを出す＝カルーセルのカードは sizeLabel を描画しない（spec §8）。

import { getCachedImageUrl, asCachedImgAttrs } from '/js/image-cache.js';
import { loadVideoObjectUrl, getCachedVideoObjectUrl } from '/js/video-cache.js';
import { formatDuration, relativePostedText } from '/js/reel-utils.js';

// #209⑭-3: 先読みしてよい回線か。本番ターゲット＝カンボジアの弱電波なので、
//   データセーバー / 2g では「次の1本」の先読みを止め、いま見ている動画に帯域を残す。
function prefetchAllowed() {
    const c = (typeof navigator !== 'undefined')
        ? (navigator.connection || navigator.mozConnection || navigator.webkitConnection)
        : null;
    if (!c) return true;                       // 情報が無いブラウザ（iOS Safari 等）は許可
    if (c.saveData) return false;
    const et = String(c.effectiveType || '');
    return et !== 'slow-2g' && et !== '2g';
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtKhr(n) {
    const v = Math.round(Number(n) || 0);
    return v.toLocaleString('en-US');
}

let _styleInjected = false;
function ensureStyle() {
    if (_styleInjected) return;
    _styleInjected = true;
    const css = `
/* ── カルーセル カード ── */
.rui-card{flex:0 0 138px;height:240px;border-radius:14px;position:relative;overflow:hidden;
  background:linear-gradient(160deg,#1c3b4a,#0e2029);cursor:pointer;-webkit-tap-highlight-color:transparent}
.rui-card__thumb{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.rui-card__play{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:42px;height:42px;
  border-radius:50%;background:rgba(255,255,255,.28);display:flex;align-items:center;justify-content:center}
.rui-card__play::after{content:"";width:0;height:0;border-left:13px solid #fff;border-top:8px solid transparent;
  border-bottom:8px solid transparent;margin-left:3px}
.rui-card__dur{position:absolute;top:8px;right:8px;background:rgba(0,0,0,.55);color:#fff;font-size:10px;
  font-weight:700;padding:2px 6px;border-radius:7px}
.rui-card__new{position:absolute;top:8px;left:8px;background:#0B5FB0;color:#fff;font-size:9.5px;font-weight:800;
  padding:2px 7px;border-radius:7px;letter-spacing:.3px}
/* 生産者ポートフォリオ カードの「販売中」バッジ（#207⑫・青） */
.rui-card__sale{position:absolute;top:8px;left:8px;background:#0B5FB0;color:#fff;font-size:9.5px;font-weight:800;
  padding:2px 7px;border-radius:7px;letter-spacing:.3px}
.rui-card__ov{position:absolute;left:0;right:0;bottom:0;padding:22px 9px 9px;
  background:linear-gradient(transparent,rgba(0,0,0,.82));color:#fff}
.rui-card__rf{display:flex;align-items:center;gap:5px;font-size:10.5px;font-weight:700;margin-bottom:3px}
.rui-card__av{width:16px;height:16px;border-radius:50%;background:#6b8;flex:0 0 16px;object-fit:cover}
.rui-card__name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rui-card__fn{font-size:12.5px;font-weight:800;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rui-card__pp{font-size:13px;font-weight:800;color:#7FD4FF;margin-top:2px}
.rui-card__pp span{font-size:9px;font-weight:600;opacity:.9}

/* ── 商品カード 🎬バッジ ── */
.rui-vbadge{position:absolute;top:7px;left:7px;background:rgba(0,0,0,.6);color:#fff;font-size:9.5px;font-weight:700;
  padding:2px 6px;border-radius:6px;display:inline-flex;align-items:center;gap:3px;z-index:2}
.rui-vbadge .material-symbols-outlined{font-size:12px;line-height:1}

/* ── 全画面フィード ── */
.rui-overlay{position:fixed;inset:0;z-index:5000;background:#0b1a22}
.rui-track{height:100%;height:100dvh;overflow-y:scroll;scroll-snap-type:y mandatory;
  -webkit-overflow-scrolling:touch;scrollbar-width:none}
.rui-track::-webkit-scrollbar{display:none}
.rui-item{position:relative;height:100%;height:100dvh;scroll-snap-align:start;scroll-snap-stop:always;
  background:#0b1a22;overflow:hidden}
.rui-item__vidwrap{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
/* ⚠ #209（poster が効いていなかったバグ）: poster は DOM 上 video より前にあるのに、
   video が不透明な背景（旧 background:#0b1a22）で後から重なり poster を完全に覆っていた
   （＝#205④「タップ直後の黒画面を消す」が実機で効いていなかった真因）。
   → poster を z-index で video より上に敷き、video の背景は透明にする。
     poster は実フレームが出た時点で display:none にする（＝以後は video が見える）。 */
.rui-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:transparent;z-index:1}
.rui-poster{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#0b1a22;z-index:2}
.rui-item__play{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:66px;height:66px;
  border-radius:50%;background:rgba(255,255,255,.22);display:flex;align-items:center;justify-content:center;
  border:none;cursor:pointer;z-index:3}
.rui-item__play::after{content:"";width:0;height:0;border-left:22px solid #fff;border-top:13px solid transparent;
  border-bottom:13px solid transparent;margin-left:4px}
.rui-item__play[hidden]{display:none}
.rui-spin{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:44px;height:44px;
  border:3px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:rui-spin .8s linear infinite;z-index:3}
.rui-spin[hidden]{display:none}
@keyframes rui-spin{to{transform:translate(-50%,-50%) rotate(360deg)}}
/* 読み込み失敗（#209⑦-4）＝▶（一時停止）と見た目で区別する。poster の上に重ねる。
   ⚠ display:flex を指定するので [hidden] を明示上書きしないと UA 既定の display:none がカスケードで負ける
     （＝隠したはずのエラーが常時出る。既出の .rui-spin[hidden] / .rui-item__play[hidden] と同じ理由）。 */
/* ⚠ z-index は spin（3）でなく .rui-btm/.rui-top（4）より上に置く＝画面が低い端末（横向き等）で
   下部ブロックが画面中央まで届くと、その下敷きになって〔再試行〕がタップできなくなるため。
   失敗中は下の CTA を隠しても困らない（そもそも見るものが出ていない）。 */
.rui-err{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:5;max-width:80%;
  display:flex;flex-direction:column;align-items:center;gap:11px;padding:18px 22px;border-radius:14px;
  background:rgba(0,0,0,.55);color:#fff;text-align:center}
.rui-err[hidden]{display:none}
/* ⚠ アイコンは子孫セレクタで指定（#139E の再発防止＝単一クラスだとページ側の
   .material-symbols-outlined{font-size:..} と同詳細度でぶつかり巨大化しうる） */
.rui-err .rui-err__ic{font-size:30px;opacity:.85}
.rui-err__t{font-size:13.5px;font-weight:700;line-height:1.4}
.rui-err__btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:9px 16px;
  border-radius:10px;background:rgba(255,255,255,.16);border:1.5px solid rgba(255,255,255,.6);color:#fff;
  font-size:13px;font-weight:800;cursor:pointer;font-family:inherit}
.rui-err__btn .material-symbols-outlined{font-size:17px}
.rui-top{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;
  padding:calc(12px + env(safe-area-inset-top,0px)) 16px 12px;color:#fff;z-index:4}
.rui-top__bk{font-size:22px;line-height:1;background:none;border:none;color:#fff;cursor:pointer;padding:4px 8px;font-family:inherit}
.rui-top__right{display:flex;align-items:center;gap:10px}
.rui-top__dur{background:rgba(0,0,0,.5);font-size:11px;font-weight:700;padding:3px 9px;border-radius:8px}
/* 🔇 ミュートトグル（#205②・デフォルト無音・タップで音） */
.rui-top__mute{width:34px;height:34px;border-radius:50%;background:rgba(0,0,0,.45);border:none;color:#fff;
  display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;font-family:inherit}
.rui-top__mute .material-symbols-outlined{font-size:19px}
/* 進捗＝細い再生バー1本（#206⑤・ストーリーズ型セグメントは廃止）。
   位置＝〔👁 この魚を見る〕ボタンのすぐ上（#209⑤・2026-07-15 で画面上端→下端に変更。
   上端は ← と 🔇 に近くて見にくかった／TikTok・IG も進捗バーは下端が定番）。
   ⚠ absolute の bottom 固定にせず .rui-btm の中に「流し込む」＝販売中（CTAあり）と
     アーカイブ（CTAなし＝「販売されていません」）どちらでもボタン/注記の真上に来て破綻しない。 */
.rui-pbar{height:2px;border-radius:2px;background:rgba(255,255,255,.3);margin:14px 0 2px;overflow:hidden}
.rui-pbar i{display:block;height:100%;width:0;border-radius:2px;background:rgba(255,255,255,.95)}
.rui-btm{position:absolute;left:0;right:0;bottom:0;padding:44px 16px calc(18px + env(safe-area-inset-bottom,0px));
  background:linear-gradient(transparent,rgba(0,0,0,.88));color:#fff;z-index:4}
.rui-badge{position:absolute;top:calc(50px + env(safe-area-inset-top,0px));left:16px;font-size:11px;font-weight:800;
  padding:3px 10px;border-radius:9px;z-index:4}
.rui-badge--sale{background:#0B5FB0;color:#fff}
.rui-badge--arch{background:rgba(255,255,255,.18);color:#fff}
.rui-btm__rf{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;margin-bottom:8px;flex-wrap:wrap}
.rui-btm__rf.tap{cursor:pointer}
.rui-btm__av{width:30px;height:30px;border-radius:50%;background:#6b8;flex:0 0 30px;object-fit:cover}
.rui-btm__star{color:#FFC53D;font-weight:800;font-size:12px}
.rui-btm__loc{opacity:.7;font-weight:600}
.rui-btm__rn{font-size:20px;font-weight:800}
.rui-btm__rn .det{font-size:12px;opacity:.7;font-weight:600;margin-left:6px}
.rui-btm__rn.tap{cursor:pointer}
.rui-btm__meta{font-size:12.5px;opacity:.85;margin-top:3px}
.rui-btm__rp{font-size:24px;font-weight:800;color:#7FD4FF;margin-top:8px}
.rui-btm__rp span{font-size:13px;opacity:.9;font-weight:600}
.rui-btm__sold{display:inline-flex;align-items:center;gap:6px;background:rgba(255,255,255,.14);
  border:1px solid rgba(255,255,255,.28);color:#fff;font-size:12.5px;font-weight:700;padding:8px 12px;border-radius:10px;margin-top:10px}
.rui-btm__sold .material-symbols-outlined{font-size:16px}
.rui-btm__cta{display:flex;gap:10px;margin-top:14px}
.rui-btm__cta button{flex:1;text-align:center;padding:13px;border-radius:12px;font-size:14px;font-weight:800;
  border:none;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;justify-content:center;gap:6px}
.rui-btm__cta .pri{background:#0B5FB0;color:#fff}
.rui-btm__cta .sec{background:rgba(255,255,255,.16);color:#fff;border:1.5px solid rgba(255,255,255,.6)}
.rui-btm__cta .material-symbols-outlined{font-size:18px}
@media (prefers-reduced-motion: reduce){.rui-spin{animation-duration:2s}}`;
    const style = document.createElement('style');
    style.setAttribute('data-fl-reel', '');
    style.textContent = css;
    document.head.appendChild(style);
}

// ── カルーセル カード（Home 新着リール／生産者ポートフォリオ） ──
//   opts.hideFarmer=true（生産者ページ #207⑫）＝自ページなので農家名を出さず、代わりに買える動画へ青「販売中」バッジ。
export function reelCardHtml(vm, idx, t, opts = {}) {
    ensureStyle();
    const hideFarmer = !!opts.hideFarmer;
    const dur = vm.durationSec ? `<span class="rui-card__dur">${esc(formatDuration(vm.durationSec))}</span>` : '';
    const nw = (!hideFarmer && vm.isNew) ? `<span class="rui-card__new">${esc(t('reel.newBadge'))}</span>` : '';
    const sale = (hideFarmer && vm.buyable) ? `<span class="rui-card__sale">${esc(t('reel.onSale'))}</span>` : '';
    const thumb = vm.thumbUrl
        ? `<img class="rui-card__thumb" ${asCachedImgAttrs(vm.thumbUrl)} alt="">`
        : '';
    const av = vm.avatarUrl
        ? `<img class="rui-card__av" ${asCachedImgAttrs(vm.avatarUrl)} alt="">`
        : `<span class="rui-card__av"></span>`;
    const rf = hideFarmer
        ? ''
        : `<div class="rui-card__rf">${av}<span class="rui-card__name">${esc(vm.farmerName || '')}</span></div>`;
    return `<div class="rui-card" data-reel-idx="${idx}" role="button" tabindex="0" aria-label="${esc(vm.fishName || '')}">
      ${thumb}
      <div class="rui-card__play" aria-hidden="true"></div>
      ${nw}${sale}${dur}
      <div class="rui-card__ov">
        ${rf}
        <div class="rui-card__fn">${esc(vm.fishName || '')}</div>
        <div class="rui-card__pp">${esc(fmtKhr(vm.priceKhr))}<span> /kg</span></div>
      </div>
    </div>`;
}

// ── 商品カードの 🎬バッジ ── （呼び出し側が featured のとき画像コンテナ内に挿入）
export function reelVideoBadge(t) {
    ensureStyle();
    return `<span class="rui-vbadge"><span class="material-symbols-outlined">movie</span>${esc(t('reel.videoBadge'))}</span>`;
}

// ── 全画面フィード ──
export function openReelFeed(items, startIndex, opts = {}) {
    if (!Array.isArray(items) || !items.length) return;
    ensureStyle();
    const t = typeof opts.t === 'function' ? opts.t : (k => k);
    const start = Math.min(Math.max(0, startIndex | 0), items.length - 1);

    const ov = document.createElement('div');
    ov.className = 'rui-overlay';

    ov.innerHTML = `<div class="rui-track">${items.map((vm, i) => itemHtml(vm, i, t)).join('')}</div>`;
    document.body.appendChild(ov);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const track = ov.querySelector('.rui-track');
    const itemEls = [...ov.querySelectorAll('.rui-item')];

    // #205②: フィード全体で共有するミュート状態（デフォルト無音・タップで音）。
    const state = { muted: true };
    const applyMute = () => {
        itemEls.forEach(el => { const v = el.querySelector('.rui-video'); if (v) v.muted = state.muted; });
        ov.querySelectorAll('.rui-top__mute').forEach(b => {
            const ic = b.querySelector('.material-symbols-outlined');
            if (ic) ic.textContent = state.muted ? 'volume_off' : 'volume_up';
            b.setAttribute('aria-label', state.muted ? t('reel.unmute') : t('reel.mute'));
        });
    };

    const ctrls = [];   // アイテムごとの制御（bindItem が返す）。close より先に宣言＝TDZ を避ける
    let io = null;
    // ⚠ #209: 閉じた後は絶対に再生しない。video-cache の fetch は中断できない（AbortSignal なし）ため、
    //   読み込み中に閉じると await 解決後に src が貼り直されて「画面に無い動画が鳴り続ける」
    //   （🔊のまま閉じると音が止められない＝リロードするしかない）。閉じたことを shouldPlay に伝える。
    let closed = false;
    const close = () => {
        closed = true;
        activeIdx = -1;     // ＝shouldPlay の二重防御（アクティブだったアイテムも再生させない）
        ctrls.forEach(c => { if (c) c.destroy(); });
        if (io) { io.disconnect(); io = null; }
        document.body.style.overflow = prevOverflow;
        ov.remove();
        window.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);

    // 各アイテムのバインド（自動再生・タップ一時停止・ボタン・ミュート・再生バー）
    itemEls.forEach((el, i) => {
        ctrls[i] = bindItem(el, items[i], {
            t, close, opts, state, applyMute,
            // #209⑭-3: いま見ている動画の再生が「始まってから」次を先読みする
            //   （読み込みと同時に走らせると本編とダウンロード帯域を奪い合う＝弱電波で本末転倒）。
            onPlaying: () => prefetchNext(i),
            // 読み込み待ちの間にスワイプで別の魚へ移っていないか／既に閉じていないか（＝画面外で鳴らさない）
            shouldPlay: () => !closed && activeIdx === i,
            // タップされた1本をアクティブにする（IO が無い環境でもここで確実に切り替わる）
            requestActive: () => setActive(i)
        });
    });

    // #209⑭-1: 画面内（60%超）に入った1本だけを自動再生。同時に2本以上は絶対に鳴らさない。
    //   切り替わったとき true を返す（＝タップ経路が二重に autoplay しないための合図）。
    let activeIdx = -1;
    function setActive(idx) {
        if (idx < 0 || idx >= ctrls.length || idx === activeIdx) return false;
        activeIdx = idx;
        ctrls.forEach((c, i) => { if (i !== idx && c) c.pause(); });
        if (ctrls[idx]) ctrls[idx].autoplay();
        return true;
    }
    // #209⑭-3: 先読みは「次の1本」だけ（2本先以上はしない＝見ずにスキップした分の通信量を最小に）。
    function prefetchNext(i) {
        if (!prefetchAllowed()) return;
        const next = ctrls[i + 1];
        if (next) next.prefetch();
    }

    // 起点にスクロール（レイアウト確定後）→ そのまま起点を再生開始。
    // ⚠ scrollTop を先に確定させてから observe する＝IO の初回コールバックがスクロール前の
    //   先頭アイテムを「表示中」と誤検知して、見ない動画をダウンロードするのを防ぐ（通信量＝コスト）。
    requestAnimationFrame(() => {
        const target = itemEls[start];
        if (target) track.scrollTop = target.offsetTop;
        setActive(start);

        if ('IntersectionObserver' in window) {
            io = new IntersectionObserver((entries) => {
                entries.forEach(en => {
                    if (en.isIntersecting && en.intersectionRatio > 0.6) {
                        setActive(itemEls.indexOf(en.target));
                    }
                });
            }, { root: track, threshold: [0, 0.6, 1] });
            itemEls.forEach(el => io.observe(el));
        }
    });

    return close;
}

function itemHtml(vm, i, t) {
    const rating = vm.ratingCount > 0
        ? `<span class="rui-btm__star">★${Math.round(vm.ratingPct || 0)}%</span>`
        : `<span class="rui-btm__star">${esc(t('fishlist.newFarmer'))}</span>`;
    const distTxt = (vm.distanceKm != null)
        ? `${esc(vm.province || '')} ${Number(vm.distanceKm).toFixed(1)}km`
        : esc(vm.province || '');
    const av = vm.avatarUrl ? `<img class="rui-btm__av" src="${esc(getCachedImageUrl(vm.avatarUrl))}" alt="">` : `<span class="rui-btm__av"></span>`;
    const dur = vm.durationSec ? `<span class="rui-top__dur">${esc(formatDuration(vm.durationSec))}</span>` : '';
    const rel = relativePostedText(vm.postedAt, t);

    // #209⑤: 再生バーは下部ブロックの中＝主アクション（CTA／販売されていません注記）のすぐ上に置く。
    const pbar = `<div class="rui-pbar"><i></i></div>`;

    let badge, meta, priceCta;
    if (vm.buyable) {
        badge = `<span class="rui-badge rui-badge--sale">${esc(t('reel.onSale'))}</span>`;
        const stock = `${esc(t('reel.stockKg', { kg: Math.round(vm.stockKg || 0) }))}`;
        const gut = vm.gutIncluded ? ` ・ ${esc(t('reel.gutIncluded'))}` : '';
        meta = `<div class="rui-btm__meta">${stock}${gut} ・ ${esc(t('reel.postedAgo', { rel }))}</div>`;
        // #206⑧: 商品詳細への入口は〔👁 この魚を見る〕1本のみ（詳細›・カート・今すぐ注文は置かない）。
        priceCta = `<div class="rui-btm__rp">${esc(fmtKhr(vm.priceKhr))} <span>KHR/kg</span></div>
          ${pbar}
          <div class="rui-btm__cta">
            <button type="button" class="pri" data-act="view" style="flex:1"><span class="material-symbols-outlined">visibility</span>${esc(t('reel.viewFish'))}</button>
          </div>`;
    } else {
        badge = `<span class="rui-badge rui-badge--arch">${esc(t('reel.archived'))}</span>`;
        meta = `<div class="rui-btm__meta">${esc(t('reel.postedAgo', { rel }))}</div>`;
        priceCta = `${pbar}<div class="rui-btm__sold"><span class="material-symbols-outlined">block</span>${esc(t('reel.soldOut'))}</div>`;
    }

    // 農家名の「距離 ›」→生産者ページ は残す（#206⑧）。魚名の「詳細›」は削除（下部ボタンに一本化）。
    const rfTap = vm.buyable ? ' tap' : '';
    const chevF = vm.buyable ? ' <span style="opacity:.7">›</span>' : '';
    const sizePart = vm.sizeLabel ? `（${esc(vm.sizeLabel)}）` : '';

    const poster = vm.thumbUrl ? `<img class="rui-poster" src="${esc(getCachedImageUrl(vm.thumbUrl))}" alt="">` : '';

    // ⚠ #209⑭-2: loop 属性は付けない＝ネイティブループの継ぎ目で黒フレームが1枚出る（iOS Safari 既知）。
    //   代わりに JS で終端の手前に頭へ seek する（bindItem）。loop を残すと二重制御になり ended も来ない。
    // ⚠ #209⑭-1: ▶ は初期非表示（自動再生するので）。出すのは「一時停止中」だけ。
    // ⚠ #209⑦-4: 読み込み失敗は▶でなく専用の .rui-err（読み込めませんでした・再試行）で出す＝
    //   ▶に兼ねさせると「一時停止中」と区別がつかず、失敗したことがユーザーに伝わらない。
    //   4状態は排他（読み込み中＝spin／失敗＝err／一時停止＝play／再生中＝どれも出さない）＝bindItem の setStatus。
    return `<section class="rui-item" data-idx="${i}">
      <div class="rui-item__vidwrap">
        ${poster}
        <video class="rui-video" muted playsinline preload="none" webkit-playsinline></video>
        <button type="button" class="rui-item__play" aria-label="${esc(t('reel.play') || 'play')}" hidden></button>
        <div class="rui-spin" hidden></div>
        <div class="rui-err" role="alert" hidden>
          <span class="material-symbols-outlined rui-err__ic" aria-hidden="true">wifi_off</span>
          <span class="rui-err__t">${esc(t('reel.loadFailed'))}</span>
          <button type="button" class="rui-err__btn" data-act="retry"><span class="material-symbols-outlined">refresh</span>${esc(t('reel.retry'))}</button>
        </div>
      </div>
      <div class="rui-top">
        <button type="button" class="rui-top__bk" data-act="back" aria-label="back">←</button>
        <span class="rui-top__right">
          <button type="button" class="rui-top__mute" data-act="mute" aria-label="${esc(t('reel.unmute'))}"><span class="material-symbols-outlined">volume_off</span></button>
          ${dur}
        </span>
      </div>
      ${badge}
      <div class="rui-btm">
        <div class="rui-btm__rf${rfTap}" data-act="${vm.buyable ? 'farmer' : ''}">${av}<span>${esc(vm.farmerName || '')}</span>${rating} <span class="rui-btm__loc">・ ${distTxt}${chevF}</span></div>
        <div class="rui-btm__rn">${esc(vm.fishName || '')}${sizePart}</div>
        ${meta}
        ${priceCta}
      </div>
    </section>`;
}

// 終端の何秒手前で頭に戻すか（#209⑭-2）。小さすぎると ended に到達して黒が出る／
// 大きすぎると末尾が切れる。rAF（60fps＝約0.016秒毎）で見張るので 0.05 秒で間に合う。
const LOOP_EPSILON = 0.05;

function bindItem(el, vm, ctx) {
    const { close, opts, state, applyMute, onPlaying, shouldPlay, requestActive } = ctx;
    const video = el.querySelector('.rui-video');
    const playBtn = el.querySelector('.rui-item__play');
    const spin = el.querySelector('.rui-spin');
    const errBox = el.querySelector('.rui-err');
    const poster = el.querySelector('.rui-poster');
    const bar = el.querySelector('.rui-pbar > i');

    let loadPromise = null;    // 読み込み中の Promise（同じ動画を二重に取りに行かない）
    let prefetched = false;    // 先読み済み（同じ動画を二重に先読みしない・#209⑭-3）
    let posterHidden = false;
    let destroyed = false;     // フィードを閉じた（＝この要素はもう DOM に無い）。src の貼り直しも再生もしない

    // ── #209⑦-4: 表示状態は必ず排他にする（＝失敗表示と▶が同時に出ない） ──
    //   'loading' 読み込み中（poster＋スピナー）／'error' 失敗（poster＋読み込めませんでした・再試行）／
    //   'paused' 一時停止中（poster or 動画＋▶）／'none' 再生中・遷移中（何も出さない）。
    //   ⚠ 個別に hidden を触ると「スピナーの上に▶」「失敗表示の上に▶」のような取り違えが起きるので
    //     状態の変更は必ずこの1関数を通す。
    const setStatus = (s) => {
        spin.hidden = (s !== 'loading');
        if (errBox) errBox.hidden = (s !== 'error');
        playBtn.hidden = (s !== 'paused');
    };

    // ── poster（動画の1コマ）を実フレームが出るまで敷く（#205④・黒画面を出さない） ──
    //   一度隠したら二度と戻さない＝一時停止/再開のたびにチラつかせないため。
    const hidePoster = () => {
        if (posterHidden || !poster) return;
        posterHidden = true;
        poster.style.display = 'none';
    };

    // ── 細い再生バー1本（#206⑤） ──
    const updateBar = () => {
        if (!bar) return;
        const d = video.duration;
        bar.style.width = (isFinite(d) && d > 0)
            ? Math.min(100, (video.currentTime / d) * 100) + '%'
            : '0%';
    };

    // ── 再生中だけ rAF で見張る：①再生バー更新 ②終端の手前で頭に seek（ループの黒フラッシュ回避） ──
    //   ⚠ timeupdate は 4回/秒 程度でしか来ず「残り0.05秒」を捉えられない＝rAF で見る（#209⑭-2）。
    let rafId = 0;
    const tick = () => {
        rafId = 0;
        if (video.paused || video.ended) return;
        updateBar();
        const d = video.duration;
        // duration が 0 / NaN / Infinity（ライブ・メタデータ未取得）なら seek しない＝無限ループ・ゼロ除算のガード
        if (isFinite(d) && d > LOOP_EPSILON * 2 && video.currentTime >= d - LOOP_EPSILON) {
            try { video.currentTime = 0; } catch (e) { /* seek 不可なら下の ended フォールバックに任せる */ }
        }
        rafId = requestAnimationFrame(tick);
    };
    const startTick = () => { if (!rafId) rafId = requestAnimationFrame(tick); };
    const stopTick = () => { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } };

    // ── 動画データの用意（#209⑦-3: 「全DL待ち」→ progressive） ──
    //   (a) 端末キャッシュにあれば blobURL を使う＝先読み済みの次の1本は即再生・オフラインでも動く。
    //   (b) 無ければネットワークURLを直接 src に渡す＝ブラウザのネイティブ Range/206 で
    //       先頭が届いた時点から再生が始まる（faststart＝moov 先頭 が効くのはこの経路）。
    //   旧実装は (b) が無く、必ず video-cache で全体を fetch→Blob 化してから src に渡していた＝
    //   4〜12MB を落とし切るまで poster のまま＝実機（iPhone・モバイル回線）で「黒いまま出てこない」の元凶。
    //   ⚠ (b) で流した分をあとから裏で全取得してキャッシュに入れる、はしない＝同じ動画を2回落とす
    //     ことになり egress（＝コスト）が倍になる。初回視聴分が端末に残らないのは承知のトレードオフ。
    //   ⚠ 読み込み中に呼ばれたら「同じ Promise を返して待たせる」＝二重取得しない。
    //     ここで false を返して打ち切ると、読み込み中にスワイプで離れて戻ってきたときに
    //     ロード完了しても誰も再生せず、ポスターのまま止まって見える（⑦の「真っ黒で放置」）。
    const ensureSrc = () => {
        if (video.dataset.loaded === '1') return Promise.resolve(true);
        if (loadPromise) return loadPromise;
        // URL が無い＝データ不整合。放置すると 'loading' のままスピナーが回り続けるので失敗として出す。
        if (!vm.videoUrl) { setStatus('error'); return Promise.resolve(false); }
        setStatus('loading');   // 状態＝読み込み中（poster＋スピナー・前回の失敗表示はここで必ず消える）
        loadPromise = (async () => {
            try {
                // (a) キャッシュ照会のみ（ネットワークには行かない）。先読み中なら video-cache 側が相乗りする。
                let cachedUrl = null;
                try {
                    cachedUrl = await getCachedVideoObjectUrl(vm.videoUrl);
                } catch (e) {
                    cachedUrl = null;   // 先読みが失敗していた場合も (b) で素直に取り直す
                }
                // ⚠ 待っている間にフィードを閉じられた場合、ここで src を貼ると destroy() が消したはずの
                //   動画が復活して「見えないまま再生」される（fetch は中断できないので必ずここで見る）。
                if (destroyed) return false;
                video.src = cachedUrl || vm.videoUrl;   // (b) 無ければネットワークURL直挿し
                // preload="none" なので明示 load()＝再試行（同じURLの貼り直し）でも確実に読み直させる。
                video.load();
                video.dataset.loaded = '1';
                // ⚠ ここでは 'none'（＝何も出さない）。progressive はまだ1フレームも無いので、
                //   スピナーは play/waiting イベント側で readyState を見て出し直す（下のリスナー）。
                //   ネットワーク失敗も throw でなく video の 'error' イベントで来る＝そこで setStatus('error')。
                setStatus('none');
                return true;
            } catch (e) {
                // 状態＝失敗（poster＋「読み込めませんでした・再試行」）。#209⑦-4 で▶から専用表示に変更＝
                // ▶だと「一時停止中」と区別がつかず、失敗したことがユーザーに伝わらなかった。
                if (!destroyed) setStatus('error');
                return false;
            } finally {
                loadPromise = null;             // 失敗後にリトライできるよう必ず解放
            }
        })();
        return loadPromise;
    };

    // video.play() は古い実装だと Promise を返さない＝.catch で落ちないように包む
    const playSafe = () => {
        try { return Promise.resolve(video.play()); } catch (e) { return Promise.reject(e); }
    };

    // ── #209⑭-1: ミュート自動再生（表示中の1本だけ・IO から呼ばれる） ──
    const autoplay = async () => {
        const ok = await ensureSrc();
        if (!ok || destroyed) return;
        // 読み込みを待っている間に別の魚へスワイプされていたら再生しない（画面外で鳴らさない・同時再生も防ぐ）
        if (typeof shouldPlay === 'function' && !shouldPlay()) return;
        // 再訪（読込済み）で▶が一瞬見えないように先に消す。
        // ⚠ #209⑦-3: progressive の初回はまだデータが無い（readyState 0）＝スピナーのままにする。
        //   ここで 'none' にすると poster だけが出て「無反応」に見える（＝⑦の症状そのもの）。
        setStatus(video.readyState >= 3 ? 'none' : 'loading');   // 3 = HAVE_FUTURE_DATA
        video.muted = state.muted;              // #205②: 共有ミュート状態（デフォルト無音）
        try {
            await playSafe();
        } catch (err) {
            // ⚠ AbortError＝pause()/load() で中断された（＝スワイプで別の魚へ移った・閉じた など意図した停止）。
            //   自動再生ポリシーの拒否ではないので、ここで無音に落としたり再生し直したりしてはいけない
            //   （画面外の動画が鳴り出す＝同時2本再生／ユーザーの🔊設定が勝手に🔇へ巻き戻る）。
            //   停止時の表示は 'pause' イベント側で setStatus 済み。
            if (err && err.name === 'AbortError') return;
            // ⚠ ブラウザの自動再生ポリシー：音ありの自動再生はユーザー操作起点でないと拒否される
            //   （＝🔊のままスワイプすると次の動画が「無音」でなく「再生されない」）。
            //   → フィード全体を無音に戻して再生し直す（アイコンも 🔇 に同期＝表示と実態を食い違わせない）。
            if (!video.muted) {
                state.muted = true;
                if (typeof applyMute === 'function') applyMute();
                video.muted = true;
                // ⚠ 待っている間にスワイプで離れた／閉じられた場合は鳴らさない（初回と同じガードを再確認）。
                if (destroyed || (typeof shouldPlay === 'function' && !shouldPlay())) return;
                try { await playSafe(); return; } catch (e2) { /* それでも駄目なら▶に落とす */ }
            }
            // ⚠ 読み込み自体が失敗していたら（progressive では video.error が入る）ここで▶に上書きしない。
            //   'error' リスナーが既に setStatus('error')＝「読み込めませんでした・再試行」を出しており、
            //   HTML仕様上 error イベントの方が play() の reject より先に来るため、後勝ちで▶に潰れてしまう。
            //   ＝弱電波で最も起きる失敗が「一時停止」に見え、⑦-4 の失敗表示が主経路で出なくなる。
            //   自動再生ポリシー拒否（NotAllowedError）では video.error は null なので▶のままで正しい。
            if (video.error) return;
            // ⚠ ここは「読み込みは成功したが自動再生が拒否された」＝失敗ではなく一時停止（▶＝タップ待ち）。
            //   読み込み失敗（.rui-err）と混同しない＝ユーザーの取るべき行動が違う（タップ vs 再試行）。
            setStatus('paused');
        }
    };

    const pause = () => { try { video.pause(); } catch (e) {} };

    // ── #209⑭-3: 次の1本の軽い先読み（本編の再生が始まってから・呼び出しは openReelFeed 側） ──
    //   ⚠ #209⑦-3: 先読みだけは従来どおり loadVideoObjectUrl＝全取得→IDB のまま。
    //     見ていない1本を裏で丸ごと落として端末に置く役目で、これがあるから
    //     スワイプした瞬間に ensureSrc の (a) が当たって即再生できる（＝カクつき防止）。
    //   ⚠ dataset.loaded==='1'（＝いま progressive で流している本人）は弾く＝同じ動画の二重取得防止。
    const prefetch = () => {
        if (prefetched || loadPromise || video.dataset.loaded === '1') return;
        prefetched = true;
        // 失敗は握りつぶす＝先読みはあくまでオマケで、いま見ている動画の再生を絶対に妨げない
        loadVideoObjectUrl(vm.videoUrl).catch(() => {});
    };

    // ── #209⑦-4: 〔再試行〕＝もう一度読み込んで再生する（何度でも押せる） ──
    //   ⚠ 閉じた後（destroyed）は走らせない＝画面に無い動画を取りに行かない・鳴らさない
    //     （video-cache の fetch は中断できないので、入口で止めるのが唯一の防御）。
    //   ・ensureSrc は失敗時に loadPromise を必ず解放し、video-cache も失敗を握らない（inflight を finally で削除）
    //     ＝再試行のたびに素直に取り直せる。
    const retry = () => {
        if (destroyed) return;
        setStatus('loading');   // 押した瞬間にスピナーへ戻す＝無反応に見せない（実際の遷移は ensureSrc）
        // 押した1本をアクティブにする。切り替わった場合は setActive 側が autoplay 済み＝ここで二重に呼ばない。
        if (typeof requestActive === 'function' && requestActive()) return;
        autoplay();
    };

    // ── 画面タップ＝一時停止／再開（読み込み前・失敗後はリトライ） ──
    //   ⚠ poster が video の上に乗る（z-index）ので、video でなくラッパーで受ける。
    const toggle = () => {
        // タップした1本をアクティブにする。切り替わった場合は setActive 側が autoplay 済み＝ここで二重に呼ばない。
        if (typeof requestActive === 'function' && requestActive()) return;
        if (video.dataset.loaded !== '1') { retry(); return; }   // 未読込／失敗＝画面タップでも再試行できる
        if (video.paused) {
            video.muted = state.muted;
            // ⚠ 読み込み失敗（video.error）なら 'error' リスナーの表示を▶で上書きしない（autoplay 側と同じ理由）。
            playSafe().catch(() => { if (!video.error) setStatus('paused'); });
        } else {
            video.pause();
        }
    };
    const vidwrap = el.querySelector('.rui-item__vidwrap');
    if (vidwrap) vidwrap.addEventListener('click', toggle);
    playBtn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });

    // ⚠ #209⑦-4: 読み込み前／失敗中の pause で▶を出さない＝失敗表示を▶で上書きしない（状態は排他）。
    video.addEventListener('pause', () => {
        if (video.dataset.loaded === '1' && !destroyed) setStatus('paused');
        stopTick();
    });
    // ⚠ #209⑦-3: 'play' は「再生を要求した」時点で、まだ1フレームも無いことがある
    //   （progressive＝ネットワークURL直挿しの初回は特に）。データが足りていなければスピナーを
    //   出したままにして、実際に絵が出る 'playing' で消す＝「黒いまま無反応」に見せない。
    video.addEventListener('play', () => {
        setStatus(video.readyState >= 3 ? 'none' : 'loading');   // 3 = HAVE_FUTURE_DATA
        startTick();
    });
    // ⚠ #209⑦-3: 再生中にバッファが尽きた（弱電波では普通に起きる）＝スピナーに戻す。
    //   readyState を見るのは、ループの頭出し seek 直後など「データはあるのに waiting が来る」場合に
    //   スピナーをチラつかせないため。一時停止（▶）／失敗（再試行）とは setStatus で排他。
    video.addEventListener('waiting', () => {
        if (destroyed || video.paused || video.readyState >= 3) return;
        setStatus('loading');
    });
    // ⚠ #209⑦-4: src は貼れたのに再生できない場合（デコード失敗／メモリLRUで blobURL が revoke された等）も
    //   「読み込み失敗」として扱う＝▶に落とすと一時停止と区別がつかない。
    //   dataset.loaded を落として、再試行で取り直せるようにする。
    // ⚠ #209⑦-3: progressive（ネットワークURL直挿し）では通信断もここに来る＝
    //   もはや ensureSrc の catch でなく、このイベントが失敗検出の主経路。
    //   〔再試行〕→ ensureSrc（loadPromise 解放済み・dataset.loaded 空）で素直にやり直せる。
    video.addEventListener('error', () => {
        if (destroyed || !video.src) return;   // destroy() の removeAttribute('src') 由来のエラーは無視
        video.dataset.loaded = '';
        stopTick();
        setStatus('error');
    });
    video.addEventListener('playing', () => {
        // ⚠ #209⑦-3: ここが「実際に絵が出た」＝スピナーを必ず消す唯一の出口。
        //   'play'（要求時点）は readyState を見て 'loading' を出したままにすることがあるので、
        //   これが無いと再生中ずっとスピナーが乗り続ける（バッファ復帰時も同じ）。
        if (!destroyed) setStatus('none');
        // requestVideoFrameCallback があれば「実フレームが1枚出た」タイミングで poster を外す＝継ぎ目なし
        if (typeof video.requestVideoFrameCallback === 'function') {
            try { video.requestVideoFrameCallback(() => hidePoster()); } catch (e) { hidePoster(); }
        } else {
            hidePoster();
        }
        startTick();
        if (typeof onPlaying === 'function') onPlaying();
    });
    // フォールバック：rAF が間に合わず ended まで行った場合も頭から続ける（loop 属性は付けていない）
    //   ⚠ 表示中の1本でなければ再開しない（画面外の動画が勝手に鳴り出さないように）
    video.addEventListener('ended', () => {
        if (typeof shouldPlay === 'function' && !shouldPlay()) return;
        try { video.currentTime = 0; playSafe().catch(() => {}); } catch (e) {}
    });
    // rAF が動かない環境（低電力モード等）でも再生バーが止まって見えないように
    video.addEventListener('timeupdate', updateBar);

    el.querySelectorAll('[data-act]').forEach(node => {
        const act = node.dataset.act;
        if (!act) return;
        node.addEventListener('click', (e) => {
            e.stopPropagation();
            if (act === 'back') { close(); return; }
            if (act === 'retry') { retry(); return; }   // #209⑦-4: 読み込み失敗からの再読み込み
            if (act === 'mute') { state.muted = !state.muted; if (typeof applyMute === 'function') applyMute(); return; }
            if (act === 'view') {
                if (typeof opts.onViewFish === 'function') opts.onViewFish(vm.listingId, vm);
                else location.href = `/pages/restaurant/order.html?id=${encodeURIComponent(vm.listingId)}`;
            } else if (act === 'cart') {
                if (typeof opts.onAddToCart === 'function') opts.onAddToCart(vm);
                else location.href = `/pages/restaurant/order.html?id=${encodeURIComponent(vm.listingId)}`;
            } else if (act === 'farmer') {
                if (typeof opts.onViewFarmer === 'function') opts.onViewFarmer(vm.farmerId, vm);
                else location.href = `/pages/restaurant/farmer.html?id=${encodeURIComponent(vm.farmerId)}`;
            }
        });
    });

    // openReelFeed 側の自動再生ドライバから操作するための制御ハンドル（#209⑭）
    return {
        autoplay,
        pause,
        prefetch,
        destroy: () => {
            destroyed = true;   // ← stopTick より先に立てる（読み込み中の await が解決しても復活させない）
            stopTick();
            try { video.pause(); video.removeAttribute('src'); video.load(); } catch (e) {}
        }
    };
}
