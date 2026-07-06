// 6/29 #186: 通知許可の「自前ソフト確認」（許可前ダイアログ）。notification-spec §6 / push-permission mock。
//   二段構え＝いきなりOS許可を出さず、まずアプリ内の中央モーダルで意思確認 →〔オンにする〕を
//   押した人にだけ OSダイアログ（enablePush）を出す（OSの一発勝負を温存）。〔あとで〕では出さない。
//   聞くタイミング：登録完了直後（onboarding）／〔あとで〕の人だけ 買い手=初回注文後・農家=初回出品後。
//
// 使い方:
//   import { maybePromptPushOptin, consumePendingOptin, markOptinPending } from '/js/push-optin.js';
//   maybePromptPushOptin('restaurant', 'onboarding');   // onboarding 直後
//   markOptinPending('restaurant');                      // 注文/出品の成功時（遷移前）にフラグを立てる
//   consumePendingOptin('restaurant');                   // 遷移先（注文状況/投稿一覧）で回収して表示

import { enablePush } from '/js/auth.js';

let styleInjected = false;
let modalOpen = false;

const PENDING_KEY = 'fishlink_push_optin_pending';

function t(key, fallback) {
    try {
        const v = window.i18next?.t?.(key);
        if (v && v !== key) return v;
    } catch (e) { /* ignore */ }
    return fallback;
}

function ensureStyle() {
    if (styleInjected) return;
    styleInjected = true;
    const css = `
.pushoptin-ov {
    position: fixed; inset: 0; z-index: 5000;
    background: rgba(20, 28, 38, 0.46);
    display: flex; align-items: center; justify-content: center;
    padding: 0 24px;
    opacity: 0; transition: opacity 0.18s ease;
}
.pushoptin-ov.pushoptin-ov--show { opacity: 1; }
.pushoptin-card {
    background: #fff; border-radius: 18px;
    padding: 24px 20px 16px; text-align: center;
    width: 100%; max-width: 300px;
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
    transform: scale(0.96); transition: transform 0.18s ease;
    font-family: inherit;
}
.pushoptin-ov--show .pushoptin-card { transform: scale(1); }
.pushoptin-card__ic {
    width: 56px; height: 56px; border-radius: 16px;
    background: var(--color-cta-lt, #eaf2fb); color: var(--color-cta, #0b5fb0);
    display: flex; align-items: center; justify-content: center;
    margin: 0 auto 14px;
}
.pushoptin-card__ic .material-symbols-outlined { font-size: 28px; }
.pushoptin-card__title { font-size: 17px; font-weight: 800; margin-bottom: 8px; color: var(--color-text, #1a1a1a); }
.pushoptin-card__body { font-size: 13px; color: var(--color-text-sub, #5a6470); line-height: 1.6; margin-bottom: 18px; }
.pushoptin-card__on {
    display: block; width: 100%; border: none; border-radius: 12px;
    padding: 14px; font-size: 15px; font-weight: 800; cursor: pointer;
    font-family: inherit; background: var(--color-cta, #0b5fb0); color: #fff;
}
.pushoptin-card__hint { font-size: 11px; color: #9aa3b0; margin: 8px 0 4px; }
.pushoptin-card__later {
    display: block; width: 100%; text-align: center; background: none; border: none;
    color: #9aa3b0; font-size: 13px; font-weight: 700; padding: 10px 0 2px; cursor: pointer;
    font-family: inherit;
}`;
    const style = document.createElement('style');
    style.setAttribute('data-pushoptin', '');
    style.textContent = css;
    document.head.appendChild(style);
}

function showModal(role) {
    if (modalOpen) return;
    if (typeof document === 'undefined' || !document.body) return;
    modalOpen = true;
    ensureStyle();

    const bodyText = role === 'farmer'
        ? t('pushOptin.bodyFarmer', 'We’ll notify you the moment a new order arrives, so you don’t miss approvals.')
        : t('pushOptin.bodyBuyer', 'We’ll notify you about approvals and delivery updates, so you never miss your order’s progress.');

    const ov = document.createElement('div');
    ov.className = 'pushoptin-ov';
    ov.innerHTML = `
        <div class="pushoptin-card" role="dialog" aria-modal="true">
            <div class="pushoptin-card__ic"><span class="material-symbols-outlined">notifications</span></div>
            <div class="pushoptin-card__title"></div>
            <div class="pushoptin-card__body"></div>
            <button type="button" class="pushoptin-card__on"></button>
            <div class="pushoptin-card__hint"></div>
            <button type="button" class="pushoptin-card__later"></button>
        </div>`;
    // textContent で入れる（i18n 値の XSS 安全化）
    ov.querySelector('.pushoptin-card__title').textContent = t('pushOptin.title', 'Turn on notifications?');
    ov.querySelector('.pushoptin-card__body').textContent = bodyText;
    ov.querySelector('.pushoptin-card__on').textContent = t('pushOptin.enable', 'Turn on');
    ov.querySelector('.pushoptin-card__hint').textContent = t('pushOptin.hint', 'In the next screen, please choose "Allow".');
    ov.querySelector('.pushoptin-card__later').textContent = t('pushOptin.later', 'Later');

    function close() {
        ov.classList.remove('pushoptin-ov--show');
        setTimeout(() => { ov.remove(); modalOpen = false; }, 200);
    }

    ov.querySelector('.pushoptin-card__on').addEventListener('click', async () => {
        close();
        try { await enablePush(); } catch (e) { /* ignore（拒否/未対応でもフローは止めない） */ }
    });
    ov.querySelector('.pushoptin-card__later').addEventListener('click', close);
    // 背景タップは「あとで」と同義（次のトリガーで再度聞ける）
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });

    document.body.appendChild(ov);
    requestAnimationFrame(() => requestAnimationFrame(() => ov.classList.add('pushoptin-ov--show')));
}

/**
 * ソフト確認モーダルを（条件を満たせば）表示する。
 * @param {'restaurant'|'farmer'} role 役割別文言の出し分け
 * @param {string} triggerKey 'onboarding' | 'first_order' | 'first_listing' 等（トリガーごとに1回だけ）
 */
export function maybePromptPushOptin(role, triggerKey) {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    // granted/denied は再要求しない（OSは実質1回きり）。default の人だけソフト確認。
    if (Notification.permission !== 'default') return;
    const flag = `fishlink_push_optin_${triggerKey}`;
    try {
        if (localStorage.getItem(flag)) return; // このトリガーでは既に表示済み
        localStorage.setItem(flag, '1');
    } catch (e) { /* localStorage 不可でも表示は続行 */ }
    showModal(role);
}

/** 注文/出品の成功時（遷移前）に「遷移先で聞く」フラグを立てる。 */
export function markOptinPending(role) {
    try { localStorage.setItem(PENDING_KEY, role); } catch (e) { /* ignore */ }
}

/**
 * 遷移先ページ（買い手=注文状況／農家=投稿一覧）で pending フラグを回収し、役割が一致すればソフト確認。
 * @param {'restaurant'|'farmer'} expectedRole このページの役割
 */
export function consumePendingOptin(expectedRole) {
    let pending = null;
    try { pending = localStorage.getItem(PENDING_KEY); } catch (e) { return; }
    if (!pending || pending !== expectedRole) return;
    try { localStorage.removeItem(PENDING_KEY); } catch (e) { /* ignore */ }
    const trigger = expectedRole === 'farmer' ? 'first_listing' : 'first_order';
    maybePromptPushOptin(expectedRole, trigger);
}

export default maybePromptPushOptin;
