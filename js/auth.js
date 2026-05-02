import {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signOut,
    onAuthStateChanged,
    updateProfile
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

import { auth, db, toInternalEmail } from './firebase-config.js';
import { getMessaging, getToken, onMessage } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-messaging.js';

// FCM VAPIDキー（Firebaseコンソール → Cloud Messaging → ウェブプッシュ証明書）
const VAPID_KEY = 'BHPaUqpvuOvpMUtxvVinoXFk0nZBiDMvPXlIBjeLqNesPPmBPt8sOGC2UZdSZLhTiv08ULuw4AMe-OXhIijp-k4'; // TODO: Firebaseコンソールから取得して設定

// ── バリデーション ────────────────────────────────────────────
// ログインIDは英数字とアンダースコアのみ・3〜20文字
function isValidLoginId(id) {
    return /^[a-zA-Z0-9_]{3,20}$/.test(id);
}

// ログインIDの重複チェック（Firestoreで確認）
async function isLoginIdTaken(loginId) {
    const q = query(
        collection(db, 'users'),
        where('loginId', '==', loginId.toLowerCase()),
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
                if (data.role !== 'admin') {
                    requestFcmToken(user.uid);
                }
            }
        } else {
            if (requireAuth) window.location.href = '/index.html';
        }
    });
}

// ── 新規登録 ──────────────────────────────────────────────────
async function register({ loginId, displayName, phone, password, role, location, province, district, lang }) {
    const id = loginId.toLowerCase().trim();

    // バリデーション
    if (!isValidLoginId(id)) throw new Error('error.invalidLoginId');
    if (!displayName.trim()) throw new Error('error.displayNameRequired');
    if (!phone || !String(phone).trim()) throw new Error('error.phoneRequired');
    if (password.length < 6) throw new Error('error.passwordTooShort');
    if (!['farmer', 'restaurant'].includes(role)) throw new Error('error.roleRequired');
    if (!location) throw new Error('error.locationRequired');

    // ログインID重複チェック
    if (await isLoginIdTaken(id)) throw new Error('error.loginIdTaken');

    // Firebase Auth にユーザー作成（仮メール方式）
    const credential = await createUserWithEmailAndPassword(
        auth,
        toInternalEmail(id),
        password
    );
    const uid = credential.user.uid;

    // 表示名をFirebase Authにも設定
    await updateProfile(credential.user, { displayName: displayName.trim() });

    // Firestore に users ドキュメントを作成
    await setDoc(doc(db, 'users', uid), {
        loginId: id,
        displayName: displayName.trim(),
        phone: String(phone).trim(),
        role,
        location: { lat: location.lat, lng: location.lng },
        province: province || null,
        district: district || null,
        lang: lang || 'km',
        fcmToken: null,
        avgRating: 0,
        reviewCount: 0,
        createdAt: serverTimestamp(),
    });

    return uid;
}

// ── ログイン ──────────────────────────────────────────────────
async function login(loginId, password) {
    const id = loginId.toLowerCase().trim();
    if (!id || !password) throw new Error('error.fieldsRequired');

    await signInWithEmailAndPassword(auth, toInternalEmail(id), password);

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

    await signOut(auth);
    window.location.href = '/index.html';
}

// ── FCMトークン取得・保存 ──────────────────────────
async function requestFcmToken(uid) {
    if (!VAPID_KEY) return;
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
            console.log('FCM token registered (multi-device)');
        }

        // フォアグラウンド通知（data-onlyペイロード対応）
        onMessage(messaging, (payload) => {
            const title = payload.data?.title || 'FishLink';
            const body = payload.data?.body || '';
            navigator.serviceWorker.ready.then(reg => {
                reg.showNotification(title, {
                    body,
                    icon: '/icons/icon-192.png',
                    tag: 'fishlink-foreground',
                });
            });
        });
    } catch (err) {
        console.warn('FCM token request failed:', err.message);
    }
}

export { watchAuthState, register, login, logout };