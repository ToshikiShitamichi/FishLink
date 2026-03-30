import { auth, db } from './firebase-config.js';
import { doc, updateDoc } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';

const SUPPORTED_LANGS = ['km', 'en', 'ja'];
const DEFAULT_LANG = 'km'; // カンボジアユーザーがメインのためクメール語をデフォルト

// 保存済みの言語を取得（なければデフォルト）
function getSavedLang() {
    return localStorage.getItem('fishlink_lang') || DEFAULT_LANG;
}

function saveLang(lang) {
    localStorage.setItem('fishlink_lang', lang);
}

// i18next 初期化
async function initI18n() {
    const lang = getSavedLang();
    const res = await fetch(`/locales/${lang}.json`);
    const translations = await res.json();

    await i18next.init({
        lng: lang,
        fallbackLng: 'en',
        resources: { [lang]: { translation: translations } },
        interpolation: { escapeValue: false }
    });

    // クメール語フォント切り替え用
    document.body.setAttribute('data-lang', lang);

    applyTranslations();
}

// data-i18n 属性を持つ要素にテキストを適用
function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const attr = el.getAttribute('data-i18n-attr'); // placeholder等の属性に適用する場合
        const text = i18next.t(key);
        if (attr) {
            el.setAttribute(attr, text);
        } else {
            el.textContent = text;
        }
    });
}

// 言語切り替え（セレクター変更時に呼び出す）
async function changeLanguage(lang) {
    if (!SUPPORTED_LANGS.includes(lang)) return;

    // 翻訳ファイルを追加ロード
    const res = await fetch(`/locales/${lang}.json`);
    const translations = await res.json();
    i18next.addResourceBundle(lang, 'translation', translations, true, true);

    await i18next.changeLanguage(lang);
    saveLang(lang);
    document.body.setAttribute('data-lang', lang);
    applyTranslations();

    // ログイン済みならFirestoreにも保存
    if (auth.currentUser) {
        await updateDoc(doc(db, 'users', auth.currentUser.uid), { lang });
    }
}

// 言語セレクターの初期値セットとイベント登録
function initLangSelector() {
    const selector = document.getElementById('lang-selector');
    if (!selector) return;
    selector.value = getSavedLang();
    selector.addEventListener('change', (e) => changeLanguage(e.target.value));
}

export { initI18n, initLangSelector, saveLang, applyTranslations };