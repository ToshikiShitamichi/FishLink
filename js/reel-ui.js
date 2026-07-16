// 🎬 7/9 #201/#202: リール共有UI（買い手向け）。カード（Homeカルーセル）・全画面プレーヤー（縦フィード・
//   販売中/アーカイブ2状態）・商品カードの🎬バッジ を1本化＝Home/生産者ページ/商品詳細で同じ描画。
//   CSS は toast.js / push-optin.js と同様に自己注入（style.css 非依存・どのページでも同一見た目）。
//   再生は video-cache.js（Blob全取得＝206/Range回避）＋タップ再生・先読みなし（reels-spec §3/§4 節約構成）。
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

import { getCachedImageUrl, asCachedImgAttrs } from '/js/image-cache.js';
import { loadVideoObjectUrl } from '/js/video-cache.js';
import { formatDuration, relativePostedText } from '/js/reel-utils.js';

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
.rui-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#0b1a22}
.rui-poster{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#0b1a22}
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
.rui-top{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;
  padding:calc(12px + env(safe-area-inset-top,0px)) 16px 12px;color:#fff;z-index:4}
.rui-top__bk{font-size:22px;line-height:1;background:none;border:none;color:#fff;cursor:pointer;padding:4px 8px;font-family:inherit}
.rui-top__right{display:flex;align-items:center;gap:10px}
.rui-top__dur{background:rgba(0,0,0,.5);font-size:11px;font-weight:700;padding:3px 9px;border-radius:8px}
/* 🔇 ミュートトグル（#205②・デフォルト無音・タップで音） */
.rui-top__mute{width:34px;height:34px;border-radius:50%;background:rgba(0,0,0,.45);border:none;color:#fff;
  display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;font-family:inherit}
.rui-top__mute .material-symbols-outlined{font-size:19px}
/* 進捗＝細い再生バー1本（#206⑤・ストーリーズ型セグメントは廃止） */
.rui-pbar{position:absolute;top:0;left:0;right:0;height:2px;background:rgba(255,255,255,.28);z-index:5}
.rui-pbar i{display:block;height:100%;width:0;background:rgba(255,255,255,.9)}
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

    const close = () => {
        itemEls.forEach(el => { const v = el.querySelector('.rui-video'); if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {} } });
        document.body.style.overflow = prevOverflow;
        ov.remove();
        window.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);

    // 各アイテムのバインド（タップ再生・ボタン・ミュート・再生バー）
    itemEls.forEach((el, i) => bindItem(el, items[i], { t, close, opts, state, applyMute }));

    // 起点にスクロール（レイアウト確定後）
    requestAnimationFrame(() => {
        const target = itemEls[start];
        if (target) track.scrollTop = target.offsetTop;
    });

    // 画面外の動画を停止（先読みはしない・#206⑤でセグメントドットは廃止＝停止処理のみ）
    if ('IntersectionObserver' in window) {
        const io = new IntersectionObserver((entries) => {
            entries.forEach(en => {
                if (en.isIntersecting && en.intersectionRatio > 0.6) return;
                const el = en.target;
                const v = el.querySelector('.rui-video');
                if (v && !v.paused) { v.pause(); const pb = el.querySelector('.rui-item__play'); if (pb && v.dataset.loaded === '1') pb.hidden = false; }
            });
        }, { root: track, threshold: [0, 0.6, 1] });
        itemEls.forEach(el => io.observe(el));
    }
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

    let badge, meta, priceCta;
    if (vm.buyable) {
        badge = `<span class="rui-badge rui-badge--sale">${esc(t('reel.onSale'))}</span>`;
        const stock = `${esc(t('reel.stockKg', { kg: Math.round(vm.stockKg || 0) }))}`;
        const gut = vm.gutIncluded ? ` ・ ${esc(t('reel.gutIncluded'))}` : '';
        meta = `<div class="rui-btm__meta">${stock}${gut} ・ ${esc(t('reel.postedAgo', { rel }))}</div>`;
        // #206⑧: 商品詳細への入口は〔👁 この魚を見る〕1本のみ（詳細›・カート・今すぐ注文は置かない）。
        priceCta = `<div class="rui-btm__rp">${esc(fmtKhr(vm.priceKhr))} <span>KHR/kg</span></div>
          <div class="rui-btm__cta">
            <button type="button" class="pri" data-act="view" style="flex:1"><span class="material-symbols-outlined">visibility</span>${esc(t('reel.viewFish'))}</button>
          </div>`;
    } else {
        badge = `<span class="rui-badge rui-badge--arch">${esc(t('reel.archived'))}</span>`;
        meta = `<div class="rui-btm__meta">${esc(t('reel.postedAgo', { rel }))}</div>`;
        priceCta = `<div class="rui-btm__sold"><span class="material-symbols-outlined">block</span>${esc(t('reel.soldOut'))}</div>`;
    }

    // 農家名の「距離 ›」→生産者ページ は残す（#206⑧）。魚名の「詳細›」は削除（下部ボタンに一本化）。
    const rfTap = vm.buyable ? ' tap' : '';
    const chevF = vm.buyable ? ' <span style="opacity:.7">›</span>' : '';
    const sizePart = vm.sizeLabel ? `（${esc(vm.sizeLabel)}）` : '';

    const poster = vm.thumbUrl ? `<img class="rui-poster" src="${esc(getCachedImageUrl(vm.thumbUrl))}" alt="">` : '';

    return `<section class="rui-item" data-idx="${i}">
      <div class="rui-item__vidwrap">
        ${poster}
        <video class="rui-video" muted playsinline preload="none" loop webkit-playsinline></video>
        <button type="button" class="rui-item__play" aria-label="${esc(t('reel.play') || 'play')}"></button>
        <div class="rui-spin" hidden></div>
      </div>
      <div class="rui-pbar"><i></i></div>
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

function bindItem(el, vm, ctx) {
    const { close, opts, state, applyMute } = ctx;
    const video = el.querySelector('.rui-video');
    const playBtn = el.querySelector('.rui-item__play');
    const spin = el.querySelector('.rui-spin');
    const poster = el.querySelector('.rui-poster');
    const bar = el.querySelector('.rui-pbar > i');

    const play = async () => {
        if (video.dataset.loaded === '1') {
            if (video.paused) { video.muted = state.muted; playBtn.hidden = true; try { await video.play(); } catch (e) {} }
            else { video.pause(); playBtn.hidden = false; }
            return;
        }
        playBtn.hidden = true; spin.hidden = false;
        try {
            const blobUrl = await loadVideoObjectUrl(vm.videoUrl);
            video.src = blobUrl;
            video.dataset.loaded = '1';
            video.muted = state.muted;       // #205②: 共有ミュート状態を反映（デフォルト無音）
            await video.play();
            if (poster) poster.style.display = 'none';
        } catch (e) {
            playBtn.hidden = false;   // ＝リトライ導線（もう一度タップ）
        } finally {
            spin.hidden = true;
        }
    };
    playBtn.addEventListener('click', (e) => { e.stopPropagation(); play(); });
    video.addEventListener('click', () => play());
    video.addEventListener('pause', () => { if (video.dataset.loaded === '1') playBtn.hidden = false; });
    video.addEventListener('play', () => { playBtn.hidden = true; });
    // #206⑤: 細い再生バー1本＝再生位置を反映（loop で currentTime が戻れば自動リセット）
    video.addEventListener('timeupdate', () => {
        if (bar && video.duration) bar.style.width = Math.min(100, (video.currentTime / video.duration) * 100) + '%';
    });

    el.querySelectorAll('[data-act]').forEach(node => {
        const act = node.dataset.act;
        if (!act) return;
        node.addEventListener('click', (e) => {
            e.stopPropagation();
            if (act === 'back') { close(); return; }
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
}
