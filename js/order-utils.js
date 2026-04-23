// 注文まわりの共通ヘルパー
// - items[] スキーマと legacy 単一itemスキーマの両方を扱えるようにする
// - 料金計算ロジックを一元化

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

    const serviceFee = Math.round(fishPrice * (serviceRate || 0));
    const campaignDiscount = campaignActive ? Math.round(fishPrice * (campaignDiscountRate || 0)) : 0;

    const farmerCommissionGross = Math.round(fishPrice * (farmerRate || 0));
    const farmerCampaignDiscount = farmerCampaignActive
        ? Math.round(fishPrice * (farmerCampaignDiscountRate || 0)) : 0;
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
    return Math.round((deliveryRate || 500) * roundedDist);
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
