// 6/14 #144: 運営チャット振り分け（②）で使うユーザー側 FAQ 表示コンポーネント。
//
// 設計の正本は docs/design/fishlink-support-chat-mockup.html（②）+ fishlink-support-chat-spec.md（§4/§7/§9）。
//   - カテゴリ選択後に「そのカテゴリの公開FAQ」をリスト表示（質問タップで回答＋画像が展開）。
//   - 0件なら省略（呼び出し側で件数を見てセクションごと隠す）。
//   - 表示言語＝ユーザーの選択言語（i18n.{km,en,ja}）。未登録言語は km→en→ja の順でフォールバック。
//
// データ：faq { category, i18n{km:{question,answer},en,ja}, images[], published, order, createdAt }
//   - ユーザー側クエリは where(category==X) AND where(published==true)（equality×2・orderBy なし）。
//     → 複合インデックス不要（単一フィールドインデックスの merge join）。並び順 order はクライアントでソート。

import { db } from '/js/firebase-config.js';
import {
    collection, query, where, getDocs
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { asCachedImgAttrs } from '/js/image-cache.js';

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// i18n からユーザー言語の {question, answer} を取り出す（フォールバック km→en→ja）。
export function faqText(faq, lang) {
    const i18n = faq.i18n || {};
    const order = [lang, 'km', 'en', 'ja'];
    let question = '', answer = '';
    for (const l of order) {
        const e = i18n[l];
        if (!question && e?.question) question = e.question;
        if (!answer && e?.answer) answer = e.answer;
        if (question && answer) break;
    }
    return { question, answer };
}

/**
 * 指定カテゴリの公開FAQを取得（公開のみ・order 昇順）。
 * @param {string} category カテゴリコード（§3）
 * @returns {Promise<Array>} faq ドキュメント配列（{id, ...data}）
 */
export async function loadFaqs(category) {
    if (!category) return [];
    try {
        const snap = await getDocs(query(
            collection(db, 'faq'),
            where('category', '==', category),
            where('published', '==', true)
        ));
        return snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    } catch (e) {
        console.warn('loadFaqs failed:', e?.message || e);
        return [];
    }
}

/**
 * FAQ アコーディオンの HTML を生成する。質問のみ表示・回答は折りたたみ。
 * @param {Array} faqs loadFaqs の結果
 * @param {string} lang ユーザー言語
 * @returns {string} HTML（0件なら空文字）
 */
export function renderFaqAccordionHtml(faqs, lang) {
    if (!faqs || faqs.length === 0) return '';
    const items = faqs.map((faq, i) => {
        const { question, answer } = faqText(faq, lang);
        if (!question) return '';
        const imgs = Array.isArray(faq.images) ? faq.images : [];
        const imgHtml = imgs.map(url =>
            `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="faqd-img"><img ${asCachedImgAttrs(url)} alt=""></a>`
        ).join('');
        return `
            <div class="faqd-item" data-faqd-index="${i}">
                <button type="button" class="faqd-qrow" aria-expanded="false">
                    <span class="material-symbols-outlined faqd-caret">chevron_right</span>
                    <span class="faqd-q">${escapeHtml(question)}</span>
                </button>
                <div class="faqd-ans" hidden>${escapeHtml(answer).replace(/\n/g, '<br>')}${imgHtml ? `<div class="faqd-imgs">${imgHtml}</div>` : ''}</div>
            </div>`;
    }).join('');
    return `<div class="faqd-list">${items}</div>`;
}

/**
 * アコーディオンの開閉をバインドする（renderFaqAccordionHtml を挿入した親要素に対して呼ぶ）。
 */
export function bindFaqAccordion(container) {
    if (!container) return;
    container.querySelectorAll('.faqd-qrow').forEach(btn => {
        btn.addEventListener('click', () => {
            const item = btn.closest('.faqd-item');
            const ans = item?.querySelector('.faqd-ans');
            const caret = btn.querySelector('.faqd-caret');
            if (!ans) return;
            const open = ans.hasAttribute('hidden');
            if (open) {
                ans.removeAttribute('hidden');
                btn.setAttribute('aria-expanded', 'true');
                if (caret) caret.textContent = 'expand_more';
            } else {
                ans.setAttribute('hidden', '');
                btn.setAttribute('aria-expanded', 'false');
                if (caret) caret.textContent = 'chevron_right';
            }
        });
    });
}
