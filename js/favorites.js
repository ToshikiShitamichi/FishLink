// お気に入り管理（Firestore: favorites/{uid}）
import { db } from '/js/firebase-config.js';
import {
    doc, getDoc, setDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';

function favRef(uid) {
    return doc(db, 'favorites', uid);
}

const favListeners = new Set();

function notifyFavListeners(listingIds) {
    favListeners.forEach(cb => {
        try { cb(listingIds); } catch (e) { console.error(e); }
    });
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
    notifyFavListeners(next);
    return next;
}

/**
 * お気に入り一覧を購読。
 * onSnapshot は使わず初回 getDoc + 自身のトグルのみで通知。
 * 戻り値: unsubscribe 関数
 */
export function subscribeFavorites(uid, onChange) {
    if (!uid) return () => { };
    favListeners.add(onChange);
    getFavorites(uid).then(ids => onChange(ids)).catch(() => onChange([]));
    return () => favListeners.delete(onChange);
}
