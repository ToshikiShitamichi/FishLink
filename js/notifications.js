// 通知履歴 購読・描画ユーティリティ
// Firestore: notifications/{uid}/items/{id}
//   type, title, body, url, orderId?, read: bool, createdAt: Timestamp

import { db } from '/js/firebase-config.js';
import {
    collection, query, where, doc, updateDoc, onSnapshot, writeBatch
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { setBadge } from '/js/header-actions.js';
import { setNotifBadgeCount } from '/js/app-badge.js';
import { onLanguageChange } from '/js/i18n.js';

// 言語切替時に自動で再描画
onLanguageChange(() => renderNotifList());

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

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// msgKey/vars が保存されていれば現在の言語で翻訳、なければ保存された title/body をそのまま使う
function resolveTitleBody(n) {
    const i18n = window.i18next;
    if (n.msgKey && n.vars && i18n?.exists?.(`notifMessages.${n.msgKey}.title`)) {
        return {
            title: i18n.t(`notifMessages.${n.msgKey}.title`, n.vars || {}),
            body: i18n.t(`notifMessages.${n.msgKey}.body`, n.vars || {}),
        };
    }
    return { title: n.title || '', body: n.body || '' };
}

function renderNotifItem(n) {
    const url = n.url || '#';
    const time = relativeTime(n.createdAt);
    const { title, body } = resolveTitleBody(n);
    return `
        <a class="popover-item ${!n.read ? 'unread' : ''}" href="${url}" data-id="${n.id}">
            <div class="popover-item__title">${escapeHtml(title)}</div>
            ${body ? `<div class="popover-item__body">${escapeHtml(body)}</div>` : ''}
            ${time ? `<div class="popover-item__time">${time}</div>` : ''}
        </a>
    `;
}

let unsubscribeNotifs = null;
let cachedUid = null;
let cachedItems = [];

function renderNotifList() {
    const listEl = document.getElementById('notif-list');
    if (!listEl) return;
    const display = cachedItems.slice(0, 50);
    if (display.length === 0) {
        listEl.innerHTML = `<div class="header-popover__empty">${window.i18next.t('notifications.empty')}</div>`;
    } else {
        listEl.innerHTML = display.map(renderNotifItem).join('');
    }
}

// 言語切替時に現在の通知を再描画（時間ラベル＋msgKey 翻訳を現在言語で更新）
export function refreshNotificationsI18n() {
    renderNotifList();
}

// ポップオーバーを開いたときに全既読化（ベル側 aria 経由の外部コール）
export async function markAllNotificationsRead() {
    if (!cachedUid) return;
    const unread = cachedItems.filter(n => !n.read);
    if (unread.length === 0) return;
    const batch = writeBatch(db);
    unread.forEach(n => {
        batch.update(doc(db, 'notifications', cachedUid, 'items', n.id), { read: true });
    });
    await batch.commit();
}

export function subscribeNotifications(uid) {
    if (unsubscribeNotifs) unsubscribeNotifs();
    if (!uid) return;
    cachedUid = uid;

    const listEl = document.getElementById('notif-list');
    if (!listEl) return;

    // 作成日時順はクライアントサイドでソート（複合インデックス不要）
    const q = query(collection(db, 'notifications', uid, 'items'));
    unsubscribeNotifs = onSnapshot(q, (snap) => {
        cachedItems = [];
        snap.forEach(d => cachedItems.push({ id: d.id, ...d.data() }));
        cachedItems.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
        renderNotifList();
        // 未読数をバッジに反映
        const unreadCount = cachedItems.filter(n => !n.read).length;
        setBadge('notif-badge', unreadCount);
        setNotifBadgeCount(unreadCount);
    }, (err) => {
        console.warn('notifications subscribe error:', err);
    });

    // ベル popover が開かれたタイミングで既読化
    const bellBtn = document.querySelector('.header-action-btn[data-popover="notif"]');
    if (bellBtn && !bellBtn.dataset.notifBound) {
        bellBtn.dataset.notifBound = '1';
        bellBtn.addEventListener('click', () => {
            // 少し遅らせて popover 表示後に既読化
            setTimeout(() => { markAllNotificationsRead(); }, 300);
        });
    }
}
