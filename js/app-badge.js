// PWAアプリアイコンのバッジ（通知 + やることリストの合算）
// Badging API (navigator.setAppBadge) を使用
// - Android Chrome（PWAインストール時）
// - iOS Safari 16.4+（PWAホーム画面追加時）
// - デスクトップChrome
// 未対応環境では自動で no-op

let notifCount = 0;
let todoCount = 0;

function applyBadge() {
    const total = notifCount + todoCount;
    if (!('setAppBadge' in navigator)) return;
    try {
        if (total > 0) {
            navigator.setAppBadge(total).catch(() => {});
        } else {
            navigator.clearAppBadge().catch(() => {});
        }
    } catch (e) {
        // 一部ブラウザで例外を投げることがある
    }
}

export function setNotifBadgeCount(n) {
    notifCount = Math.max(0, Number(n) || 0);
    applyBadge();
}

export function setTodoBadgeCount(n) {
    todoCount = Math.max(0, Number(n) || 0);
    applyBadge();
}

export function clearAppBadge() {
    notifCount = 0;
    todoCount = 0;
    applyBadge();
}
