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
    serverTimestamp
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
            if (redirectIfLoggedIn && !(skipRedirectIf && skipRedirectIf())) {
                const snap = await getDoc(doc(db, 'users', user.uid));
                if (snap.exists()) redirectByRole(snap.data().role);
            }
            window.currentUser = user;
            window.currentUserData = null;
            const snap = await getDoc(doc(db, 'users', user.uid));
            if (snap.exists()) {
                window.currentUserData = snap.data();
                // Firestoreの言語設定をlocalStorageに同期
                // ※画面上部パネルで切り替えた場合はlocalStorageが優先されるが、
                //   次回ログイン時にFirestoreの値で再上書きされる
                // FCMトークン取得・保存（管理者は通知不要のためスキップ）
                if (window.currentUserData.role !== 'admin') {
                    requestFcmToken(user.uid);
                }
            }
        } else {
            if (requireAuth) window.location.href = '/index.html';
        }
    });
}

// ── 新規登録 ──────────────────────────────────────────────────
async function register({ loginId, displayName, password, role, location, province, district, lang }) {
    const id = loginId.toLowerCase().trim();

    // バリデーション
    if (!isValidLoginId(id)) throw new Error('error.invalidLoginId');
    if (!displayName.trim()) throw new Error('error.displayNameRequired');
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
    if (userData.lang) {
        localStorage.setItem('fishlink_lang', userData.lang);
    }
    redirectByRole(userData.role);
}

// ── ログアウト ────────────────────────────────────────────────
async function logout() {
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
            await updateDoc(doc(db, 'users', uid), { fcmToken: token });
            console.log('FCM token saved');
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