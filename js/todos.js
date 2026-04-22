// やることリスト購読・描画ユーティリティ
// Firestore: todos/{uid}/items/{id}
//   type: 'farmer_approve' | 'farmer_prepare' | ... | 'rest_receive' | 'admin_remit' ...
//   orderId?: string
//   status: 'open' | 'completed'
//   createdAt: Timestamp

import { db } from '/js/firebase-config.js';
import {
    collection, query, where, onSnapshot
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { setBadge } from '/js/header-actions.js';
import { setTodoBadgeCount } from '/js/app-badge.js';

// todo.type → 遷移URL（orderIdを含めて）を解決
function resolveTodoUrl(todo, role) {
    const oid = todo.orderId;
    switch (todo.type) {
        case 'farmer_approve':
            return `/pages/farmer/orders.html#order-${oid}`;
        case 'farmer_prepare':
        case 'farmer_deliver':
        case 'farmer_complete_delivery':
            return `/pages/farmer/delivery.html?id=${oid}`;
        case 'farmer_review':
            return `/pages/farmer/review.html?id=${oid}`;
        case 'farmer_reply':
            return `/pages/farmer/delivery.html?id=${oid}`;
        case 'rest_receive':
        case 'rest_reply':
            return `/pages/restaurant/delivery.html?id=${oid}`;
        case 'rest_pay':
            return `/pages/restaurant/payment.html?id=${oid}`;
        case 'rest_review':
            return `/pages/restaurant/review.html?id=${oid}`;
        case 'admin_verify_payment':
        case 'admin_remit':
        case 'admin_done':
            return `/pages/admin/order.html?id=${oid}`;
        default:
            return '#';
    }
}

function relativeTime(ts) {
    const ms = ts?.toMillis?.() || 0;
    if (!ms) return '';
    const diff = Date.now() - ms;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return window.i18next?.t?.('comments.justNow') || 'just now';
    if (mins < 60) return window.i18next?.t?.('comments.minutesAgo', { n: mins }) || `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return window.i18next?.t?.('comments.hoursAgo', { n: hours }) || `${hours}h`;
    const days = Math.floor(hours / 24);
    return window.i18next?.t?.('comments.daysAgo', { n: days }) || `${days}d`;
}

function renderTodoItem(todo, role) {
    const titleKey = `todos.${todo.type}.title`;
    const bodyKey = `todos.${todo.type}.body`;
    const title = window.i18next?.exists?.(titleKey) ? window.i18next.t(titleKey) : todo.type;
    const body = window.i18next?.exists?.(bodyKey) ? window.i18next.t(bodyKey) : '';
    const url = resolveTodoUrl(todo, role);
    const time = relativeTime(todo.createdAt);
    return `
        <a class="popover-item unread" href="${url}">
            <div class="popover-item__title">${escapeHtml(title)}</div>
            ${body ? `<div class="popover-item__body">${escapeHtml(body)}</div>` : ''}
            ${time ? `<div class="popover-item__time">${time}</div>` : ''}
        </a>
    `;
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 指定UIDのやることリストを購読してポップオーバーに描画
// role: 'farmer' | 'restaurant' | 'admin'
let unsubscribeTodos = null;
export function subscribeTodos(uid, role) {
    if (unsubscribeTodos) unsubscribeTodos();
    if (!uid) return;

    const listEl = document.getElementById('todos-list');
    if (!listEl) return;

    // status=open のみで絞り込み。並び順はクライアント側でソート（複合インデックス不要）
    const q = query(
        collection(db, 'todos', uid, 'items'),
        where('status', '==', 'open')
    );
    unsubscribeTodos = onSnapshot(q, (snap) => {
        if (snap.empty) {
            listEl.innerHTML = `<div class="header-popover__empty">${window.i18next.t('todos.empty')}</div>`;
            setBadge('todos-badge', 0);
            setTodoBadgeCount(0);
            return;
        }
        const items = [];
        snap.forEach(d => items.push({ id: d.id, ...d.data() }));
        // 作成日時降順ソート
        items.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
        listEl.innerHTML = items.map(t => renderTodoItem(t, role)).join('');
        setBadge('todos-badge', items.length);
        setTodoBadgeCount(items.length);
    }, (err) => {
        console.warn('todos subscribe error:', err);
    });
}
