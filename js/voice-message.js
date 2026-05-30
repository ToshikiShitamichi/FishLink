// 5/23 #81: 取引チャットのボイスメッセージ機能
//
// 仕様（5/19 MTG 確定）:
//   - 対象：orders/{orderId}/messages（取引チャット）のみ。adminChats は対象外。
//   - 最大録音時間：90秒
//   - 保存期間：30日（scheduled CF で自動削除予定）
//   - iOS Safari は audio/mp4 固定、Android Chrome は audio/webm;codecs=opus 推奨
//   - 受信側は再生ボタン + 秒数表示（波形は将来検討）
//
// 使い方:
//   import { initVoiceRecorder } from '/js/voice-message.js';
//   initVoiceRecorder({
//       chatInputContainer: document.getElementById('chat-input-wrap'),
//       getOrderId: () => orderId,
//       getSenderUid: () => myUid,
//   });

import { db, storage } from '/js/firebase-config.js';
import {
    ref, uploadBytes, getDownloadURL
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-storage.js';
import {
    doc, updateDoc, addDoc, collection, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';

const MAX_DURATION_SEC = 90;
const RECORD_BITRATE = 64000;   // 64 kbps (90s 約 720KB)
const STORAGE_CACHE_CONTROL = 'public, max-age=2592000'; // 30日

// MediaRecorder で実際に使える MIME を選ぶ
// 5/27 #100: クロスブラウザ再生互換性のため audio/mp4 を優先（iOS Safari は webm 再生不可）
//   - Chrome 109+ / Safari: audio/mp4 録音可・全ブラウザ再生可
//   - 旧 Chrome: webm にフォールバック（Safari 受信者は再生不可だが従来動作）
function pickMimeType() {
    if (typeof MediaRecorder === 'undefined') return null;
    const candidates = [
        'audio/mp4',
        'audio/mp4;codecs=mp4a.40.2',
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
    ];
    if (typeof MediaRecorder.isTypeSupported !== 'function') {
        // iOS Safari の一部バージョンは isTypeSupported 未実装 → ブラウザのデフォルトに任せる
        return '';
    }
    for (const c of candidates) {
        if (MediaRecorder.isTypeSupported(c)) return c;
    }
    return '';
}

function inferExtension(mimeType) {
    if (!mimeType) return 'webm';
    if (mimeType.startsWith('audio/mp4')) return 'mp4';
    if (mimeType.startsWith('audio/ogg')) return 'ogg';
    return 'webm';
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function formatMmss(sec) {
    const s = Math.max(0, Math.floor(sec));
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    return `${mm}:${String(ss).padStart(2, '0')}`;
}

export function isVoiceMessagingSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia
        && typeof MediaRecorder !== 'undefined');
}

export function initVoiceRecorder({ chatInputContainer, getOrderId, getSenderUid }) {
    if (!chatInputContainer) {
        console.warn('initVoiceRecorder: chatInputContainer missing');
        return;
    }
    if (!isVoiceMessagingSupported()) {
        // 非対応環境ではマイクボタンを出さない
        console.warn('MediaRecorder not supported; voice messaging disabled');
        return;
    }

    // マイクボタンを写真ボタンの隣に挿入（既にあればスキップ）
    let micBtn = chatInputContainer.querySelector('#voice-btn');
    if (!micBtn) {
        micBtn = document.createElement('button');
        micBtn.id = 'voice-btn';
        micBtn.type = 'button';
        micBtn.setAttribute('aria-label', 'voice message');
        micBtn.innerHTML = '<span class="material-symbols-outlined">mic</span>';
        Object.assign(micBtn.style, {
            border: 'none',
            background: 'var(--color-surface)',
            cursor: 'pointer',
            padding: '6px 8px',
            borderRadius: '50%',
            color: 'var(--color-text-sub)',
        });
        const photoBtn = chatInputContainer.querySelector('#photo-btn');
        if (photoBtn && photoBtn.nextSibling) {
            chatInputContainer.insertBefore(micBtn, photoBtn.nextSibling);
        } else {
            chatInputContainer.appendChild(micBtn);
        }
    }

    micBtn.addEventListener('click', startRecording);

    let isRecording = false;

    async function startRecording() {
        if (isRecording) return;
        isRecording = true;
        let stream = null;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (e) {
            console.error('getUserMedia failed:', e);
            alert(i18next.t('voice.errorPermission'));
            isRecording = false;
            return;
        }

        const mimeType = pickMimeType();
        const ext = inferExtension(mimeType);
        const options = { audioBitsPerSecond: RECORD_BITRATE };
        if (mimeType) options.mimeType = mimeType;

        let recorder;
        try {
            recorder = new MediaRecorder(stream, options);
        } catch (e) {
            console.error('MediaRecorder ctor failed:', e);
            stream.getTracks().forEach(t => t.stop());
            alert(i18next.t('voice.errorPermission'));
            isRecording = false;
            return;
        }

        const chunks = [];
        let startTs = Date.now();
        let stopReason = null;  // 'send' | 'cancel'
        let autoStopTimer = null;

        recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) chunks.push(e.data);
        };

        recorder.onstop = () => {
            if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; }
            const durationMs = Date.now() - startTs;
            const seconds = Math.min(MAX_DURATION_SEC, Math.max(1, Math.round(durationMs / 1000)));
            const blob = new Blob(chunks, { type: mimeType || chunks[0]?.type || 'audio/webm' });
            stream.getTracks().forEach(t => t.stop());
            hideRecordingOverlay();
            isRecording = false;
            if (stopReason === 'cancel') return;
            showPreviewModal(blob, seconds, ext, mimeType);
        };

        showRecordingOverlay({
            onStop: () => {
                stopReason = 'send';
                if (recorder.state !== 'inactive') recorder.stop();
            },
            onCancel: () => {
                stopReason = 'cancel';
                if (recorder.state !== 'inactive') recorder.stop();
            },
        }, startTs);

        recorder.start();

        // 90 秒で自動停止
        autoStopTimer = setTimeout(() => {
            if (recorder.state !== 'inactive') {
                stopReason = stopReason || 'send';
                recorder.stop();
            }
        }, MAX_DURATION_SEC * 1000);
    }

    // ── 録音中 UI ──
    let overlayEl = null;
    let timerInterval = null;

    function showRecordingOverlay({ onStop, onCancel }, startTs) {
        if (overlayEl) return;
        overlayEl = document.createElement('div');
        overlayEl.id = 'voice-recording-overlay';
        Object.assign(overlayEl.style, {
            position: 'fixed', left: '0', right: '0', bottom: '0',
            maxWidth: '480px', margin: '0 auto',
            background: '#fef3c7', borderTop: '2px solid #f97316',
            padding: '14px 16px calc(14px + env(safe-area-inset-bottom))',
            display: 'flex', alignItems: 'center', gap: '12px',
            zIndex: '1000',
        });
        overlayEl.innerHTML = `
            <span class="material-symbols-outlined" style="color:#dc2626;">fiber_manual_record</span>
            <div style="flex:1;">
                <div id="voice-rec-timer" style="font-weight:700; font-size:18px; color:#92400e;">0:00 / ${formatMmss(MAX_DURATION_SEC)}</div>
                <div style="font-size:11px; color:#92400e;">${escapeHtml(i18next.t('voice.recording'))}</div>
            </div>
            <button type="button" id="voice-rec-cancel" style="border:none; background:#fff; color:#dc2626; border-radius:999px; padding:8px 14px; font-weight:700; cursor:pointer; font-family:inherit;">${escapeHtml(i18next.t('voice.cancel'))}</button>
            <button type="button" id="voice-rec-stop" style="border:none; background:#0d6e4c; color:#fff; border-radius:999px; padding:8px 14px; font-weight:700; cursor:pointer; font-family:inherit;">${escapeHtml(i18next.t('voice.stop'))}</button>
        `;
        document.body.appendChild(overlayEl);
        overlayEl.querySelector('#voice-rec-cancel').addEventListener('click', onCancel);
        overlayEl.querySelector('#voice-rec-stop').addEventListener('click', onStop);

        const timerEl = overlayEl.querySelector('#voice-rec-timer');
        timerInterval = setInterval(() => {
            const sec = Math.floor((Date.now() - startTs) / 1000);
            timerEl.textContent = `${formatMmss(sec)} / ${formatMmss(MAX_DURATION_SEC)}`;
        }, 200);
    }

    function hideRecordingOverlay() {
        if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
        if (overlayEl) { overlayEl.remove(); overlayEl = null; }
    }

    // ── プレビュー → 送信/破棄 ──
    function showPreviewModal(blob, durationSec, ext, mimeType) {
        const modal = document.createElement('div');
        modal.id = 'voice-preview-modal';
        Object.assign(modal.style, {
            position: 'fixed', inset: '0',
            background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
            zIndex: '1001',
        });
        const audioUrl = URL.createObjectURL(blob);
        const sheet = document.createElement('div');
        Object.assign(sheet.style, {
            maxWidth: '480px', width: '100%',
            background: '#fff',
            borderRadius: '14px 14px 0 0',
            padding: '20px 16px calc(20px + env(safe-area-inset-bottom))',
            boxSizing: 'border-box',
        });
        sheet.innerHTML = `
            <div style="font-size:14px; font-weight:700; margin-bottom:12px; text-align:center;">${escapeHtml(i18next.t('voice.previewTitle'))}</div>
            <audio src="${audioUrl}" controls style="width:100%; margin-bottom:8px;"></audio>
            <div style="text-align:center; font-size:12px; color:#64748b; margin-bottom:14px;">${escapeHtml(i18next.t('voice.duration', { sec: durationSec }))}</div>
            <div style="display:flex; gap:10px;">
                <button type="button" id="voice-preview-discard" style="flex:1; border:1px solid var(--color-border); background:#fff; color:#dc2626; border-radius:14px; padding:12px; font-weight:700; cursor:pointer; font-family:inherit;">${escapeHtml(i18next.t('voice.discard'))}</button>
                <button type="button" id="voice-preview-send" style="flex:2; border:none; background:#0d6e4c; color:#fff; border-radius:14px; padding:12px; font-weight:700; cursor:pointer; font-family:inherit;">${escapeHtml(i18next.t('voice.send'))}</button>
            </div>
        `;
        modal.appendChild(sheet);
        document.body.appendChild(modal);

        const cleanup = () => {
            URL.revokeObjectURL(audioUrl);
            modal.remove();
        };
        modal.querySelector('#voice-preview-discard').addEventListener('click', cleanup);
        modal.querySelector('#voice-preview-send').addEventListener('click', async () => {
            const sendBtn = modal.querySelector('#voice-preview-send');
            sendBtn.disabled = true;
            try {
                await sendVoice(blob, durationSec, ext, mimeType);
                cleanup();
            } catch (e) {
                console.error('voice send failed:', e);
                alert(i18next.t('voice.errorSend') + '\n' + (e?.message || e?.code || ''));
                sendBtn.disabled = false;
            }
        });
        // 背景タップでキャンセル
        modal.addEventListener('click', (e) => { if (e.target === modal) cleanup(); });
    }

    // ── Storage upload + Firestore message doc 作成 ──
    // 順序:
    //   1) addDoc でメッセージ doc を仮作成（msgId 確定 + voiceUploadStatus='uploading'）
    //   2) Storage に voice/{orderId}/{msgId}.{ext} をアップロード
    //   3) doc を update して voiceStoragePath / voiceUrl / voiceUploadStatus='ready'
    //   通知 Cloud Function (onMessageCreated) は (1) で発火する点に注意。
    //   5/27 #100: 受信者側は voiceUploadStatus='ready' になるまで bubble を表示しない（renderVoiceBubble 側で分岐）
    async function sendVoice(blob, durationSec, ext, mimeType) {
        const orderId = getOrderId();
        const senderUid = getSenderUid();
        if (!orderId || !senderUid) throw new Error('orderId or senderUid missing');

        // 1) message doc を仮作成（type='voice'・通知トリガー発火）
        const docRef = await addDoc(collection(db, 'orders', orderId, 'messages'), {
            senderId: senderUid,
            type: 'voice',
            text: '',
            voiceDurationSec: durationSec,
            voiceMimeType: mimeType || blob.type || '',
            voiceStoragePath: null,
            voiceUrl: null,
            voiceUploadStatus: 'uploading',
            isRead: false,
            createdAt: serverTimestamp(),
        });
        const msgId = docRef.id;

        // 2) Storage upload
        const storagePath = `voice/${orderId}/${msgId}.${ext}`;
        const storageRef = ref(storage, storagePath);
        try {
            await uploadBytes(storageRef, blob, {
                contentType: mimeType || blob.type || 'audio/webm',
                cacheControl: STORAGE_CACHE_CONTROL,
            });
        } catch (e) {
            // Storage アップロード失敗 → voiceUploadStatus='failed' をセット
            try {
                await updateDoc(doc(db, 'orders', orderId, 'messages', msgId), {
                    voiceUploadStatus: 'failed',
                    text: '[voice upload failed]',
                });
            } catch (e2) { /* ignore */ }
            throw e;
        }
        const url = await getDownloadURL(storageRef);

        // 3) URL を doc に反映 + status='ready' で受信者側にも表示開始
        await updateDoc(doc(db, 'orders', orderId, 'messages', msgId), {
            voiceStoragePath: storagePath,
            voiceUrl: url,
            voiceUploadStatus: 'ready',
        });
    }
}

/**
 * メッセージ doc の type==='voice' を timeline に描画する HTML を返す。
 * delivery.html の既存ループから呼び出して使用する。
 *
 * @param {object} msg messages/{msgId} の data
 * @param {boolean} isSelf 自分の送信か
 * @param {string} timeStr 時刻表示
 * @returns {string} HTML
 */
export function renderVoiceBubble(msg, isSelf, timeStr) {
    const sec = Number(msg.voiceDurationSec || 0);
    const durLabel = formatMmss(sec);
    // 30日経過で自動削除済み（scheduled CF が voiceExpired=true をセット）
    if (msg.voiceExpired === true) {
        return `
            <div class="tl-chat ${isSelf ? 'self' : ''}">
                <div style="display:flex; align-items:center; gap:6px; color:#94a3b8; font-size:13px; font-style:italic;">
                    <span class="material-symbols-outlined">history</span>
                    <span>${escapeHtml(i18next.t('voice.expired'))}</span>
                </div>
                <div class="tl-chat__time">${escapeHtml(timeStr)}</div>
            </div>
        `;
    }
    // 5/27 #100: アップロード進行中は送信者本人のみに「アップロード中」表示
    // 受信者側は voiceUrl 反映 (status='ready') まで bubble を出さない（再生不可状態を見せない）
    const status = msg.voiceUploadStatus || (msg.voiceUrl ? 'ready' : 'uploading');
    if (status === 'failed') {
        if (!isSelf) return '';
        return `
            <div class="tl-chat self">
                <div style="display:flex; align-items:center; gap:6px; color:#dc2626; font-size:13px;">
                    <span class="material-symbols-outlined">error</span>
                    <span>${escapeHtml(i18next.t('voice.errorSend'))}</span>
                </div>
                <div class="tl-chat__time">${escapeHtml(timeStr)}</div>
            </div>
        `;
    }
    if (!msg.voiceUrl || status === 'uploading') {
        if (!isSelf) return '';
        return `
            <div class="tl-chat self">
                <div style="display:flex; align-items:center; gap:6px; color:#94a3b8; font-size:13px;">
                    <span class="material-symbols-outlined">graphic_eq</span>
                    <span>${escapeHtml(i18next.t('voice.uploading'))}</span>
                </div>
                <div class="tl-chat__time">${escapeHtml(timeStr)}</div>
            </div>
        `;
    }
    return `
        <div class="tl-chat ${isSelf ? 'self' : ''}">
            <div style="display:flex; align-items:center; gap:8px;">
                <span class="material-symbols-outlined" style="color:#0d6e4c;">graphic_eq</span>
                <audio src="${escapeHtml(msg.voiceUrl)}" controls preload="metadata" style="flex:1; max-width:220px; height:36px;"></audio>
                <span style="font-size:11px; color:#64748b; white-space:nowrap;">${escapeHtml(durLabel)}</span>
            </div>
            <div class="tl-chat__time">${escapeHtml(timeStr)}</div>
        </div>
    `;
}
