// お気に入り管理（Firestore: favorites/{uid}）
import { db } from '/js/firebase-config.js';
import {
    doc, getDoc, setDoc, onSnapshot, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';

function favRef(uid) {
    return doc(db, 'favorites', uid);
}

export async function getFavorites(uid) {
    if (!uid) return [];
    const snap = await getDoc(favRef(uid));
    if (!snap.exists()) return [];
    const data = snap.data();
    return Array.isArray(data.listingIds) ? data.listingIds : [];
}

export async function toggleFavorite(uid, listingId) {
    if (!uid || !listingId) return;
    const current = await getFavorites(uid);
    const next = current.includes(listingId)
        ? current.filter(id => id !== listingId)
        : [...current, listingId];
    await setDoc(favRef(uid), {
        listingIds: next,
        updatedAt: serverTimestamp(),
    }, { merge: true });
    return next;
}

/**
 * お気に入り一覧をリアルタイム購読。コールバックには listingIds[] が渡る。
 */
export function subscribeFavorites(uid, onChange) {
    if (!uid) return () => {};
    return onSnapshot(favRef(uid), (snap) => {
        const data = snap.exists() ? snap.data() : {};
        const listingIds = Array.isArray(data.listingIds) ? data.listingIds : [];
        onChange(listingIds);
    });
}
