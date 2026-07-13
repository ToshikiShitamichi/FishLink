import {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signOut,
    onAuthStateChanged,
    updateProfile,
    setPersistence,
    browserLocalPersistence
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';

import {
    doc,
    setDoc,
    getDoc,
    updateDoc,
    query,
    collection,
    where,
    limit,
    getDocs,
    serverTimestamp,
    arrayUnion,
    arrayRemove
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';

import { auth, db, toInternalEmail, normalizePhone, isValidCambodiaPhone } from './firebase-config.js';
import { getMessaging, getToken, onMessage } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-messaging.js';
import { normalizeProvince } from './province-utils.js';

// 6/6 #131: セッション維持（入りっぱなし）。ローカル永続を明示。
// ※ Firebase Web SDK の既定もローカル永続だが、明示しておく。
setPersistence(auth, browserLocalPersistence).catch((e) => {
    console.warn('setPersistence failed:', e?.message);
});

// FCM VAPIDキー（Firebaseコンソール → Cloud Messaging → ウェブプッシュ証明書）
const VAPID_KEY = 'BHPaUqpvuOvpMUtxvVinoXFk0nZBiDMvPXlIBjeLqNesPPmBPt8sOGC2UZdSZLhTiv08ULuw4AMe-OXhIijp-k4'; // TODO: Firebaseコンソールから取得して設定

// ── バリデーション ────────────────────────────────────────────
// 6/6 #131: 識別子は電話番号（旧ログインIDは廃止）。
// 電話番号の重複チェック（正規化済みの値で Firestore を確認）
async function isPhoneTaken(normalizedPhone) {
    const q = query(
        collection(db, 'users'),
        where('phone', '==', normalizedPhone),
        limit(1)
    );
    const snap = await getDocs(q);
    return !snap.empty;
}

// ── ロール別リダイレクト ──────────────────────────────────────
function redirectByRole(role) {
    if (role === 'farmer') {
        window.location.href = '/pages/farmer/dashboard.html';
    } else if (role === 'restaurant') {
        window.location.href = '/pages/restaurant/dashboard.html';
    } else if (role === 'admin') {
        window.location.href = '/pages/admin/index.html';
    }
}

// ── ログイン状態の監視 ────────────────────────────────────────
// 各ページの先頭で呼び出す
// requireAuth: true  → 未ログインならログイン画面へ
// redirectIfLoggedIn: true → ログイン済みならダッシュボードへ（ログイン画面用）
function watchAuthState({ requireAuth = true, redirectIfLoggedIn = false, skipRedirectIf = null } = {}) {
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            // 後続コードが window.currentUser に依存するため即セット
            window.currentUser = user;
            window.currentUserData = null;

            const snap = await getDoc(doc(db, 'users', user.uid));
            if (snap.exists()) {
                const data = snap.data();
                // BAN チェック: isBanned===true の場合は強制ログアウト
                if (data.isBanned === true) {
                    sessionStorage.setItem('fishlink_banned', '1');
                    await signOut(auth);
                    window.location.href = '/index.html';
                    return;
                }
                if (redirectIfLoggedIn && !(skipRedirectIf && skipRedirectIf())) {
                    redirectByRole(data.role);
                }
                window.currentUserData = data;
                // 5/4: admin にも FCM トークンを発行（運営チャット・トラブル報告通知のため）
                // 旧仕様では admin を除外していたが、5/1 で運営チャット／トラブル報告の通知系が
                // 実装されてからは admin も通知を受ける必要がある
                requestFcmToken(user.uid);
            }
        } else {
            if (requireAuth) window.location.href = '/index.html';
        }
    });
}

// ── 新規登録 ──────────────────────────────────────────────────
// 6/6 #131: ログインID欄を廃止。識別子＝電話番号。
//   電話番号を正規化 → 合成メール {phone}@fishlink.local を内部IDとして使用。
async function register({ displayName, phone, password, role, location, province, district, districtKm, lang, pendingReferralCode }) {
    // バリデーション
    if (!displayName || !displayName.trim()) throw new Error('error.displayNameRequired');
    if (!phone || !String(phone).trim()) throw new Error('error.phoneRequired');
    if (password.length < 6) throw new Error('error.passwordTooShort');
    if (!['farmer', 'restaurant'].includes(role)) throw new Error('error.roleRequired');
    if (!location) throw new Error('error.locationRequired');

    // 電話番号の正規化＋形式検証（カンボジア形式）
    const normPhone = normalizePhone(phone);
    if (!isValidCambodiaPhone(normPhone)) throw new Error('error.phoneInvalid');

    // 電話番号の重複チェック
    if (await isPhoneTaken(normPhone)) throw new Error('error.phoneTaken');

    // Firebase Auth にユーザー作成（電話番号→合成メール方式）
    const credential = await createUserWithEmailAndPassword(
        auth,
        toInternalEmail(normPhone),
        password
    );
    const uid = credential.user.uid;

    // 表示名をFirebase Authにも設定
    await updateProfile(credential.user, { displayName: displayName.trim() });

    // 5/11 #65: province は内部キー（例: 'takeo'）に正規化して保存
    // 表示時に i18n の province.{key} で 3言語ラベルに変換
    const normalizedProvince = normalizeProvince(province) || province || null;

    // 5/23 #82 Phase 1: 自身の紹介コード（[A-Za-z0-9]×8）を生成して登録時に書き込む
    // dedup なしでよい（衝突確率 ≈ 1/2.18e14）。
    const { generateReferralCode } = await import('/js/referral.js');
    const referralCode = generateReferralCode();

    // 5/24 #82 Phase 2 Step A: 紹介コード入力（被紹介者として登録）
    // 検証は呼び出し側（register.html）で済ませてある前提。
    // ここでは保存するだけ。pendingReferralCode は初回取引完了時に referredBy に昇格される。
    const userDoc = {
        // 6/6 #131: loginId 廃止。電話番号は正規化形で保存（重複チェック・合成メールの素）。
        displayName: displayName.trim(),
        phone: normPhone,
        role,
        location: { lat: location.lat, lng: location.lng },
        province: normalizedProvince,
        district: district || null,
        // 5/11 拡張: district のクメール語版（登録時 Geocoder km から取得）
        // 表示時に UI 言語が km ならこちらを優先する
        districtKm: districtKm || null,
        lang: lang || 'km',
        fcmToken: null,
        avgRating: 0,
        reviewCount: 0,
        referralCode,            // 5/23 #82: 自身の紹介コード（Phase 1 から書き込み）
        referralCount: 0,        // 5/23 #82 Phase 2 で増分予定（紹介者として）
        createdAt: serverTimestamp(),
    };
    if (pendingReferralCode && /^[A-Za-z0-9]{8}$/.test(pendingReferralCode)) {
        // 5/24 #82 Phase 2: 初回取引完了時に referredBy に昇格 + 特典付与
        userDoc.pendingReferralCode = pendingReferralCode;
    }
    // Firestore に users ドキュメントを作成
    await setDoc(doc(db, 'users', uid), userDoc);

    return uid;
}

// ── ログイン ──────────────────────────────────────────────────
// 6/6 #131: 識別子＝電話番号。ハイブリッド解決で既存アカウントも保護する。
//   - 入力がカンボジア電話番号形式 → 正規化して {phone}@fishlink.local で認証（新方式）。
//   - それ以外（旧ログインID） → {loginId}@fishlink.local で認証（既存アカウント救済・admin含む）。
//   失敗時は生 Firebase エラーを出さず「電話番号またはパスワードが違います」（どちらかは特定しない）。
async function login(identifier, password) {
    const raw = String(identifier || '').trim();
    if (!raw || !password) throw new Error('error.fieldsRequired');

    const normPhone = normalizePhone(raw);
    const email = isValidCambodiaPhone(normPhone)
        ? toInternalEmail(normPhone)                 // 新方式（電話番号ベース）
        : toInternalEmail(raw.toLowerCase());        // 旧方式フォールバック（ログインID）

    try {
        await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
        // auth/invalid-credential, auth/user-not-found, auth/wrong-password 等は
        // すべて同一の友好的文言に丸める（番号有無・正誤を漏らさない＝総当たり防止）。
        if (err?.code === 'auth/network-request-failed') {
            throw new Error('error.network');
        }
        throw new Error('error.invalidCredentials');
    }

    // ロール取得 → 言語同期 → リダイレクト
    const user = auth.currentUser;
    const snap = await getDoc(doc(db, 'users', user.uid));
    if (!snap.exists()) throw new Error('error.userNotFound');

    const userData = snap.data();
    if (userData.isBanned === true) {
        await signOut(auth);
        throw new Error('error.accountBanned');
    }
    if (userData.lang) {
        localStorage.setItem('fishlink_lang', userData.lang);
    }
    redirectByRole(userData.role);
}

// ── ログアウト ────────────────────────────────────────────────
async function logout() {
    // 5/2: ログアウト前にこの端末のFCMトークンを users/{uid}.fcmTokens から除去
    // 別アカウントが同じ端末でログインした際に元アカウント宛通知を受け取らないようにするため
    try {
        const uid = auth.currentUser?.uid;
        const token = localStorage.getItem('fishlink_fcm_token');
        if (uid && token) {
            await updateDoc(doc(db, 'users', uid), {
                fcmTokens: arrayRemove(token),
            });
        }
        localStorage.removeItem('fishlink_fcm_token');
    } catch (e) { /* ignore — ログアウト自体は止めない */ }

    // 5/12 #69 追補：別アカウントが同端末でログインした際に元アカウントの
    //   キャッシュ済みデータが見えないよう、セッションキャッシュ全消去
    try {
        const mod = await import('/js/data-cache.js');
        mod.clearAll();
    } catch (e) { /* data-cache 未配置でも logout は止めない */ }

    // 5/23 #69 Phase D：IndexedDB の永続画像キャッシュもクリア（プライバシー保護）
    try {
        const mod = await import('/js/image-cache.js');
        await mod.clearAll();
    } catch (e) { /* image-cache 未配置でも logout は止めない */ }

    // 7/9 #199：IndexedDB の永続動画キャッシュ（リール）もクリア（プライバシー保護）
    try {
        const mod = await import('/js/video-cache.js');
        await mod.clearAllVideos();
    } catch (e) { /* video-cache 未配置でも logout は止めない */ }

    // 5/23 #69 Phase J：sessionStorage の画面描画キャッシュもクリア
    try {
        const mod = await import('/js/render-cache.js');
        mod.clearRenderState();
    } catch (e) { /* render-cache 未配置でも logout は止めない */ }

    await signOut(auth);
    window.location.href = '/index.html';
}

// ── FCMトークン取得・保存 ──────────────────────────
// 6/29 #186: 通知許可の「登録直後の自動要求」を廃止。
//   - requestFcmToken（watchAuthState から毎ページ呼ばれる）は「すでに許可済み」の場合だけ
//     トークンを発行する（OSダイアログは出さない）。
//   - OSダイアログはソフト確認の〔オンにする〕押下時（enablePush・js/push-optin.js 経由）にのみ出す。
async function requestFcmToken(uid) {
    if (!VAPID_KEY) return;
    // すでに許可済みのときだけトークン発行＋フォアグラウンド購読。未許可（default/denied）は何もしない。
    if (!('Notification' in window) || Notification.permission !== 'granted') {
        console.log('FCM token skipped (permission not granted):',
            ('Notification' in window) ? Notification.permission : 'unsupported');
        return;
    }
    await doRegisterFcm(uid);
}

// 6/29 #186: ソフト確認の〔オンにする〕押下時にだけ呼ぶ。OS許可を要求し、許可されたらトークン発行。
//   戻り値＝最終的な Notification.permission（'granted' | 'denied' | 'default' | 'unsupported'）。
async function enablePush() {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
    let perm = Notification.permission;
    if (perm === 'default') {
        try { perm = await Notification.requestPermission(); }
        catch (e) { console.warn('requestPermission failed:', e); return 'default'; }
    }
    if (perm === 'granted') {
        const uid = window.currentUser?.uid;
        if (uid) { try { await doRegisterFcm(uid); } catch (e) { console.warn('doRegisterFcm failed:', e.message); } }
    }
    return perm;
}

// 6/29 #186: 会話系通知を「その会話を開いている間」抑制するための判定。
function isViewingConversation(data) {
    try {
        const convTypes = ['chat_message', 'chat_voice_message', 'admin_chat', 'comment_question', 'comment_reply'];
        if (!data || !convTypes.includes(data.type)) return false;
        const target = new URL(data.url || '', location.origin);
        if (target.pathname !== location.pathname) return false;
        // 会話の識別子は種類で異なる（配送/Q&A=id・運営チャット=uid）。両方で照合し、
        // 別スレッドの通知を誤って抑制しない（例：運営が users.html?uid=A を見ている間の uid=B の通知）。
        const tid = target.searchParams.get('id') || target.searchParams.get('uid');
        if (tid) {
            const cur = new URLSearchParams(location.search);
            const cid = cur.get('id') || cur.get('uid');
            if (tid !== cid) return false;
        }
        return true;
    } catch (e) { return false; }
}

let fgBound = false; // onMessage の多重バインド防止（1ページ1回）

// 実際のトークン発行・保存＋フォアグラウンド購読（許可済み前提で呼ぶ）
async function doRegisterFcm(uid) {
    if (!VAPID_KEY || !uid) return;
    try {
        // sw.js にFCM機能を統合済み — 更新があれば自動反映
        const registration = await navigator.serviceWorker.ready;
        registration.update();
        registration.addEventListener('updatefound', () => {
            const newSW = registration.installing;
            if (newSW) {
                newSW.addEventListener('statechange', () => {
                    if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
                        window.location.reload();
                    }
                });
            }
        });

        const messaging = getMessaging();
        const token = await getToken(messaging, {
            vapidKey: VAPID_KEY,
            serviceWorkerRegistration: registration
        });
        if (token) {
            // 5/2: 複数端末対応 — 配列に追加（同じトークンの重複は arrayUnion が排除）
            // レガシー fcmToken（単一）も Cloud Functions 側で互換読み込みされる
            await updateDoc(doc(db, 'users', uid), {
                fcmTokens: arrayUnion(token),
            });
            // ログアウト時にこの端末分だけ arrayRemove するため、ローカルにも保持
            try { localStorage.setItem('fishlink_fcm_token', token); } catch (e) { /* ignore */ }
            console.log('FCM token registered (multi-device):', uid, token.slice(0, 20) + '...');
        } else {
            console.warn('FCM getToken returned empty (permission not granted or SW issue). Permission:', Notification?.permission);
        }

        // フォアグラウンド通知（data-onlyペイロード対応）— 1ページ1回だけバインド
        if (!fgBound) {
            fgBound = true;
            onMessage(messaging, (payload) => {
                const data = payload.data || {};
                // 6/29 #186 A: フォアグラウンド抑制 — その会話を開いている間はプッシュを出さない
                //   （画面内に新着が反映されるため）。別画面/別会話なら表示する。
                if (typeof document !== 'undefined' && document.visibilityState === 'visible'
                    && isViewingConversation(data)) {
                    return;
                }
                const title = data.title || 'FishLink';
                const body = data.body || '';
                navigator.serviceWorker.ready.then(reg => {
                    reg.showNotification(title, {
                        body,
                        icon: '/icons/icon-192.png',
                        tag: 'fishlink-foreground',
                        // 6/29 #186: フォアグラウンド表示にも url を持たせてタップ遷移を効かせる
                        data,
                    });
                });
            });
        }
    } catch (err) {
        console.warn('FCM token request failed:', err.message);
    }
}

export { watchAuthState, register, login, logout, enablePush };