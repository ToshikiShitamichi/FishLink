// 6/4 #125/#126: 配送管理チャットの共有レンダリング（農家側・レストラン側で共通＝鏡像）
//
// 設計の正本は docs/design/fishlink-chat-mockup.html + fishlink-chat-spec.md。
//   - 会話バブル：自分=右（青 #DCE9F8）／相手=左（白・枠）。各バブルは時刻のみ（日付はバブルに出さない）。
//   - 音声：renderVoiceBubble（▶＋プレイヤー＋秒数）。
//   - 画像：サムネのみ（「画像が送信されました」ラベルは付けない）。
//   - システム行（出来事＝承認/準備/配達/到着/遅延/完了）：中央寄せ・淡色・モノクロ線画アイコン（currentColor）。
//        通常＝青／遅延＝amber。絵文字は使わない。
//   - 日付区切り：中央の区切り線（曜日付き「6月4日（水）」）。
//
// メッセージ判定:
//   - statusKind（新形式）があればそれでシステム行に振り分け。
//   - 旧データ互換: type==='status'→completed / statusChange==='preparing'→prepare_start /
//     statusChange==='delivering'→ship_start。旧 delay/arrived（chat扱い）は通常バブルにフォールバック。

import { renderVoiceBubble, bindVoicePlayback } from '/js/voice-message.js';
import { asCachedImgAttrs } from '/js/image-cache.js';

// 6/18 #156 ④b: 音声バブルの再生トグル（▶/⏸）を document に委譲で1回束ねる。
//   delivery 両ページが本モジュールを import するため共通で効く（再描画後も有効）。
bindVoicePlayback();

const WEEKDAY = {
    ja: ['日', '月', '火', '水', '木', '金', '土'],
    en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    km: ['អា', 'ច', 'អ', 'ពុ', 'ព្រ', 'សុ', 'ស'],
};

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function lang() {
    return (typeof i18next !== 'undefined' && i18next.language) || 'km';
}

// モノクロ線画アイコン（currentColor で行の色を継ぐ・絵文字は使わない）
const STATUS_ICON = {
    approved: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polyline points="3.2 8.6 6.4 11.8 12.8 4.4"/></svg>',
    prepare_start: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.3 L13.7 5.3 V10.7 L8 13.7 L2.3 10.7 V5.3 Z"/><path d="M2.4 5.4 L8 8.3 L13.6 5.4"/><path d="M8 8.3 V13.6"/></svg>',
    ship_start: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.8 4.4 H9.4 V11 H1.8 Z"/><path d="M9.4 6.6 H12.2 L14.2 8.9 V11 H9.4 Z"/><circle cx="4.3" cy="12" r="1.25"/><circle cx="11.7" cy="12" r="1.25"/></svg>',
    delay: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8.3" r="5.4"/><path d="M8 5.2 V8.3 L10.3 9.7"/></svg>',
    arrived: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 14 C8 14 12.5 9.6 12.5 6.3 A4.5 4.5 0 0 0 3.5 6.3 C3.5 9.6 8 14 8 14 Z"/><circle cx="8" cy="6.3" r="1.6"/></svg>',
    completed: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polyline points="3.2 8.6 6.4 11.8 12.8 4.4"/></svg>',
};

// メッセージ → ステータス種別（システム行に振り分けるか判定）
export function statusKindOf(msg) {
    if (msg.statusKind && STATUS_ICON[msg.statusKind]) return msg.statusKind;
    // 旧データ互換
    if (msg.type === 'status') return 'completed';
    if (msg.statusChange === 'preparing') return 'prepare_start';
    if (msg.statusChange === 'delivering') return 'ship_start';
    return null;
}

function fmtDateSep(d) {
    const wd = (WEEKDAY[lang()] || WEEKDAY.en)[d.getDay()];
    if (lang() === 'ja') return `${d.getMonth() + 1}月${d.getDate()}日（${wd}）`;
    if (lang() === 'km') return `${d.getDate()}/${d.getMonth() + 1}（${wd}）`;
    return `${WEEKDAY.en[d.getDay()]}, ${d.getMonth() + 1}/${d.getDate()}`;
}

function fmtTime(d) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// 注文サマリ用の曜日付き納品日「6/4（水）」（カート/注文確認/Homeと統一）
export function fmtDeliveryDateShort(iso) {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return iso || '';
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const wd = (WEEKDAY[lang()] || WEEKDAY.en)[d.getDay()];
    return `${Number(m[2])}/${Number(m[3])}（${wd}）`;
}

function systemRow(kind, text, timeStr) {
    const isDelay = kind === 'delay';
    return `
        <div class="tl-sys ${isDelay ? 'warn' : ''}">
            <span class="tl-sys__ic">${STATUS_ICON[kind] || ''}</span>${escapeHtml(text)}${timeStr ? ` <span class="tl-sys__t">${escapeHtml(timeStr)}</span>` : ''}
        </div>`;
}

/**
 * Firestore の messages スナップショットを新デザインのタイムラインHTMLに描画する。
 * @param {QuerySnapshot} snap orders/{id}/messages（createdAt asc）
 * @param {string} myUid 自分のUID（＝バブルの右/青にする側。運営閲覧では買い手UIDを渡すと買い手=右/青・農家=左）
 * @param {object} [opts] 7/23 #216: opts.roleLabels={[uid]:label} を渡すと、第三者（運営）閲覧用に
 *   各会話/音声バブルの時刻へロール名（買い手/農家）を前置する。未指定なら従来どおり時刻のみ（delivery 両ページ）。
 * @returns {string} HTML
 */
export function renderChatTimelineHtml(snap, myUid, opts = {}) {
    const roleLabels = opts && opts.roleLabels ? opts.roleLabels : null;
    let html = '';
    let lastDateKey = null;
    snap.forEach(d => {
        const msg = d.data();
        const t = msg.createdAt?.toDate ? msg.createdAt.toDate() : null;
        const timeStr = t ? fmtTime(t) : '';
        const isSelf = msg.senderId === myUid;
        // 運営閲覧のみ：時刻に「買い手・」「農家・」を前置（roleLabels 指定時）。未指定なら時刻のみ。
        const roleLabel = roleLabels ? (roleLabels[msg.senderId] || '') : '';
        const timeLabel = roleLabel ? `${roleLabel}・${timeStr}` : timeStr;

        // 日付区切り（中央の区切り線・曜日付き）
        if (t) {
            const dateKey = `${t.getFullYear()}-${t.getMonth()}-${t.getDate()}`;
            if (dateKey !== lastDateKey) {
                html += `<div class="tl-datesep"><span>${escapeHtml(fmtDateSep(t))}</span></div>`;
                lastDateKey = dateKey;
            }
        }

        // システム行（出来事）＝中央寄せ・ロール名は付けない
        const kind = statusKindOf(msg);
        if (kind) {
            html += systemRow(kind, msg.text || '', timeStr);
            return;
        }

        // 音声
        if (msg.type === 'voice') {
            html += renderVoiceBubble(msg, isSelf, timeLabel);
            return;
        }

        // 会話バブル（テキスト／画像）。画像はサムネのみ・ラベルは付けない（送信側で空テキスト）。
        const imgs = msg.imageUrls || (msg.imageUrl ? [msg.imageUrl] : []);
        const imgHtml = imgs.map(url => `<img class="tl-chat__img" ${asCachedImgAttrs(url)} alt="">`).join('');
        const text = (msg.text || '').trim();
        html += `
            <div class="tl-chat ${isSelf ? 'self' : ''}">
                ${text ? `<div class="tl-chat__text">${escapeHtml(text)}</div>` : ''}
                ${imgHtml}
                <div class="tl-chat__time">${escapeHtml(timeLabel)}</div>
            </div>`;
    });
    return html;
}
