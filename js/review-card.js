// 6/10 #137/#138: レビューコメントの共通描画。
// レストランページ(pages/farmer/restaurant.html)と生産者ページ(pages/restaurant/farmer.html)で共用。
// 「良かった/残念だった」は線画スマイリー（sentiment_satisfied / sentiment_dissatisfied）＝レビュー入力 #128 と同一アイコン。
//   絵文字（👍👎）は使わない（端末差・DS不一致のため）。良かった=緑／残念だった=赤。
import { asCachedImgAttrs } from '/js/image-cache.js';
import { getReviewerAvatarUrl } from '/js/profile-utils.js';

// コメントを innerHTML に流し込むので XSS 防止のためエスケープ（各ページの escapeHtml と同一実装）
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// Firestore Timestamp / millis 数値 / {seconds} プレーンオブジェクト（render-cache 復元時）に対応
function fmtDate(ts) {
    let d;
    if (ts?.toDate) d = ts.toDate();
    else if (typeof ts === 'number') d = new Date(ts);
    else if (ts && ts.seconds != null) d = new Date(ts.seconds * 1000);
    else d = new Date(ts || 0);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    return `${y}/${m}/${da}`;
}

// 旧データ（rating 1-5）の互換: 4以上なら good 扱い
export function legacyToVerdict(r) {
    if (r.verdict) return r.verdict;
    const avg = Number(r.avgRating || r.overall || 0);
    return avg >= 4 ? 'good' : avg > 0 ? 'bad' : null;
}

// 良かった=線画スマイリー(緑)／残念だった=線画スマイリー(赤)。絵文字は使わない（#128 と統一）。
export function verdictBadge(verdict) {
    if (verdict === 'good') {
        return `<span style="display:inline-flex; align-items:center; gap:4px; background:#ecfdf5; color:#047857; padding:3px 10px; border-radius:999px; font-size:12px; font-weight:700;">
            <span class="material-symbols-outlined" style="font-size:15px;">sentiment_satisfied</span>${i18next.t('review.verdictGood')}</span>`;
    }
    if (verdict === 'bad') {
        return `<span style="display:inline-flex; align-items:center; gap:4px; background:#fef2f2; color:#b91c1c; padding:3px 10px; border-radius:999px; font-size:12px; font-weight:700;">
            <span class="material-symbols-outlined" style="font-size:15px;">sentiment_dissatisfied</span>${i18next.t('review.verdictBad')}</span>`;
    }
    return '';
}

// レビューカード1枚分の HTML。hidden=true は「もっと見る」で展開する隠し行。
function reviewCardHtml(r, reviewerMap, hidden) {
    const v = legacyToVerdict(r);
    const reviewer = (reviewerMap && reviewerMap[r.fromUid]) || {};
    const reviewerName = reviewer.displayName || i18next.t('profile.anonymousReviewer');
    const reviewerAvatar = getReviewerAvatarUrl(reviewer);
    const avatarHtml = reviewerAvatar
        ? `<img ${asCachedImgAttrs(reviewerAvatar)} alt="" loading="lazy">`
        : `<span class="material-symbols-outlined">${reviewer.role === 'restaurant' ? 'storefront' : 'person'}</span>`;
    return `
        <div class="review-card"${hidden ? ' data-extra-review style="display:none;"' : ''}>
            <div class="review-card__reviewer">
                <div class="review-card__avatar">${avatarHtml}</div>
                <div class="review-card__reviewer-name">${escapeHtml(reviewerName)}</div>
            </div>
            <div class="review-card__head">
                ${verdictBadge(v)}
                <div class="review-card__date">${fmtDate(r.createdAt)}</div>
            </div>
            <div class="review-card__comment">${escapeHtml(r.comment)}</div>
        </div>
    `;
}

/**
 * レビューコメントを「最新3件＋もっと見る（残り◯件）」で listEl に描画する。
 * 専用の全レビュー画面は作らない（生産者ページ・公開Q&Aと同パターン）。
 * @param {HTMLElement} listEl 描画先（例 #reviews-list）
 * @param {Array} reviewsWithComment コメント付きレビュー（新しい順・hidden 除外済み）
 * @param {Object} reviewerMap fromUid → users ドキュメント
 * @param {number} initial 初期表示件数（既定3・調整可能パラメータ）
 */
export function renderReviewComments(listEl, reviewsWithComment, reviewerMap, initial = 3) {
    if (!listEl) return;
    if (!reviewsWithComment || reviewsWithComment.length === 0) {
        listEl.innerHTML = `<div class="empty-small">${i18next.t('profile.noReviews')}</div>`;
        return;
    }
    const remaining = reviewsWithComment.length - initial;
    const moreBtn = remaining > 0
        ? `<button type="button" class="reviews-more" id="reviews-more-btn">${escapeHtml(i18next.t('profile.reviewsMore', { count: remaining }))}</button>`
        : '';
    listEl.innerHTML = reviewsWithComment.map((r, i) => reviewCardHtml(r, reviewerMap, i >= initial)).join('') + moreBtn;
    const moreBtnEl = listEl.querySelector('#reviews-more-btn');
    if (moreBtnEl) {
        moreBtnEl.addEventListener('click', () => {
            listEl.querySelectorAll('[data-extra-review]').forEach(el => { el.style.display = ''; });
            moreBtnEl.remove();
        });
    }
}
