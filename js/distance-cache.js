// 道路距離キャッシュ（Google Maps Distance Matrix API のコール削減用）
// - localStorage に {restaurantUid, farmerUid} ペア単位で保存
// - 両者の位置は通常変わらないので、90日 TTL で十分
// - ヒット時は API 呼出しをスキップ → コスト削減

const KEY_PREFIX = 'fishlink_dist:';
const TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90日

function makeKey(a, b) {
    return `${KEY_PREFIX}${a}:${b}`;
}

// 位置情報が 100m 以上ずれていたら別地点とみなして再計算
const LOCATION_THRESHOLD_KM = 0.1;

function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
        * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * キャッシュから道路距離（km）を取得。未キャッシュ・期限切れ・位置変更検知なら null。
 * currentLocs を渡すと、キャッシュ時点の位置と現在位置を比較して 100m 以上ずれていたら無効化する
 */
export function getCachedDistance(restaurantUid, farmerUid, currentLocs) {
    if (!restaurantUid || !farmerUid) return null;
    try {
        const key = makeKey(restaurantUid, farmerUid);
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const data = JSON.parse(raw);
        const { km, at, rLat, rLng, fLat, fLng } = data;
        if (typeof km !== 'number' || typeof at !== 'number') return null;
        if (Date.now() - at > TTL_MS) {
            localStorage.removeItem(key);
            return null;
        }
        // 現在位置が渡されていれば、キャッシュ時の位置とのズレを確認
        if (currentLocs && typeof rLat === 'number' && typeof fLat === 'number') {
            const rDiff = haversineKm(rLat, rLng, currentLocs.rLat, currentLocs.rLng);
            const fDiff = haversineKm(fLat, fLng, currentLocs.fLat, currentLocs.fLng);
            if (rDiff > LOCATION_THRESHOLD_KM || fDiff > LOCATION_THRESHOLD_KM) {
                localStorage.removeItem(key);
                return null;
            }
        }
        return km;
    } catch (e) {
        return null;
    }
}

/**
 * 道路距離（km）をキャッシュに保存。
 * locs を渡すと、次回取得時に位置変更検知が可能になる。
 */
export function setCachedDistance(restaurantUid, farmerUid, km, locs) {
    if (!restaurantUid || !farmerUid || typeof km !== 'number') return;
    try {
        const payload = { km, at: Date.now() };
        if (locs) {
            payload.rLat = locs.rLat;
            payload.rLng = locs.rLng;
            payload.fLat = locs.fLat;
            payload.fLng = locs.fLng;
        }
        localStorage.setItem(makeKey(restaurantUid, farmerUid), JSON.stringify(payload));
    } catch (e) {
        // localStorage quota 超過等は無視
    }
}

/**
 * 全ての距離キャッシュをクリア（位置情報更新時などに使用）
 */
export function clearAllDistanceCache() {
    try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(KEY_PREFIX)) keys.push(k);
        }
        keys.forEach(k => localStorage.removeItem(k));
    } catch (e) { /* ignore */ }
}

/**
 * 特定ユーザーに関連する距離キャッシュを全クリア（そのユーザーの位置変更時用）
 */
export function clearDistanceCacheForUser(uid) {
    if (!uid) return;
    try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(KEY_PREFIX) && k.includes(uid)) keys.push(k);
        }
        keys.forEach(k => localStorage.removeItem(k));
    } catch (e) { /* ignore */ }
}
