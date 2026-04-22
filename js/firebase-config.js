import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import { getFirestore, FieldValue } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getStorage } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-storage.js';

const firebaseConfig = {
    apiKey: "AIzaSyCVFFieinYqc3pqbigeQuhJ8KdVs6as9DU",
    authDomain: "fishlink-t-shitamichi.firebaseapp.com",
    projectId: "fishlink-t-shitamichi",
    storageBucket: "fishlink-t-shitamichi.firebasestorage.app",
    messagingSenderId: "54443009365",
    appId: "1:54443009365:web:a531106e41c4397ace7bdc"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

// ログインID → Firebase Auth 用の内部メールに変換
// 例: sakana_farm → sakana_farm@fishlink.local
function toInternalEmail(loginId) {
    return `${loginId.toLowerCase()}@fishlink.local`;
}

export { app as firebaseApp, auth, db, storage, FieldValue, toInternalEmail };