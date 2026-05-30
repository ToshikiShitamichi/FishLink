// プロフィール画像・ロール別アイコン解決ユーティリティ
// 5/12 #71: レビュー欄でレビュアーのロールに応じた登録済み画像を表示するため。

/**
 * レビュー欄などで使うレビュアーのアイコン URL を返す。
 * - 農家がレビュー → avatarUrl（顔写真・専用アイコン）を優先、なければ pondPhotoUrl
 * - レストランがレビュー → restaurantPhotoUrl（店舗写真）を優先、なければ avatarUrl
 * 5/12 #72 互換: 複数写真化（pondPhotos[] / restaurantPhotos[]）が入った場合は配列の先頭にもフォールバック。
 * 取得できない場合は null を返す（呼び出し側でデフォルトアイコンを表示）。
 *
 * @param {object} user users/{uid} ドキュメント
 * @returns {string|null}
 */
export function getReviewerAvatarUrl(user) {
    if (!user || typeof user !== 'object') return null;
    const role = user.role;
    const avatar = user.avatarUrl || null;
    if (role === 'restaurant') {
        const photos = Array.isArray(user.restaurantPhotos) ? user.restaurantPhotos : [];
        return user.restaurantPhotoUrl || photos[0] || avatar || null;
    }
    if (role === 'farmer') {
        const photos = Array.isArray(user.pondPhotos) ? user.pondPhotos : [];
        return avatar || user.pondPhotoUrl || photos[0] || null;
    }
    // admin など：アイコンが設定されていれば使う
    return avatar;
}

/**
 * 生産者ページの「養殖環境写真」一覧。
 * 配列フィールド（pondPhotos[]）優先、無ければ単数フィールド（pondPhotoUrl）。
 * @param {object} user
 * @returns {string[]}
 */
export function getPondPhotos(user) {
    if (!user) return [];
    if (Array.isArray(user.pondPhotos) && user.pondPhotos.length > 0) {
        return user.pondPhotos.filter(Boolean);
    }
    if (user.pondPhotoUrl) return [user.pondPhotoUrl];
    return [];
}

/**
 * レストランページの「店舗写真」一覧。
 * 配列フィールド（restaurantPhotos[]）優先、無ければ単数フィールド（restaurantPhotoUrl）。
 * @param {object} user
 * @returns {string[]}
 */
export function getRestaurantPhotos(user) {
    if (!user) return [];
    if (Array.isArray(user.restaurantPhotos) && user.restaurantPhotos.length > 0) {
        return user.restaurantPhotos.filter(Boolean);
    }
    if (user.restaurantPhotoUrl) return [user.restaurantPhotoUrl];
    return [];
}

// 5/27 #96: GAqP 認証バッジの HTML（共通スタイル）。i18next が必要。
// size: 'sm' (一覧カード用・コンパクト) | 'md' (詳細ページ用)
export function gaqpBadgeHtml(user, size = 'md') {
    if (!user || user.gaqpCertified !== true) return '';
    const isSm = size === 'sm';
    const padding = isSm ? '1px 6px' : '3px 10px';
    const fontSize = isSm ? '10px' : '12px';
    const iconSize = isSm ? '12px' : '14px';
    return `<span style="display:inline-flex; align-items:center; gap:3px; padding:${padding}; background:#0d6e4c; color:#fff; border-radius:10px; font-size:${fontSize}; font-weight:700; white-space:nowrap;">
        <span class="material-symbols-outlined" style="font-size:${iconSize};">verified</span>
        ${typeof i18next !== 'undefined' ? i18next.t('gaqp.badge') : 'GAqP'}
    </span>`;
}
