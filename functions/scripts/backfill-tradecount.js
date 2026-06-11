// 6/10 #137/#138: users/{uid}.tradeCount（取引完了の累計件数）の一回限りバックフィル。
//
// 背景：レストランページ／生産者ページの「取引N件」（信頼ブロックの核・spec §5）は、
//   セキュリティルール上クライアントから他者の注文を集計できないため、サーバ集計フィールド
//   users.tradeCount を参照する。今後の完了は onOrderUpdated（functions/index.js）が +1 するが、
//   このスクリプトは「既存の完了済み注文」を一度だけ集計して初期値を埋める。
//
// 仕様：
//   - 取引完了＝orders.status === 'completed'（辞退/キャンセル= 'declined' 等は数えない）。
//   - 1注文につき farmerId と restaurantId の双方に +1。
//   - ⚠️ ライブ集計（onOrderUpdated）と同じ「increment + 注文ドキュメントの一度きりマーカー tradeCounted」
//     方式をトランザクションで使う。これにより：
//       (a) 再実行しても tradeCounted 済みはスキップ＝冪等。
//       (b) ライブ集計と同時に走っても同一注文を二重計上しない（Firestore のトランザクションが
//           注文ドキュメント単位で直列化＝先に立てた方が勝ち・もう一方はマーカーを見てスキップ）。
//       絶対値 SET ではないので「SET vs increment のレース（ライブ +1 を上書きで失う）」が起きない。
//
// 【通常は admin/settings.html の「取引数（取引N件）を集計」ボタン（callable backfillTradeCount）を使う。】
//   本スクリプトは UI 不可・大量データ（callable は 540 秒上限）時のフォールバック。callable と同一ロジック。
//
// 実行方法（functions ディレクトリで）：
//   # サービスアカウント鍵を使う場合（PowerShell）：$env:GOOGLE_APPLICATION_CREDENTIALS="path\to\serviceAccount.json"
//   node scripts/backfill-tradecount.js
//   # 確認のみ（書き込みなし）
//   node scripts/backfill-tradecount.js --dry-run

const admin = require('firebase-admin');

const DRY_RUN = process.argv.includes('--dry-run');

if (!admin.apps.length) {
    admin.initializeApp(); // ADC / GOOGLE_APPLICATION_CREDENTIALS を使用
}
const db = admin.firestore();

async function main() {
    console.log(`[backfill-tradecount] start${DRY_RUN ? ' (DRY RUN — no writes)' : ''}`);

    // 取引完了の注文をすべて取得
    const snap = await db.collection('orders').where('status', '==', 'completed').get();
    console.log(`[backfill-tradecount] completed orders: ${snap.size}`);

    if (DRY_RUN) {
        // まだ集計していない（tradeCounted 未設定）注文だけを当事者ごとに加算して表示
        const counts = new Map();
        const bump = (uid) => { if (uid) counts.set(uid, (counts.get(uid) || 0) + 1); };
        let alreadyMarked = 0;
        snap.forEach((d) => {
            const o = d.data() || {};
            if (o.tradeCounted === true) { alreadyMarked++; return; }
            bump(o.farmerId);
            bump(o.restaurantId);
        });
        for (const [uid, c] of counts) console.log(`  ${uid}: +${c}`);
        console.log(`[backfill-tradecount] would update ${counts.size} users; already-marked orders skipped: ${alreadyMarked}`);
        console.log('[backfill-tradecount] dry run complete — no writes performed');
        return;
    }

    // 各完了注文を「マーカー付きトランザクション」で処理（冪等・ライブ集計と composable）
    let counted = 0, skipped = 0, failed = 0;
    for (const docSnap of snap.docs) {
        const oref = docSnap.ref;
        const res = await db.runTransaction(async (tx) => {
            const o = await tx.get(oref);
            if (!o.exists) return false;
            const data = o.data() || {};
            if (data.tradeCounted === true) return false; // 集計済み（再実行 or ライブが先に処理）
            const inc = admin.FieldValue.increment(1);
            if (data.farmerId) tx.set(db.doc(`users/${data.farmerId}`), { tradeCount: inc }, { merge: true });
            if (data.restaurantId) tx.set(db.doc(`users/${data.restaurantId}`), { tradeCount: inc }, { merge: true });
            tx.update(oref, { tradeCounted: true });
            return true;
        }).catch((e) => { console.error('  tx failed for order', docSnap.id, e); return null; });

        if (res === true) counted++;
        else if (res === false) skipped++;
        else failed++;

        if ((counted + skipped + failed) % 200 === 0) {
            console.log(`[backfill-tradecount] progress: counted=${counted} skipped=${skipped} failed=${failed}`);
        }
    }

    console.log(`[backfill-tradecount] done — counted=${counted} skipped(already)=${skipped} failed=${failed}`);
}

main().then(() => process.exit(0)).catch((err) => {
    console.error('[backfill-tradecount] failed:', err);
    process.exit(1);
});
