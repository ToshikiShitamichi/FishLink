// 承認期限・納品スロットの共通ロジック（2026-07-08 #196）
// ─────────────────────────────────────────────────────────────
// カンボジア時間（KHM = UTC+7）を「正」として計算する。
// 承認期限 = 注文 + 1.5h。ただしその期限が夜間（21:00–5:00）に入る場合は
// 「翌朝5:00起点」にリセット（= 5:00 + 1.5h = 6:30）。
//   → 夜間注文が農家の睡眠中に自動辞退で切れるのを防ぐ（delivery-timing 依頼③）。
// 納品スロット = 「承認期限 + 農家準備4h」以降・かつ「now + 最短8h」以降・かつ「now + 最長14日」以内。
//   → 早い注文は早朝配達OK／夜間注文は農家の朝準備が間に合わず早朝不可、が仕組みから自動で出る（依頼④）。
//
// ⚠️ この式は functions/index.js 側にも同一ロジックを複製している（Cloud Functions は
//    ブラウザ ES module を import できないため）。片方を変えたら必ず両方を揃えること。
//    複製箇所＝onOrderCreated（approveDeadline 保存）／autoDeclineExpiredOrders／
//    remindApproveDeadline／autoDeclineExpiredOrdersSweep。

// すべて運営パラメータ（将来 settings 化可能・現状はコード定数）。
// minLeadHours のみ既存 settings（leadTimeHours）から上書きされる（cart 側）。
export const DELIV_PARAMS = {
    minLeadHours: 8,        // 最短リードタイム（依頼①・既存 leadTimeHours）
    maxLeadDays: 14,        // 最長リードタイム（依頼②・新規）
    approvalLeadHours: 1.5, // 承認期限 = 注文 + 1.5h（依頼③）
    nightStartHour: 21,     // 夜間開始 21:00（含む）
    nightEndHour: 5,        // 夜間終了（翌朝）05:00（含まない＝5:00 は昼扱い）
    prepHours: 4,           // 農家準備 4h（依頼④）
};

const KHM_OFFSET_MS = 7 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// UTC ms → KHM の壁時計成分（getUTC*）。
export function khmParts(utcMs) {
    const d = new Date(utcMs + KHM_OFFSET_MS);
    return {
        y: d.getUTCFullYear(), mo: d.getUTCMonth(), day: d.getUTCDate(),
        h: d.getUTCHours(), mi: d.getUTCMinutes(),
    };
}

// KHM の壁時計（Y, Mo(0基点), D, h, mi）→ 実 UTC ms。
export function khmWallToUtcMs(y, mo, day, h, mi) {
    return Date.UTC(y, mo, day, h, mi, 0, 0) - KHM_OFFSET_MS;
}

// 注文時刻(ms) → 承認期限(ms)。夜間なら翌朝5:00起点にリセットして +1.5h（=6:30）。
export function computeApprovalDeadlineMs(orderMs, params = DELIV_PARAMS) {
    const p = params || DELIV_PARAMS;
    const raw = orderMs + p.approvalLeadHours * HOUR_MS;
    const k = khmParts(raw);
    const isNight = k.h >= p.nightStartHour || k.h < p.nightEndHour; // [21:00, 05:00)
    if (!isNight) return raw;
    // 夜間 → 「翌朝 nightEndHour(5:00)」を起点に。
    //   夕方以降(>= nightStartHour) は KHM 翌日の 5:00／深夜〜早朝(< nightEndHour) は KHM 同日の 5:00。
    let y = k.y, mo = k.mo, day = k.day;
    if (k.h >= p.nightStartHour) {
        const nd = new Date(Date.UTC(y, mo, day + 1)); // 月跨ぎを Date に任せる
        y = nd.getUTCFullYear(); mo = nd.getUTCMonth(); day = nd.getUTCDate();
    }
    const base = khmWallToUtcMs(y, mo, day, p.nightEndHour, 0);
    return base + p.approvalLeadHours * HOUR_MS;
}

// 選べる納品スロットの下限(ms) = max(now + 最短リード, 承認期限 + 準備)。
export function earliestDeliveryMs(nowMs, params = DELIV_PARAMS) {
    const p = params || DELIV_PARAMS;
    const byLead = nowMs + p.minLeadHours * HOUR_MS;
    const byPrep = computeApprovalDeadlineMs(nowMs, p) + p.prepHours * HOUR_MS;
    return Math.max(byLead, byPrep);
}

// 選べる納品スロットの上限(ms) = now + 最長リード。
export function latestDeliveryMs(nowMs, params = DELIV_PARAMS) {
    const p = params || DELIV_PARAMS;
    return nowMs + p.maxLeadDays * DAY_MS;
}

// 納品日(ISO "YYYY-MM-DD") + スロット開始時(整数h) → 実 UTC ms（KHM 壁時計として解釈）。
export function slotStartUtcMs(dateIso, startHour) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateIso || ''));
    if (!m) return NaN;
    return khmWallToUtcMs(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), startHour || 0, 0);
}

// UTC ms → KHM の "H:MM"（承認期限の表示用）。
export function formatKhmHm(utcMs) {
    const k = khmParts(utcMs);
    return `${k.h}:${String(k.mi).padStart(2, '0')}`;
}

// 納品日 ISO の上限（最長リード）を <input type="date" max> 用の "YYYY-MM-DD" で返す。
export function maxDeliveryDateIso(nowMs, params = DELIV_PARAMS) {
    const k = khmParts(latestDeliveryMs(nowMs, params));
    return `${k.y}-${String(k.mo + 1).padStart(2, '0')}-${String(k.day).padStart(2, '0')}`;
}
