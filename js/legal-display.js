// 7/4 #190: 利用規約・プライバシーポリシーの Firestore 駆動表示（FAQ #144 と同じ発想）。
//   - コレクション `legal`、doc id = 'terms' | 'privacy'（固定2ドキュメント）。
//   - フィールド：draft{ja,en,km}{title,body}（管理画面で編集中）／pub{...同}（公開版＝ユーザー表示）／
//     pubLangs{ja,en,km}(bool・言語別公開・7/23 #217)／effectiveDate{ja,en,km}('YYYY-MM-DD'・施行日の編集値=下書き側)／
//     pubEffectiveDate{ja,en,km}(公開版の施行日＝公開時のみ昇格・ユーザー表示はこれ)／
//     published(bool・「いずれかの言語が公開なら true」を維持＝firestore.rules 変更不要)／updatedAt（公開時のサーバ時刻）。
//   - 7/23 #217: ユーザーは pubLangs[l]==true の言語の pub を読む。フォールバック順＝lang→km→en
//     （日本語は運営用なのでフォールバック先にしない）。旧 doc（published(bool)のみ）は pub 本文の有無で
//     公開言語を推定して後方互換。表示言語が未公開なら公開済みの別言語（km→en）＋「準備中」注記。
//   - まだ運営が公開していない（doc 無し／未公開）ときは DEFAULT_LEGAL（現行 日本語ドラフト）に
//     フォールバックする＝リグレッションなし（従来の静的表示を維持）。
//
// ⚠️ 本文の描画は textContent（白ホワイトスペース pre-wrap）で行う＝改行を保持しつつ XSS 安全。

import { db } from '/js/firebase-config.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';

// 現行の日本語ドラフト本文（locales terms.*/privacy.* から移行）。「FISHLINK」表記に統一（#189/§8）。
//   用途＝(a) ユーザーページの未公開時フォールバック (b) 管理画面の初回プリフィル（移行の下訳元）。
//   他言語（en/km）は運営が管理画面の言語タブで用意する（当面は英語フォールバック＝範囲外）。
export const DEFAULT_LEGAL = {
    terms: {
        ja: {
            title: '利用規約',
            body: [
                '1. サービスについて',
                'FISHLINK は養殖農家とレストランをつなぎ、魚の売買を行うサービスです。本サービスを利用することで、本規約に同意したものとみなされます。',
                '',
                '2. アカウント',
                '利用者は自身のアカウント情報・パスワードの管理に責任を負います。登録情報は正確かつ真実である必要があります。',
                '',
                '3. 決済と中抜きの禁止',
                'すべての決済は FISHLINK を通じて行ってください。プラットフォームを介さない取引・場外決済は禁止であり、アカウント制限の対象となる場合があります。',
                '',
                '4. レビューと行動規範',
                '適切な表現をご利用ください。虚偽のレビュー・なりすまし・嫌がらせは削除され、アカウント制限の対象となる場合があります。',
                '',
                '5. 変更',
                '本規約は改定されることがあります。最新版はアプリ内に掲示します。',
            ].join('\n'),
        },
    },
    privacy: {
        ja: {
            title: 'プライバシーポリシー',
            body: [
                '1. 取得する情報',
                '表示名・電話番号・位置情報・取引情報など、サービス提供に必要な情報を取得します。',
                '',
                '2. 情報の利用目的',
                '売買のマッチング、通知の送信、決済・配送のサポートのために利用します。',
                '',
                '3. 第三者提供',
                '取引当事者間で必要な情報（例：配送のための位置情報）のみを共有します。情報を販売することはありません。',
                '',
                '4. 保管とセキュリティ',
                '情報は Firebase 上で安全に保管されます。データの保護に努めます。',
                '',
                '5. お問い合わせ',
                'プライバシーに関するご質問は FISHLINK 運営までご連絡ください。',
            ].join('\n'),
        },
    },
};

/** legal ドキュメント（{type}）を取得。存在しなければ null。未公開/権限なしも catch で null。 */
export async function loadLegalDoc(type) {
    try {
        const snap = await getDoc(doc(db, 'legal', type));
        return snap.exists() ? snap.data() : null;
    } catch (e) {
        console.warn('loadLegalDoc failed:', e?.message || e);
        return null;
    }
}

/**
 * 公開版テキストを言語フォールバックで取り出す（7/23 #217：lang→km→en の順・日本語は運営用でフォールバック先にしない）。
 * pubLangs[l]==true の言語だけを候補にする（旧 doc は published(bool) 時代の後方互換として pub 本文の有無で推定）。
 * @param {object} docData legal ドキュメントデータ
 * @param {string} lang 表示言語
 * @returns {{title:string, body:string, usedLang:(string|null), effectiveDate:(string|null)}}
 */
export function legalPubText(docData, lang) {
    const pub = (docData && docData.pub) || {};
    const pubEff = (docData && docData.pubEffectiveDate) || null;   // 公開時に確定した施行日（新モデル・ユーザー表示はこれ）
    const eff = (docData && docData.effectiveDate) || {};           // 旧モデル互換（pubEffectiveDate 無し doc のフォールバック）
    const pubLangs = (docData && docData.pubLangs) || null;
    // 公開判定：pubLangs があればそれ／無ければ旧 doc（pub 本文の有無で推定）。
    const isPub = (l) => pubLangs ? pubLangs[l] === true : !!(pub[l] && pub[l].body);
    // 日本語はフォールバック先にしない（運営用）。ユーザー言語 → クメール語 → 英語。
    const order = [];
    [lang, 'km', 'en'].forEach(l => { if (l && !order.includes(l)) order.push(l); });
    let usedLang = null;
    for (const l of order) {
        if (isPub(l) && pub[l] && (pub[l].body || pub[l].title)) { usedLang = l; break; }
    }
    if (!usedLang) return { title: '', body: '', usedLang: null, effectiveDate: null };
    // 施行日は公開版（pubEffectiveDate）を優先＝下書き保存では表示が変わらない。旧 doc は effectiveDate にフォールバック。
    const effectiveDate = pubEff ? (pubEff[usedLang] || null) : (eff[usedLang] || null);
    return {
        title: pub[usedLang].title || '',
        body: pub[usedLang].body || '',
        usedLang,
        effectiveDate,
    };
}

/** 施行日（'YYYY-MM-DD'）→ 'YYYY/MM/DD'。不正/空なら ''。 */
export function formatEffectiveDate(dateStr) {
    if (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return dateStr.replace(/-/g, '/');
    }
    return '';
}

/** updatedAt（Timestamp / millis / {seconds}）→「最終更新」に添える年月文字列。無ければ空。 */
export function formatUpdatedYearMonth(updatedAt, lang) {
    let ms = null;
    if (updatedAt && typeof updatedAt.toMillis === 'function') ms = updatedAt.toMillis();
    else if (typeof updatedAt === 'number') ms = updatedAt;
    else if (updatedAt && updatedAt.seconds != null) ms = updatedAt.seconds * 1000;
    if (ms == null) return '';
    const d = new Date(ms);
    const y = d.getFullYear(), m = d.getMonth() + 1;
    if (lang === 'ja') return `${y}年${m}月`;
    if (lang === 'km') return `${m}/${y}`;
    const en = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return `${en[d.getMonth()]} ${y}`;
}
