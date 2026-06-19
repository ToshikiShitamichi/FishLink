// 6/17 #150: 問題報告の「入口出し分け」共通ロジック。
//   報告できる期間＝配送完了時刻（order.completedAt）＋N時間（運営パラメータ reportWindowHours・既定4）。
//   ・期限内のみ入口ボタンを表示／期限切れは非表示（→運営チャットへ）。
//   ・1注文1オープン：報告中は入口を「報告済み・対応中」にして再送信不可。
//     オープン状態は注文ドキュメントのマーカー（restaurantReportOpen / farmerReportOpen）で判定する
//     （reports コレクションを各注文ごとに読まずに済む＝フィードの追加クエリを避ける）。
import { db } from '/js/firebase-config.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';

// 報告受付時間（時間）。settings/campaign.reportWindowHours（admin/settings.html で設定・public read）。
//   未設定/不正は立ち上げ値 4。モジュール内に1回だけキャッシュ。
let _hoursCache = null;
export async function getReportWindowHours() {
    if (_hoursCache != null) return _hoursCache;
    try {
        const snap = await getDoc(doc(db, 'settings', 'campaign'));
        const v = snap.exists() ? snap.data().reportWindowHours : null;
        _hoursCache = (typeof v === 'number' && v > 0) ? v : 4;
    } catch (e) {
        _hoursCache = 4;
    }
    return _hoursCache;
}

// Timestamp / millis 数値 / {seconds} / {toMillis}（render-cache 復元）→ millis
function toMillis(v) {
    if (!v) return null;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v === 'number') return v;
    if (v.seconds != null) return v.seconds * 1000;
    return null;
}

// 配送完了時刻（millis）。
//   functions が completed 遷移時に order.completedAt をセットする（6/17 #150）。
//   completedAt 未設定の既存注文は paymentDeadline（= 完了時刻+10分）から逆算してフォールバック。
//   どちらも無い瞬間（completed 直後・functions 反映前の一瞬）だけ null を返す。
function completedMillis(order) {
    const c = toMillis(order?.completedAt);
    if (c != null) return c;
    const p = toMillis(order?.paymentDeadline);
    if (p != null) return p - 10 * 60 * 1000;
    return null;
}

/**
 * 報告入口の状態を計算する。
 * @param {object} order  注文データ（status / completedAt / {role}ReportOpen を含む）
 * @param {'restaurant'|'farmer'} role  報告者の役割
 * @param {number} hours  報告受付時間（getReportWindowHours の値）
 * @returns {{show:boolean, phase:'active'|'window'|'reported'|'hidden', deadlineMs:(number|null)}}
 *   phase: 'reported'＝既にオープンな報告あり（報告済み・対応中）／'window'＝配送完了後の期限内（締切表示）／
 *          'active'＝配送中（締切前・農家のみ・締切表示なし）／'hidden'＝入口を出さない。
 */
export function computeReportEntry(order, role, hours) {
    const status = order?.status;
    const reportOpen = (role === 'restaurant') ? order?.restaurantReportOpen === true
        : order?.farmerReportOpen === true;
    const isActive = ['approved', 'preparing', 'delivering'].includes(status);
    const isCompleted = ['completed', 'delivered'].includes(status);
    if (!isActive && !isCompleted) return { show: false, phase: 'hidden', deadlineMs: null };
    if (reportOpen) return { show: true, phase: 'reported', deadlineMs: null };

    const completedMs = completedMillis(order);
    if (isCompleted && completedMs) {
        const deadlineMs = completedMs + (hours * 60 * 60 * 1000);
        if (Date.now() > deadlineMs) return { show: false, phase: 'hidden', deadlineMs };
        return { show: true, phase: 'window', deadlineMs };
    }
    // 配送中（締切前）または completed だが completedAt 未設定（functions 遅延の一瞬）
    return { show: true, phase: 'active', deadlineMs: null };
}

// 締切メッセージ（カンボジア時間 UTC+7・本日/明日/日付）。i18next（グローバル）を使用。
//   restaurant は「（その後 農家へ送金されます）」を付す（送金保留連動）。farmer は付さない。
export function reportDeadlineText(deadlineMs, role) {
    if (!deadlineMs) return '';
    const toKhm = (ms) => new Date(ms + 7 * 60 * 60 * 1000); // KHM の各成分を getUTC* で読む
    const dl = toKhm(deadlineMs);
    const now = toKhm(Date.now());
    const tom = toKhm(Date.now() + 24 * 60 * 60 * 1000);
    const sameDay = (a, b) => a.getUTCFullYear() === b.getUTCFullYear()
        && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
    const time = `${dl.getUTCHours()}:${String(dl.getUTCMinutes()).padStart(2, '0')}`;
    let base;
    if (sameDay(dl, now)) base = i18next.t('report.entryDeadlineToday', { time });
    else if (sameDay(dl, tom)) base = i18next.t('report.entryDeadlineTomorrow', { time });
    else base = i18next.t('report.entryDeadlineDate', { date: `${dl.getUTCMonth() + 1}/${dl.getUTCDate()}`, time });
    if (role === 'restaurant') base += i18next.t('report.entryDeadlineRemitSuffix');
    return base;
}
