// 注文まわりの共通ヘルパー
// - items[] スキーマと legacy 単一itemスキーマの両方を扱えるようにする
// - 料金計算ロジックを一元化

// 2026-07-04 #191: KHR金額は「100リエル単位（100の倍数）」に統一する（payment-spec §4.2）。
//   端数を生む「手数料・割引（％計算）＝serviceFee / campaignDiscount /
//   farmerCommissionGross / farmerCampaignDiscount」と、距離×レートで端数が出る「配送料」を、
//   100リエル未満で切り捨てる（四捨五入でなく floor＝手数料が約束の率〔標準5%〕を絶対に超えないため）。
//   単価（KHR/kg）・送料(per10km)は入力側（post.html / account/delivery.html）で100刻み＋保存時 floor に揃える
//   ＝魚代＝単価×整数kg は自動で100単位。よって切り捨てるのはこの数行だけで、subtotal/totalAmount/
//   farmerReceiveAmount/khqrAmount/ウォレット返金がすべて自動で100リエル単位に揃う。
export function floor100(n) {
    return Math.floor((Number(n) || 0) / 100) * 100;
}

// 2026-07-15 #208: 買い手が見る「表示単価」（KHR/kg）の1行分を出す共通プリミティブ。
//   買い手表示価格 = 農家価格 ×(1 + 手数料率) を 100リエル未満で切り捨て（#191 の表示レイヤー適用）。
//   例: 7,500×1.05=7,875 → 7,800 ／ 7,000×1.05=7,350 → 7,300 ／ 500×1.05=525 → 500。
//   ※ 農家側の表示（投稿一覧等・手数料をかけない）は対象外。
//
// 2026-07-17 #210①: この関数は「表示専用」ではなく【課金の基準】でもある。
//   calcItemPrices が serviceFee をこの表示単価から逆算するため、次の恒等式が常に成立する：
//     fishPrice + serviceFee === buyerUnitPrice(...) × quantity
//   ＝買い手が見ている単価 × 数量 が、そのまま明細の小計になる（買い手が検算して必ず合う）。
//   ⚠ よってこの関数の丸め方を変えると課金額そのものが変わる。表示だけの都合で触らないこと。
export function buyerDisplayUnitPrice(baseFarmerKhr, serviceRate) {
    return floor100((Number(baseFarmerKhr) || 0) * (1 + (Number(serviceRate) || 0)));
}

// 2026-07-19 #210①-2: 買い手表示単価は【％計算の“行”ごとに切り捨ててから足す】（payment-spec §4.2）。
//   ⚠ 魚の単価と内臓処理は別々の行なので、合算してから1回だけ切り捨ててはいけない。
//     正: floor100(7,500×1.05)=7,800 ＋ floor100(500×1.05)=500 → 8,300（外すと −500）
//     誤: floor100((7,500+500)×1.05)=floor100(8,400)=8,400   → 外すと −600 になり
//         「内臓処理の減額＝525→切り捨て500」という運営ルールとも、モックの表示とも食い違う。
//   正本 docs/design/fishlink-cart-mockup.html が決着：品2「5,700 KHR/kg（内臓処理なし）/ 戻すと +500」＝
//     行ごと切り捨て（5,700+500=6,200）でしか一致しない（合算方式は 6,300 になる）。
//   ＝内臓処理の「外すと −N / 戻すと +N」ヒントは buyerDisplayUnitPrice(gutPrice, rate) そのものでよい
//     （この関数が行ごとの加算で組み立てているため、ヒントと実際の単価変化が構造的に必ず一致する）。
//   ⚠ 買い手が単価を見る画面はすべてこの関数を通すこと（画面ごとに素の ×(1+rate) を出さない）。
export function buyerUnitPrice(priceKhr, gutPriceKhr, gutIncluded, serviceRate) {
    const base = buyerDisplayUnitPrice(priceKhr, serviceRate);
    const gut = (gutIncluded && Number(gutPriceKhr))
        ? buyerDisplayUnitPrice(gutPriceKhr, serviceRate) : 0;
    return base + gut;
}

/**
 * 注文ドキュメントから items[] 配列を取得。
 * items[] が存在する新方式ならそのまま返す。
 * 存在しない legacy 単一item注文は items[0] 相当を合成して返す。
 */
export function getOrderItems(order) {
    if (!order) return [];
    if (Array.isArray(order.items) && order.items.length > 0) {
        return order.items;
    }
    // legacy: 単一item 扱い
    return [{
        listingId: order.listingId || null,
        quantity: order.quantity || 0,
        gutProcessing: order.gutProcessing || false,
        fishPrice: order.fishPrice || 0,
        serviceFee: order.serviceFee || 0,
        campaignDiscount: order.campaignDiscount || 0,
        farmerCommission: order.farmerCommission || 0,
        farmerCommissionGross: order.farmerCommissionGross || 0,
        farmerCampaignDiscount: order.farmerCampaignDiscount || 0,
        farmerReceiveAmount: order.farmerReceiveAmount || 0,
        snapFishType: order.snapFishType || null,
        snapSize: order.snapSize || null,
        snapPhotoUrl: order.snapPhotoUrl || null,
        snapPrice: order.snapPrice ?? null,
        snapGutPrice: order.snapGutPrice ?? null,
    }];
}

/**
 * 単一itemの料金計算。
 * 引数: listing（fishListings の該当doc）, quantity, gutProcessing, 料率群
 * 戻り値: { fishPrice, serviceFee, campaignDiscount, farmerCommission, farmerCommissionGross,
 *          farmerCampaignDiscount, farmerReceiveAmount }
 *
 * 2026-07-17 #210①: 買い手側の恒等式（これを壊さないこと）
 *   fishPrice + serviceFee === buyerDisplayUnitPrice(unitPrice, serviceRate) × quantity
 *   ＝カート／注文確認に出す「表示単価 × 数量」が、そのまま行小計になる（buyerUnit は100の倍数なので
 *     小計・魚代・キャンペーン割引・合計まで自動で100リエル単位に揃う／payment-spec §4.2）。
 *   ⚠ 農家側（farmerCommissionGross / farmerCampaignDiscount / farmerCommission / farmerReceiveAmount）は
 *     従来どおり fishPrice（＝農家の素の単価×数量）ベース＝買い手側の丸めとは別勘定。混ぜないこと。
 */
export function calcItemPrices({
    listing, quantity, gutProcessing,
    serviceRate, campaignActive, campaignDiscountRate,
    farmerRate, farmerCampaignActive, farmerCampaignDiscountRate,
}) {
    const price = listing.price || 0;
    const gutPrice = listing.gutPrice || 0;
    const unitPrice = gutProcessing ? price + gutPrice : price;
    const fishPrice = unitPrice * quantity;

    // 2026-07-17 #210①: 手数料は「買い手に見えている表示単価」から逆算する（＝単価×数量＝小計を保証）。
    //   旧実装は serviceFee = floor100(fishPrice × rate) で、％の結果だけを丸めていた。
    //   これだと「表示単価は丸めたのに、小計は丸める前の値で計算される」ズレが出る：
    //     例) 単価7,000・rate5%・10kg → 表示単価は floor100(7,350)=7,300 なのに
    //         小計は 70,000 + floor100(3,500)=3,500 → 73,500（買い手の検算 7,300×10=73,000 と合わない）。
    //   数量1では見えず、数量2以上で必ず露見する（実機のスポットパンガシウスで発覚）。
    //   → 表示単価 buyerUnit × quantity を「買い手が払う魚代」の正とし、その差分を手数料に載せる。
    //   これで恒等式 fishPrice + serviceFee === buyerUnit × quantity が常に成立する。
    //   ⚠ fishPrice（農家の基準額＝単価×数量）は動かさない＝農家の受取額計算は一切変わらない。
    //   ⚠ #210①-2: 魚の単価と内臓処理は【別々の行】としてそれぞれ切り捨ててから足す（buyerUnitPrice）。
    //     合算してから1回だけ切り捨てると、内臓処理を外したときの減額が運営ルール（525→切り捨て500）と
    //     ずれる（8,400−7,800=600 になる）。cart-mockup 品2「戻すと +500」が行ごと方式でしか成立しない。
    const buyerUnit = buyerUnitPrice(price, gutPrice, gutProcessing, serviceRate);
    //   Math.max(0,...) のガード: 手数料率が極小(0含む)かつ単価が100の倍数でない legacy 出品だと、
    //   buyerUnit（切り捨て）が unitPrice を下回り差分が負になりうる（例 単価7,350・rate0 → 7,300）。
    //   手数料がマイナス＝買い手に値引きすることになるので0で止める。
    const serviceFee = Math.max(0, buyerUnit * quantity - fishPrice);
    // 6/21 #163①: 買い手のキャンペーン割引は「魚代」（＝手数料込みの表示価格 fishPrice + serviceFee）ベース。
    //   旧実装は fishPrice（手数料前の農家価格）ベースで、買い手画面の「魚代から2.5%」文言と検算が合わなかった
    //   （例 魚代31,500×2.5%＝788 にすべきところ 30,000×2.5%＝750 になっていた）。
    //   ⚠️ 農家側の farmerCampaignDiscount（手数料の実削減）は fishPrice ベースのまま＝別物なので触らない。
    const campaignDiscount = campaignActive ? floor100((fishPrice + serviceFee) * (campaignDiscountRate || 0)) : 0;

    const farmerCommissionGross = floor100(fishPrice * (farmerRate || 0));
    const farmerCampaignDiscount = farmerCampaignActive
        ? floor100(fishPrice * (farmerCampaignDiscountRate || 0)) : 0;
    const farmerCommission = farmerCommissionGross - farmerCampaignDiscount;
    // item単体の農家受取額（配送料はorderレベルで別途加算）
    const farmerReceiveAmount = fishPrice - farmerCommission;

    return {
        fishPrice, serviceFee, campaignDiscount,
        farmerCommission, farmerCommissionGross, farmerCampaignDiscount,
        farmerReceiveAmount,
    };
}

/**
 * 配送料計算（1配送＝1農家あたりの配送料。同じ農家の複数itemでも1回分）
 * 引数: deliveryRate (KHR/km), freeDeliveryDistance (km), distanceKm
 */
export function calcDeliveryFee(deliveryRate, freeDeliveryDistance, distanceKm) {
    const roundedDist = Math.floor((distanceKm || 0) * 10) / 10;
    const freeDist = freeDeliveryDistance || 0;
    if (freeDist > 0 && roundedDist <= freeDist) return 0;
    // 2026-07-04 #191: 距離×レートで出る端数も100リエル未満切り捨て（送料も100リエル単位に揃える）。
    return floor100((deliveryRate || 500) * roundedDist);
}

/**
 * 5/31 #105: 配送設定は農家単位（users/{uid}.farmerDelivery）を正とする。
 *   farmerDelivery = { deliverableRadiusKm, deliveryFeePer10km, freeDeliveryKm }
 * 農家docに無ければ旧 listing 単位フィールド（deliveryRate/freeDeliveryDistance/maxDistance）へフォールバック。
 * 戻り値は calcDeliveryFee/配送圏判定が使う内部表現に正規化:
 *   { ratePerKm, freeKm, radiusKm }
 *   ・ratePerKm = deliveryFeePer10km / 10（calcDeliveryFee は KHR/km 前提。式は数学的に同一）
 *   ・radiusKm  = 配送可能距離（これより遠いレストランには非表示）。null=制限なし
 * @param {object} farmer  users/{uid} doc（農家）
 * @param {object} listing fishListings doc（旧データ fallback 用・省略可）
 */
export function resolveDelivery(farmer, listing) {
    const fd = farmer && farmer.farmerDelivery;
    if (fd && (fd.deliveryFeePer10km != null || fd.deliverableRadiusKm != null || fd.freeDeliveryKm != null)) {
        return {
            ratePerKm: fd.deliveryFeePer10km != null ? fd.deliveryFeePer10km / 10 : 500,
            freeKm: fd.freeDeliveryKm || 0,
            radiusKm: fd.deliverableRadiusKm || null,
        };
    }
    // 旧データ fallback（listing 単位・farmerDelivery 未設定の既存出品）
    const l = listing || {};
    return {
        ratePerKm: l.deliveryRate != null ? l.deliveryRate : 500,
        freeKm: l.freeDeliveryDistance || 0,
        radiusKm: l.maxDistance || null,
    };
}

/**
 * items[] 配列から order-level 合計値を算出。
 * 戻り値: {
 *   fishPrice, serviceFee, campaignDiscount,
 *   farmerCommission, farmerCommissionGross, farmerCampaignDiscount,
 *   farmerReceiveAmount  // items合計（配送料はorder側で別途加算）
 * }
 */
export function sumItems(items) {
    const acc = {
        fishPrice: 0, serviceFee: 0, campaignDiscount: 0,
        farmerCommission: 0, farmerCommissionGross: 0,
        farmerCampaignDiscount: 0, farmerReceiveAmount: 0,
    };
    for (const it of items) {
        acc.fishPrice += it.fishPrice || 0;
        acc.serviceFee += it.serviceFee || 0;
        acc.campaignDiscount += it.campaignDiscount || 0;
        acc.farmerCommission += it.farmerCommission || 0;
        acc.farmerCommissionGross += it.farmerCommissionGross || 0;
        acc.farmerCampaignDiscount += it.farmerCampaignDiscount || 0;
        acc.farmerReceiveAmount += it.farmerReceiveAmount || 0;
    }
    return acc;
}

/**
 * order合計金額（レストラン支払額）
 * = items合計の魚代 + サービス料 - 割引 + 配送料
 */
export function calcOrderTotal(itemsSum, deliveryFee) {
    return itemsSum.fishPrice + itemsSum.serviceFee - itemsSum.campaignDiscount + (deliveryFee || 0);
}

/**
 * 表示用: 魚種名（snapFishType優先、フォールバックは listing.fishType）
 */
export function getFishDisplayName(item, listing, i18next) {
    const key = item?.snapFishType || listing?.fishType || '';
    if (!key) return '';
    return i18next?.exists?.(`fish.${key}`) ? i18next.t(`fish.${key}`) : key;
}

/**
 * 取引番号の表示文字列を返す。`order.orderNumber` があればそれ、なければ
 * doc id の先頭8文字を `FL-XXXXXXXX` として一時表示（Cloud Function 採番前 or 旧データ用）。
 */
export function getOrderNumber(order) {
    if (order?.orderNumber) return order.orderNumber;
    if (order?.id) return `FL-${String(order.id).slice(0, 8).toUpperCase()}`;
    return '';
}
