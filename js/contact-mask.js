// 6/3 #120: 連絡先（電話番号・SNSアカウント・URL）の自動マスク。
// 中抜き（プラットフォーム外取引）対策。公開Q&A と 配送管理チャット の両方で共用。
//
// 方針：
//   - クライアント側で投稿前に検知 → 伏字に置換 + 警告表示。
//   - サーバ側（functions）でも同等ロジックで再検知（バイパス防止）。＝ functions/index.js に同一ロジックの CJS 版。
//   - 検知精度（クメール語の電話表記・全角/区切り違い等）は次フェーズ。

// 全角英数字・記号を半角へ正規化（全角での回避を防ぐ）
function normalizeWidth(s) {
    return String(s ?? '').replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
        .replace(/　/g, ' ');
}

// URL / ドメイン
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const DOMAIN_RE = /\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|io|me|info|biz|co|kh|app|link|page|shop|xyz|online|site|gg|ru)\b(?:\/\S*)?/gi;
// SNS ハンドル（@xxx）／メッセージアプリの招待リンク
const HANDLE_RE = /@[A-Za-z0-9_.]{2,}/g;
const MSG_APP_RE = /\b(?:t\.me|wa\.me|telegram|whats?app|wechat|line\s*id|messenger|facebook\.com|fb\.com|instagram)\b\S*/gi;
// 電話番号：区切り（- . space ()）を含む数字列で、数字が 8 桁以上
const PHONE_RE = /\+?\d[\d\-.\s()]{6,}\d/g;

function digitCount(s) {
    const m = String(s).match(/\d/g);
    return m ? m.length : 0;
}

/**
 * テキストから連絡先を検知してマスクする。
 * @param {string} text 入力本文
 * @param {string} placeholder 伏字に使う文字列（既定：［連絡先は非表示］）
 * @returns {{ masked: string, hit: boolean }}
 */
export function maskContacts(text, placeholder = '［連絡先は非表示］') {
    if (!text) return { masked: text, hit: false };
    let hit = false;
    let out = normalizeWidth(text);

    // 日付（ISO/スラッシュ区切り）は電話番号と誤検知しやすいので除外
    const DATE_LIKE = /^\s*\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\s*$/;
    const apply = (re, opts = {}) => {
        out = out.replace(re, (match) => {
            // 電話番号は数字桁数で誤検知を抑制 + 日付は除外
            if (opts.minDigits && (digitCount(match) < opts.minDigits || DATE_LIKE.test(match))) return match;
            hit = true;
            return placeholder;
        });
    };

    apply(URL_RE);
    apply(MSG_APP_RE);
    apply(DOMAIN_RE);
    apply(HANDLE_RE);
    apply(PHONE_RE, { minDigits: 8 });

    return { masked: out, hit };
}
