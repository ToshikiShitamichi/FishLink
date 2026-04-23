// カート管理（Firestore: carts/{uid}）
import { db } from '/js/firebase-config.js';
import {
    doc, getDoc, setDoc, updateDoc, onSnapshot, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';

function cartRef(uid) {
    return doc(db, 'carts', uid);
}

export async function getCart(uid) {
    if (!uid) return { items: [] };
    const snap = await getDoc(cartRef(uid));
    if (!snap.exists()) return { items: [] };
    const data = snap.data();
    return { items: Array.isArray(data.items) ? data.items : [] };
}

/**
 * 既存カートに商品を追加。同じ listingId + gutProcessing の組み合わせは quantity を加算。
 */
export async function addToCart(uid, { listingId, farmerId, quantity, gutProcessing }) {
    if (!uid || !listingId || !farmerId) throw new Error('Invalid cart item');
    const cart = await getCart(uid);
    const items = [...cart.items];
    const idx = items.findIndex(it =>
        it.listingId === listingId && it.gutProcessing === !!gutProcessing
    );
    if (idx >= 0) {
        items[idx] = { ...items[idx], quantity: (items[idx].quantity || 0) + quantity };
    } else {
        items.push({
            listingId,
            farmerId,
            quantity,
            gutProcessing: !!gutProcessing,
            addedAt: Date.now(),
        });
    }
    await setDoc(cartRef(uid), { items, updatedAt: serverTimestamp() }, { merge: true });
}

export async function updateCartItem(uid, index, patch) {
    const cart = await getCart(uid);
    const items = [...cart.items];
    if (index < 0 || index >= items.length) return;
    items[index] = { ...items[index], ...patch };
    await setDoc(cartRef(uid), { items, updatedAt: serverTimestamp() }, { merge: true });
}

export async function removeCartItem(uid, index) {
    const cart = await getCart(uid);
    const items = cart.items.filter((_, i) => i !== index);
    await setDoc(cartRef(uid), { items, updatedAt: serverTimestamp() }, { merge: true });
}

export async function clearCart(uid) {
    await setDoc(cartRef(uid), { items: [], updatedAt: serverTimestamp() }, { merge: true });
}

/**
 * カートの内容をリアルタイム監視してバッジ等に反映するコールバックを登録。
 * 戻り値: unsubscribe 関数
 */
export function subscribeCart(uid, onChange) {
    if (!uid) return () => {};
    return onSnapshot(cartRef(uid), (snap) => {
        const data = snap.exists() ? snap.data() : {};
        const items = Array.isArray(data.items) ? data.items : [];
        onChange(items);
    });
}

/**
 * items 配列を farmerId でグループ化
 */
export function groupByFarmer(items) {
    const groups = new Map();
    for (const it of items) {
        const key = it.farmerId;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(it);
    }
    return groups;
}
