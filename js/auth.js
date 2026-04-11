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
                // Firestoreの言語設定をlocalStorageに同期（初回ログイン時に反映）
                const userLang = snap.data().lang;
                if (userLang && !localStorage.getItem('fishlink_lang')) {
                    localStorage.setItem('fishlink_lang', userLang);
                }
            }
        } else {
            if (requireAuth) window.location.href = '/index.html';
        }
    });
}

// ── 新規登録 ──────────────────────────────────────────────────
async function register({ loginId, displayName, password, role, location, province, lang }) {
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

// ── FCMトークン更新 ──────────────────────────
async function updateFcmToken(token) {
    const user = auth.currentUser;
    if (!user) return;
    await updateDoc(doc(db, 'users', user.uid), { fcmToken: token });
}

export { watchAuthState, register, login, logout, updateFcmToken };