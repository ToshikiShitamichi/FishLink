// 2026-07-22 #212/#213: 運営管理画面の「2軸ステータス」導出（payment-spec §3.5）。
//
// 前払い（案B）では1件の注文が「配送の進行」と「お金（入金・送金）」の2軸を"同時に"持つ。
// 例：配送＝配送開始／入金＝入金確認待ち（1本の直線ステータスでは表せなかった状態）。
// 既存の order フィールドから2軸を導出する＝【新フィールドは追加しない】（第一候補・handoff #212/#213）。
// 買い手・農家の画面（§3.2）は簡易表示のまま＝2軸は運営（取引一覧・注文管理詳細）の作業ビュー専用。
//
//  配送軸: 農家確認中 → 準備開始 → 配送開始 → 受け取り完了 → 取引完了 ／ 例外 辞退・キャンセル
//  入金軸: 入金確認待ち → 入金確認済 → 農家送金待ち → 農家送金済 ／ 例外 未払い・お支払い未確認・返金済
//
// 導出の根拠（functions/index.js のフィールド意味・CLAUDE.md caseB-design §C と一致）：
//   status              pending/approved/preparing/delivering/completed/declined/cancelled（配送の進行）
//   prepaid             案B前払い注文（true=作成時にKHQR+ウォレットで支払い済み）
//   depositConfirmed    運営が銀行入金を目視照合済み（案B。cart で khqrAmount===0 のウォレット全額注文は作成時 true）
//   paymentUnconfirmed  運営が「お支払い未確認」にした（入金が見つからない・depositConfirmed と排他）
//   tradeCompleted      取引完了（autoCompleteTrades が配送完了+報告窓経過で立てる／送金解禁）
//   adminStatus         payment_confirmed → remitted → done（送金の状態機械・旧＆前払いの送金に共通）
//   paymentStatus       'paid'（旧＝受取時払いで買い手が払った合図）
//   refundedToWallet    全額ウォレット返金済み（辞退/承認前キャンセル/問題）
//   walletCancelRefunded 未確認キャンセルでウォレット充当分だけ即返金（部分返金マーカー）
//   paymentDeadline     旧（受取時払い）注文の入金期限（前払いには無い）

function _isRemitted(order) {
    return order.adminStatus === 'remitted' || order.adminStatus === 'done';
}
function _isRefunded(order) {
    return order.refundedToWallet === true || order.walletCancelRefunded === true;
}
function _deliveredish(order) {
    return order.status === 'completed' || order.status === 'delivered';
}

/**
 * 未払い（期限超過）＝旧（受取時払い）注文の未入金・期限超過。前払いには起きない。
 * ※index.html の従来 isOverdue と同一ロジック（前払いガードを明示追加）。
 */
export function isOverdue(order) {
    if (!order) return false;
    if (order.prepaid === true) return false;      // 前払いは作成時に支払い済み＝期限超過の概念なし
    if (!_deliveredish(order)) return false;
    if (order.paymentStatus === 'paid') return false;
    if (['payment_confirmed', 'remitted', 'done'].includes(order.adminStatus)) return false;
    const dl = order.paymentDeadline?.toMillis?.() || 0;
    return dl > 0 && Date.now() > dl;
}

/**
 * 成立した取引か（KPI・分析の金額集計はこれが true のものだけ＝辞退・キャンセルは除外・1-5）。
 * ※取引数（件数）は全件で数える。金額（流通総額・手数料）だけ成立ベースにする。
 */
export function isSettledTransaction(order) {
    if (!order) return false;
    return order.status !== 'cancelled' && order.status !== 'declined';
}

/**
 * 配送軸キー。値: farmerConfirming | preparing | shipping | received | tradeDone | declined | cancelled
 *   i18n ラベル = admin.axis.delivery.<key>。フィルタ chip も同じキーを使う。
 */
export function deliveryAxisKey(order) {
    if (!order) return 'farmerConfirming';
    const s = order.status;
    if (s === 'cancelled') return 'cancelled';
    if (s === 'declined') return 'declined';
    if (_deliveredish(order)) {
        // 取引完了＝自動確定(tradeCompleted) or 送金済(adminStatus)／それ以前＝受け取り完了（お届け済み）
        if (order.tradeCompleted === true || _isRemitted(order)) return 'tradeDone';
        return 'received';
    }
    if (s === 'delivering') return 'shipping';
    if (s === 'preparing') return 'preparing';
    // pending / approved ＝ 農家がまだ配送を前に進めていない（承認待ち／承認直後）＝運営は配送軸を「見る」だけ
    return 'farmerConfirming';
}

/**
 * 入金軸キー。値: waitDeposit | depositOk | remitWait | remitted | unconfirmed | unpaid | refunded
 *   i18n ラベル = admin.axis.payment.<key>。フィルタ chip も同じキーを使う。
 *   運営 To-Do = waitDeposit（今日確認すべき入金）／remitWait（配送完了＋入金確認済＝送金すべき）。
 */
export function paymentAxisKey(order) {
    if (!order) return 'waitDeposit';
    // 例外を先に判定
    if (order.status === 'cancelled' || order.status === 'declined') return 'refunded';
    if (_isRefunded(order)) return 'refunded';
    if (_isRemitted(order)) return 'remitted';           // 農家送金済
    if (isOverdue(order)) return 'unpaid';               // 未払い（期限超過・旧受取時払い）
    // 問題報告あり＝送金保留中（運営の「農家送金待ち」To-Do から外す＝誤送金を防ぐ・CLAUDE 継続課題#2）。
    //   ※未送金(_isRemitted 済は上で return)・未返金(_isRefunded 済も上で return)の保留だけがここに来る。
    if (order.paymentProblemHold === true) return 'onHold';   // 確認中（保留）

    if (order.prepaid === true) {
        if (order.paymentUnconfirmed === true) return 'unconfirmed';   // お支払い未確認（運営が確認できず）
        if (order.depositConfirmed === true) {
            // 入金確認済。配送完了していれば「農家送金待ち」（運営 To-Do＝送金する）
            return _deliveredish(order) ? 'remitWait' : 'depositOk';
        }
        return 'waitDeposit';                            // 入金確認待ち（前払い・未照合）
    }

    // 旧（受取時払い）: adminStatus ベース
    if (order.adminStatus === 'payment_confirmed') {
        return _deliveredish(order) ? 'remitWait' : 'depositOk';
    }
    return 'waitDeposit';                                // 旧・未確認は「入金確認待ち」扱い
}

/** その入金軸キーが運営 To-Do（アンバー強調）か。 */
export function isPaymentTodo(key) {
    return key === 'waitDeposit' || key === 'remitWait';
}
/** その入金軸キーが警告（赤）か。 */
export function isPaymentWarn(key) {
    return key === 'unpaid' || key === 'unconfirmed';
}
/** その配送軸キーが例外（赤）か。 */
export function isDeliveryException(key) {
    return key === 'declined' || key === 'cancelled';
}

// フィルタ用のキー一覧（すべて＝先頭・「すべて」は各画面で別扱い）。
export const DELIVERY_AXIS_KEYS = ['farmerConfirming', 'preparing', 'shipping', 'received', 'tradeDone', 'declined', 'cancelled'];
export const PAYMENT_AXIS_KEYS = ['waitDeposit', 'depositOk', 'remitWait', 'remitted', 'onHold', 'unconfirmed', 'unpaid', 'refunded'];
