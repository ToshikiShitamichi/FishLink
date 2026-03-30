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

// アプリが閉じている・バックグラウンドのときにプッシュ通知を受信
messaging.onBackgroundMessage((payload) => {
  const { title, body } = payload.notification || {};
  self.registration.showNotification(title || 'FishLink', {
    body:  body || '',
    icon:  '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data:  payload.data || {},
  });
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