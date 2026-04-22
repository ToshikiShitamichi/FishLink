// バックグラウンド通知用 Service Worker

// Firebase SDKをService Worker内で読み込む（importScriptsを使う）
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

// firebase-config.js と同じ値を設定
const firebaseConfig = {
  apiKey: "AIzaSyCVFFieinYqc3pqbigeQuhJ8KdVs6as9DU",
  authDomain: "fishlink-t-shitamichi.firebaseapp.com",
  projectId: "fishlink-t-shitamichi",
  storageBucket: "fishlink-t-shitamichi.firebasestorage.app",
  messagingSenderId: "54443009365",
  appId: "1:54443009365:web:a531106e41c4397ace7bdc"
};

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

// PWAアイコンバッジを増加（SW側ではユーザーの実際の未読数を知れないので +1）
async function incrementAppBadge() {
  if (!('setAppBadge' in self.navigator)) return;
  try {
    // 既存件数を IndexedDB で保持するのが理想だが、簡易的に +1 ずつ加算
    // （メインページ再訪時に Firestore の正確な値で上書きされる）
    const current = Number(self._badgeCount || 0) + 1;
    self._badgeCount = current;
    await self.navigator.setAppBadge(current);
  } catch (e) { /* noop */ }
}

// アプリが閉じている・バックグラウンドのときにプッシュ通知を受信
messaging.onBackgroundMessage((payload) => {
  const data = payload.data || {};
  const title = data.title || payload.notification?.title || 'FishLink';
  const body = data.body || payload.notification?.body || '';
  self.registration.showNotification(title, {
    body,
    icon:  '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data,
  });
  incrementAppBadge();
});

// 通知をタップしたときの処理
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url === url && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});