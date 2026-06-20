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

        recorder.onstop = async () => {
            if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; }
            const durationMs = Date.now() - startTs;
            const seconds = Math.min(MAX_DURATION_SEC, Math.max(1, Math.round(durationMs / 1000)));
            const blob = new Blob(chunks, { type: mimeType || chunks[0]?.type || 'audio/webm' });
            stream.getTracks().forEach(t => t.stop());
            hideRecordingOverlay();
            isRecording = false;
            if (stopReason === 'cancel') return;
            // 6/18 #156 ④a: 録音→送信を1タップに簡略化（プレビューモーダル廃止）。停止＝即送信。
            try {
                await sendVoice(blob, seconds, ext, mimeType);
            } catch (e) {
                console.error('voice send failed:', e);
                alert(i18next.t('voice.errorSend') + '\n' + (e?.message || e?.code || ''));
            }
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
        // 6/18 #156 ④a/④c: 破棄（discard・グレー）／送信（send＝停止+送信を1タップ・青 var(--color-cta)）。
        overlayEl.innerHTML = `
            <span class="material-symbols-outlined" style="color:#dc2626;">fiber_manual_record</span>
            <div style="flex:1;">
                <div id="voice-rec-timer" style="font-weight:700; font-size:18px; color:#92400e;">0:00 / ${formatMmss(MAX_DURATION_SEC)}</div>
                <div style="font-size:11px; color:#92400e;">${escapeHtml(i18next.t('voice.recording'))}</div>
            </div>
            <button type="button" id="voice-rec-cancel" style="border:1px solid #dde3e9; background:#fff; color:#5a6470; border-radius:999px; padding:8px 14px; font-weight:700; cursor:pointer; font-family:inherit;">${escapeHtml(i18next.t('voice.discard'))}</button>
            <button type="button" id="voice-rec-stop" style="border:none; background:var(--color-cta); color:#fff; border-radius:999px; padding:8px 14px; font-weight:700; cursor:pointer; font-family:inherit;">${escapeHtml(i18next.t('voice.send'))}</button>
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
    // 6/18 #156 ④b: native <audio controls> 廃止→カスタム表示（▶＋簡易波形＋秒数）。
    //   再生はバブルごとの非表示 <audio> を .vp クリックで toggle（chat-timeline.js の委譲ハンドラ）。
    //   波形は静的8本（高さは固定パターン）。受信側は薄い色（CSSの .tl-chat:not(.self) で分岐）。
    const waveBars = [6, 12, 18, 9, 15, 7, 13, 5]
        .map(h => `<i style="height:${h}px"></i>`).join('');
    return `
        <div class="tl-chat ${isSelf ? 'self' : ''}">
            <div class="voice">
                <button type="button" class="vp" aria-label="play"><span class="material-symbols-outlined">play_arrow</span></button>
                <span class="wave">${waveBars}</span>
                <span class="vdur">${escapeHtml(durLabel)}</span>
                <audio src="${escapeHtml(msg.voiceUrl)}" preload="none" style="display:none;"></audio>
            </div>
            <div class="tl-chat__time">${escapeHtml(timeStr)}</div>
        </div>
    `;
}

/**
 * 音声バブルの ▶/⏸ 再生トグル（イベント委譲）。document に1回だけ束ねる＝
 * delivery 両ページとも chat-timeline.js を import するため共通で効く。
 * 再描画（onSnapshot）後も委譲なので有効。同時に1つだけ再生（他は停止）。
 */
let __voicePlaybackBound = false;
export function bindVoicePlayback() {
    if (__voicePlaybackBound || typeof document === 'undefined') return;
    __voicePlaybackBound = true;
    document.addEventListener('click', (e) => {
        const vp = e.target.closest && e.target.closest('.voice .vp');
        if (!vp) return;
        const audio = vp.parentElement && vp.parentElement.querySelector('audio');
        if (!audio) return;
        const icon = vp.querySelector('.material-symbols-outlined');
        if (audio.paused) {
            // 他の再生中音声を止める
            document.querySelectorAll('.voice audio').forEach(a => {
                if (a !== audio && !a.paused) {
                    a.pause();
                    const ic = a.parentElement && a.parentElement.querySelector('.vp .material-symbols-outlined');
                    if (ic) ic.textContent = 'play_arrow';
                }
            });
            audio.play().then(() => { if (icon) icon.textContent = 'pause'; }).catch(() => {});
            audio.onended = () => { if (icon) icon.textContent = 'play_arrow'; };
            audio.onpause = () => { if (icon) icon.textContent = 'play_arrow'; };
        } else {
            audio.pause();
            if (icon) icon.textContent = 'play_arrow';
        }
    });
}
