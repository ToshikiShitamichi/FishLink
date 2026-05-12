// 5/11 #65: カンボジア州名の正規化と多言語表示
// Geocoding API は en/km/ja などの言語別に州名を返すため、
// 内部キー（例: 'takeo'）に正規化してから保存・比較し、
// 表示時に i18n の province.{key} で言語別ラベルに変換する。
//
// 5/11（追加）：実運用での state を考慮し、以下も吸収：
// - Unicode NFC 正規化（"é" の合成済み/分解形の違い）
// - "Province" / "Khaet" / "Krong" などの接尾・接頭辞ゆれ
// - 旧表記（Kompong→Kampong / Sihanoukville→Preah Sihanouk 等）
// - アクセント有無（Takéo / Takeo / Kratié / Kratie）

// 内部キー → 各言語の代表表記とエイリアス
// formatProvince() は i18next の province.{key} を優先し、フォールバックとして
// このマップの 'en' を使う。
const PROVINCES = {
    phnom_penh: {
        en: 'Phnom Penh', km: 'ភ្នំពេញ', ja: 'プノンペン',
        aliases: [
            'phnom penh', 'phnompenh', 'phnom-penh',
            'phnom penh capital', 'phnom penh municipality',
            'krong phnom penh', 'រាជធានីភ្នំពេញ',
            'プノンペン', 'プノンペン特別市',
        ],
    },
    kandal: {
        en: 'Kandal', km: 'ខេត្តកណ្តាល', ja: 'カンダル州',
        aliases: ['kandal', 'khaet kandal', 'カンダル', 'カンダル州'],
    },
    takeo: {
        en: 'Takéo', km: 'ខេត្តតាកែវ', ja: 'タケオ州',
        aliases: [
            'takeo', 'takéo', 'takev', 'takaev',
            'khaet takeo', 'khaet takéo',
            'タケオ', 'タケオ州',
        ],
    },
    prey_veng: {
        en: 'Prey Veng', km: 'ខេត្តព្រៃវែង', ja: 'プレイヴェン州',
        aliases: ['prey veng', 'preyveng', 'khaet prey veng', 'プレイヴェン', 'プレイヴェン州'],
    },
    kampong_cham: {
        en: 'Kampong Cham', km: 'ខេត្តកំពង់ចាម', ja: 'コンポンチャム州',
        aliases: [
            'kampong cham', 'kompong cham', 'kg. cham', 'kg cham',
            'khaet kampong cham', 'コンポンチャム', 'コンポンチャム州',
        ],
    },
    kampong_thom: {
        en: 'Kampong Thom', km: 'ខេត្តកំពង់ធំ', ja: 'コンポントム州',
        aliases: [
            'kampong thom', 'kompong thom', 'kg. thom', 'kg thom',
            'khaet kampong thom', 'コンポントム', 'コンポントム州',
        ],
    },
    siem_reap: {
        en: 'Siem Reap', km: 'ខេត្តសៀមរាប', ja: 'シェムリアップ州',
        aliases: [
            'siem reap', 'siemreap', 'siem reab', 'siemreab',
            'khaet siem reap', 'シェムリアップ', 'シェムリアップ州',
        ],
    },
    battambang: {
        en: 'Battambang', km: 'ខេត្តបាត់ដំបង', ja: 'バッタンバン州',
        aliases: [
            'battambang', 'battambong', 'batdambang', 'battam bang',
            'khaet battambang', 'バッタンバン', 'バッタンバン州',
        ],
    },
    pursat: {
        en: 'Pursat', km: 'ខេត្តពោធិ៍សាត់', ja: 'ポーサット州',
        aliases: [
            'pursat', 'poursat', 'pouthisat', 'pothisat',
            'khaet pursat', 'ポーサット', 'ポーサット州',
        ],
    },
    kampong_chhnang: {
        en: 'Kampong Chhnang', km: 'ខេត្តកំពង់ឆ្នាំង', ja: 'コンポンチュナン州',
        aliases: [
            'kampong chhnang', 'kompong chhnang', 'kg. chhnang', 'kg chhnang',
            'khaet kampong chhnang', 'コンポンチュナン', 'コンポンチュナン州',
        ],
    },
    kampong_speu: {
        en: 'Kampong Speu', km: 'ខេត្តកំពង់ស្ពឺ', ja: 'コンポンスプー州',
        aliases: [
            'kampong speu', 'kompong speu', 'kg. speu', 'kg speu',
            'khaet kampong speu', 'コンポンスプー', 'コンポンスプー州',
        ],
    },
    banteay_meanchey: {
        en: 'Banteay Meanchey', km: 'ខេត្តបន្ទាយមានជ័យ', ja: 'バンテイメンチェイ州',
        aliases: [
            'banteay meanchey', 'banteay mean chey', 'banteay meancheay',
            'bmc', 'khaet banteay meanchey',
            'バンテイメンチェイ', 'バンテイメンチェイ州',
        ],
    },
    svay_rieng: {
        en: 'Svay Rieng', km: 'ខេត្តស្វាយរៀង', ja: 'スヴァイリエン州',
        aliases: ['svay rieng', 'svayrieng', 'khaet svay rieng', 'スヴァイリエン', 'スヴァイリエン州'],
    },
    kratie: {
        en: 'Kratié', km: 'ខេត្តក្រចេះ', ja: 'クラチェ州',
        aliases: [
            'kratie', 'kratié', 'krocheh', 'kracheh',
            'khaet kratie', 'khaet kratié', 'クラチェ', 'クラチェ州',
        ],
    },
    stung_treng: {
        en: 'Stung Treng', km: 'ខេត្តស្ទឹងត្រែង', ja: 'ストゥントレン州',
        aliases: [
            'stung treng', 'stoeung treng', 'steung treng', 'stungtreng',
            'khaet stung treng', 'ストゥントレン', 'ストゥントレン州',
        ],
    },
    ratanakiri: {
        en: 'Ratanakiri', km: 'ខេត្តរតនគិរី', ja: 'ラタナキリ州',
        aliases: [
            'ratanakiri', 'rattanakiri', 'ratanak kiri', 'rotanakiri',
            'khaet ratanakiri', 'ラタナキリ', 'ラタナキリ州',
        ],
    },
    mondulkiri: {
        en: 'Mondulkiri', km: 'ខេត្តមណ្ឌលគិរី', ja: 'モンドルキリ州',
        aliases: [
            'mondulkiri', 'mondol kiri', 'monduolkiri',
            'khaet mondulkiri', 'モンドルキリ', 'モンドルキリ州',
        ],
    },
    preah_vihear: {
        en: 'Preah Vihear', km: 'ខេត្តព្រះវិហារ', ja: 'プレアヴィヒア州',
        aliases: [
            'preah vihear', 'preahvihear', 'preah vihea',
            'khaet preah vihear', 'プレアヴィヒア', 'プレアヴィヒア州',
        ],
    },
    kep: {
        en: 'Kep', km: 'ខេត្តកែប', ja: 'ケップ州',
        aliases: ['kep', 'kaeb', 'krong kep', 'khaet kep', 'ケップ', 'ケップ州'],
    },
    kampot: {
        en: 'Kampot', km: 'ខេត្តកំពត', ja: 'カンポット州',
        aliases: ['kampot', 'khaet kampot', 'カンポット', 'カンポット州'],
    },
    koh_kong: {
        en: 'Koh Kong', km: 'ខេត្តកោះកុង', ja: 'コーコン州',
        aliases: [
            'koh kong', 'kohkong', 'kaoh kong', 'kah kong',
            'khaet koh kong', 'コーコン', 'コーコン州',
        ],
    },
    tboung_khmum: {
        en: 'Tboung Khmum', km: 'ខេត្តត្បូងឃ្មុំ', ja: 'トボンクムム州',
        aliases: [
            'tboung khmum', 'tbong khmum', 'tbaung khmum',
            'khaet tboung khmum', 'トボンクムム', 'トボンクムム州',
        ],
    },
    oddar_meanchey: {
        en: 'Oddar Meanchey', km: 'ខេត្តឧត្តរមានជ័យ', ja: 'オッドーミエンチェイ州',
        aliases: [
            'oddar meanchey', 'otdar meanchey', 'otdor meanchey',
            'oddar mean chey', 'khaet oddar meanchey',
            'オッドーミエンチェイ', 'オッドーミエンチェイ州',
        ],
    },
    preah_sihanouk: {
        en: 'Preah Sihanouk', km: 'ខេត្តព្រះសីហនុ', ja: 'シハヌークビル州',
        aliases: [
            'preah sihanouk', 'preahsihanouk', 'sihanoukville',
            'sihanouk', 'krong preah sihanouk',
            'khaet preah sihanouk', 'シハヌークビル', 'シハヌーク州',
            'シハヌークビル州',
        ],
    },
    pailin: {
        en: 'Pailin', km: 'ខេត្តប៉ៃលិន', ja: 'パイリン州',
        aliases: ['pailin', 'krong pailin', 'khaet pailin', 'パイリン', 'パイリン州'],
    },
};

// 入力文字列を比較用に正規化：
// - Unicode NFC（合成済み）に統一
// - 小文字化、前後空白除去
// - 全角→半角の空白統一
// - "Province" / "Khaet" / "Krong" の接頭・接尾辞除去
// - クメール語の "ខេត្ត" / "ខែត្រ" / "ក្រុង" 接頭辞除去
function canonicalize(s) {
    if (!s) return '';
    return String(s)
        .normalize('NFC')
        .toLowerCase()
        .replace(/　/g, ' ')     // 全角空白 → 半角
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\s+province$/i, '')
        .replace(/^province\s+of\s+/i, '')
        .replace(/^khaet\s+/i, '')
        .replace(/^krong\s+/i, '')
        .replace(/^ខេត្ត/, '')
        .replace(/^ខែត្រ/, '')
        .replace(/^ក្រុង/, '')
        .replace(/^រាជធានី/, '')
        .trim();
}

// 検索用の逆引きインデックス（canonicalize 済みエイリアス → 内部キー）
const ALIAS_TO_KEY = (() => {
    const map = new Map();
    const add = (alias, key) => {
        const c = canonicalize(alias);
        if (c) map.set(c, key);
    };
    for (const [key, entry] of Object.entries(PROVINCES)) {
        // 主要表記
        add(entry.en, key);
        add(entry.km, key);
        add(entry.ja, key);
        // 全エイリアス
        (entry.aliases || []).forEach(a => add(a, key));
        // キー自身も
        add(key, key);
        add(key.replace(/_/g, ' '), key);
    }
    return map;
})();

/**
 * 任意の州名表記を内部キーに正規化する。
 * - en / km / ja / 別表記、"Province" 接尾辞、accent / 大文字小文字を吸収
 * - マッチしない場合は null を返す
 */
export function normalizeProvince(raw) {
    if (!raw) return null;
    // 既に正規化済みキーならそのまま返す
    if (typeof raw === 'string' && PROVINCES[raw]) return raw;
    const c = canonicalize(raw);
    if (!c) return null;
    if (ALIAS_TO_KEY.has(c)) return ALIAS_TO_KEY.get(c);
    return null;
}

/**
 * 内部キーから表示ラベルを取得。
 * - i18next がロードされていれば province.{key} を使う
 * - フォールバックは PROVINCES[key].en
 * - 未知のキーや null は raw 文字列をそのまま返す
 */
export function formatProvince(rawOrKey, lang) {
    const key = normalizeProvince(rawOrKey);
    if (!key) return rawOrKey || '';
    // i18next 経由
    if (typeof window !== 'undefined' && window.i18next?.exists?.(`province.${key}`)) {
        return window.i18next.t(`province.${key}`);
    }
    // フォールバック：lang 指定 or en
    const entry = PROVINCES[key];
    if (lang && entry[lang]) return entry[lang];
    return entry.en;
}

/**
 * 既知の全州キーを取得（順序は PROVINCES の定義順）
 */
export function getAllProvinceKeys() {
    return Object.keys(PROVINCES);
}

/**
 * district を UI 言語に合わせて表示用に整形する。
 * - lang が km、user に districtKm があればクメール語版を使う
 * - それ以外は district（英語）を使う
 * - 第1引数に user オブジェクト or { district, districtKm } を渡す
 */
export function formatDistrict(user, lang) {
    if (!user) return '';
    const useLang = lang || (typeof window !== 'undefined' ? window.i18next?.language : null);
    if (useLang === 'km' && user.districtKm) return user.districtKm;
    return user.district || '';
}

/**
 * province と district を組み合わせて "州, 市区町村" 形式で表示する。
 * - province は内部キーから i18n ラベルへ変換
 * - district は UI 言語に応じて km / en を切り替え
 */
export function formatLocation(user, lang) {
    if (!user) return '';
    const prov = formatProvince(user.province, lang);
    const dist = formatDistrict(user, lang);
    return [prov, dist].filter(Boolean).join(', ');
}

/**
 * 2つの州表記が「同じ州を指す」かを判定（正規化して比較）
 */
export function isSameProvince(a, b) {
    const ka = normalizeProvince(a);
    const kb = normalizeProvince(b);
    if (ka && kb) return ka === kb;
    return String(a || '') === String(b || '');
}
