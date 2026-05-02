// 管理者ナビゲーションの「トラブル報告」リンクに「未対応件数」バッジを表示
// 5/2: status === 'open' の件数を全管理者ページで共通に表示するためのユーティリティ
import { db } from '/js/firebase-config.js';
import {
    collection, query, where, onSnapshot
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';

let unsub = null;

export function initAdminReportBadge() {
    // ナビ内の reports.html へのリンクを特定し、バッジを差し込む
    const link = document.querySelector('.admin-nav a[href$="/admin/reports.html"]');
    if (!link) return;

    // 既にバッジが入っていれば再利用
    let badge = link.querySelector('.admin-nav__badge');
    if (!badge) {
        badge = document.createElement('span');
        badge.className = 'admin-nav__badge';
        badge.style.cssText = `
            display: none;
            margin-left: 6px;
            background: #dc2626; color: #fff;
            font-size: 11px; font-weight: 700;
            padding: 1px 7px; border-radius: 999px;
            min-width: 18px; text-align: center;
            vertical-align: middle;
        `;
        link.appendChild(badge);
    }

    if (unsub) unsub();
    const q = query(collection(db, 'reports'), where('status', '==', 'open'));
    unsub = onSnapshot(q, (snap) => {
        const n = snap.size;
        if (n > 0) {
            badge.textContent = n > 99 ? '99+' : String(n);
            badge.style.display = 'inline-block';
        } else {
            badge.style.display = 'none';
        }
    }, (err) => {
        console.warn('admin report badge subscribe failed:', err.message);
    });
}
