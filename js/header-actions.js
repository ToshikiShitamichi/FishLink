// ヘッダー右上アクション（通知・やることリスト）のポップオーバー開閉ユーティリティ
// 使い方（HTML）:
//   <div class="header-actions">
//     <button class="header-action-btn" data-popover="notif">
//       <span class="material-symbols-outlined">notifications</span>
//       <span class="header-action-btn__badge" id="notif-badge"></span>
//     </button>
//     <div class="header-popover" data-popover-for="notif">...</div>
//
//     <button class="header-action-btn" data-popover="todos">...</button>
//     <div class="header-popover" data-popover-for="todos">...</div>
//
//     <a class="header-action-btn" href="/pages/.../account.html">
//       <span class="material-symbols-outlined">person</span>
//     </a>
//   </div>
//
// 呼び出し側で initHeaderPopovers() を DOMContentLoaded 後に呼ぶ

export function initHeaderPopovers(rootEl = document) {
    const backdrop = document.createElement('div');
    backdrop.className = 'header-popover-backdrop';
    document.body.appendChild(backdrop);

    function closeAll() {
        rootEl.querySelectorAll('.header-popover.open').forEach(p => p.classList.remove('open'));
        backdrop.classList.remove('open');
    }

    rootEl.querySelectorAll('.header-action-btn[data-popover]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const name = btn.dataset.popover;
            const popover = rootEl.querySelector(`.header-popover[data-popover-for="${name}"]`);
            if (!popover) return;
            const isOpen = popover.classList.contains('open');
            closeAll();
            if (!isOpen) {
                popover.classList.add('open');
                backdrop.classList.add('open');
            }
        });
    });

    backdrop.addEventListener('click', closeAll);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeAll();
    });
}

// バッジ数を更新（0 の場合は非表示）
export function setBadge(badgeId, count) {
    const el = document.getElementById(badgeId);
    if (!el) return;
    if (count > 0) {
        el.textContent = count > 99 ? '99+' : String(count);
    } else {
        el.textContent = '';
    }
}
