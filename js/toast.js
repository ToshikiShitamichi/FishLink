// 6/22 束A-E: 設定保存の共通フィードバック「✓ 保存しました」トースト（プロフィール spec §7-1）。
//   画面下中央のダークピル・✓は緑(#4ADE80)・2〜3秒で自動消滅・暗転なし。
//   保存エラーは各画面のインライン赤メッセージで出す（トーストは成功時のみ）。
//   #165 基本情報 / #167 送金先・返金先 / #168 配送設定 / #169 FAQ⑩ で共有利用。
//
// 使い方:
//   import { showToast } from '/js/toast.js';
//   showToast(i18next.t('account.saved'));            // ✓ 保存しました
//   showToast('...', { icon: false });                // チェックなし
//   showToast('...', { duration: 4000 });             // 表示時間(ms)

let styleInjected = false;
let activeTimer = null;

// CSS を1度だけ注入（style.css 非依存で完全自己完結＝どのページからでも同じ見た目）。
function ensureStyle() {
    if (styleInjected) return;
    styleInjected = true;
    const css = `
.fl-toast {
    position: fixed;
    left: 50%;
    bottom: calc(26px + env(safe-area-inset-bottom, 0px));
    transform: translateX(-50%) translateY(8px);
    background: rgba(26, 32, 40, 0.93);
    color: #fff;
    font-size: 13.5px;
    font-weight: 700;
    line-height: 1.4;
    padding: 12px 20px;
    border-radius: 22px;
    display: flex;
    align-items: center;
    gap: 8px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
    max-width: calc(100vw - 40px);
    z-index: 4000;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.22s ease, transform 0.22s ease;
}
.fl-toast.fl-toast--show {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
}
.fl-toast__check {
    color: #4ade80;
    font-weight: 800;
    font-size: 15px;
    flex: 0 0 auto;
}
@media (prefers-reduced-motion: reduce) {
    .fl-toast { transition: opacity 0.01s; }
}`;
    const style = document.createElement('style');
    style.setAttribute('data-fl-toast', '');
    style.textContent = css;
    document.head.appendChild(style);
}

/**
 * 「✓ 保存しました」系のトーストを表示する。
 * @param {string} message 表示テキスト（i18n 済みの文字列を渡す）
 * @param {{icon?: boolean, duration?: number}} [opts]
 */
export function showToast(message, opts = {}) {
    if (typeof document === 'undefined') return;
    ensureStyle();

    const { icon = true, duration = 2400 } = opts;

    // 直前のトーストが残っていれば消す（多重表示しない）。
    if (activeTimer) { clearTimeout(activeTimer); activeTimer = null; }
    document.querySelectorAll('.fl-toast').forEach((el) => el.remove());

    const toast = document.createElement('div');
    toast.className = 'fl-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');

    if (icon) {
        const check = document.createElement('span');
        check.className = 'fl-toast__check';
        check.textContent = '✓'; // ✓
        toast.appendChild(check);
    }
    const text = document.createElement('span');
    text.textContent = message == null ? '' : String(message);
    toast.appendChild(text);

    document.body.appendChild(toast);

    // 次フレームで .show を付けてフェードイン。
    requestAnimationFrame(() => {
        requestAnimationFrame(() => toast.classList.add('fl-toast--show'));
    });

    activeTimer = setTimeout(() => {
        toast.classList.remove('fl-toast--show');
        // フェードアウト後に DOM から除去。
        setTimeout(() => toast.remove(), 300);
        activeTimer = null;
    }, Math.max(800, duration));
}

export default showToast;
