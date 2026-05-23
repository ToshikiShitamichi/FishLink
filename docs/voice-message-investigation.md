# ボイスメッセージ機能 要件調査（#73）

調査日: 2026-05-14
背景: 文字入力が苦手なレストラン関係者向けに、チャット（運営チャット・取引チャット）で音声録音・再生機能を提供する案。

---

## 1. 録音 → アップロード → 再生 のUI/UX

### 録音
- **API**: `MediaRecorder API`（モダンブラウザ・iOS Safari 14.5+ で利用可）
- **ブラウザ対応**:
  - Chrome / Edge: 安定（webm/opus 推奨）
  - iOS Safari: 14.5+ 対応・出力は `audio/mp4` 固定。MIME 指定不可。
  - Android Chrome: 安定（webm/opus）
- **権限**: `navigator.mediaDevices.getUserMedia({ audio: true })` でマイク許可ダイアログ
  - PWA から呼び出す場合、HTTPS 必須（Firebase Hosting なので問題なし）
  - 一度許可されると以降ダイアログは出ない（ブラウザ設定でリセット可能）
- **モバイル特有の注意**:
  - iOS では `<input type="file" accept="audio/*" capture>` でネイティブ録音 UI を呼び出す手も。MediaRecorder の互換性問題を避けたい場合の代替。
  - Android では Chrome タブ切替で録音が中断される。録音中の状態管理が必要。

### アップロード
- Firebase Storage に `voice/{orderId}/{msgId}.webm` のように保存
- 録音ファイルサイズ目安（opus 32kbps）:
  - 10秒 ≈ 40KB
  - 30秒 ≈ 120KB
  - 60秒 ≈ 240KB
- 既存 `image-resize.js` の `uploadImageResized` パターン同様のリトライ機構が望ましい
- 最大録音時間は **60秒** を推奨（コスト・UX両面）

### 再生
- HTML5 `<audio>` 要素で再生
- 自動再生は iOS でブロックされるためタップ再生のみ
- 既読管理: 既存 `isRead` フィールドをそのまま流用可能

### UI 提案
- メッセージ入力欄に **マイクボタン** を追加（既存の送信ボタンの隣）
- 長押しで録音開始 → 離す or タップで停止 → プレビュー → 「送る/破棄」
- 受信側はチャット吹き出し内に再生ボタン＋波形表示（or 単純な秒数表示）

---

## 2. Firebase Storage / Firestore コスト試算

### 前提
- PoC スケール: アクティブユーザー 100 名（農家60 + レストラン40）
- 平均: 1 ユーザーあたり 1 日 5 件のボイスメッセージ送信、10 件再生
- 平均録音長: 20 秒（≈ 80KB）
- 保存期間: 30 日（その後は自動削除 or 任意）

### Storage（ストレージ容量）
- 1 日のアップロード: 100 × 5 × 80KB = **40 MB/日**
- 30 日蓄積: **1.2 GB**
- Firebase Spark 無料枠: Storage 5 GB → 余裕あり
- Blaze プラン課金: $0.026/GB-月 → **約 $0.03/月**（無視できる）

### Storage（ダウンロード = Egress）
- 1 日の再生: 100 × 10 × 80KB = **80 MB/日**
- 30 日: **2.4 GB**
- Spark 無料枠: 1 GB/日 → ギリギリ収まる
- Blaze プラン課金: $0.12/GB → **約 $0.29/月**

### Firestore（メタデータ）
- 既存 `messages/{msgId}` に `type: 'voice'` `storagePath` `duration` フィールドを追加するだけ
- ドキュメント数増加なし → 既存と同じコスト構造（読み取り課金が主）
- 追加コスト ≈ **$0**

### 合計（PoC スケール）
- **約 $0.30 〜 $0.50 / 月**（Blaze プラン前提）
- Spark 無料枠でも運用可能だが、Egress 1GB/日 を超えるとブロックされる
- 本格運用（1000 ユーザー × 10 件/日 想定）でも **$3 〜 $5 / 月** 程度

---

## 3. PoC 段階の Free/Spark 枠への影響

- 現在の Firestore + Hosting + Functions 利用量は Spark 内に収まっている想定
- ボイスメッセージ追加で：
  - **Storage egress が懸念**（無料 1 GB/日 を超えると 24時間ブロック）
  - PoC アクティブ 30 ユーザーまでなら問題なし
  - それを超えるなら Blaze プラン移行検討（実コスト月 $1〜2）

---

## 4. 既存メッセージスキーマへの音声タイプ追加方針

### 既存 `messages/{msgId}` フィールド
```
senderId, text, type: 'chat'|'status', isRead, createdAt
```

### 追加フィールド案
```
type: 'chat'|'status'|'voice'
voiceStoragePath: 'voice/{orderId}/{msgId}.webm'   // type==='voice' のときのみ
voiceUrl: '<getDownloadURL の結果>'                  // 即時再生用キャッシュ
voiceDurationSec: 23                                 // 秒数（UIで表示）
voiceMimeType: 'audio/webm;codecs=opus' | 'audio/mp4' // 環境差吸収
```

### 互換性
- 既存の `text` 表示ロジックには影響しない（`type` で分岐）
- 通知（FCM）: `type: 'voice'` のとき body を「🎤 ボイスメッセージ (20秒)」のような文言に
  - **CLAUDE.md ルール**: 通知本文は絵文字を避け、アイコンフォントは通知では使えないので `[ボイス]` 等のラベルテキストで代替

### Firestore セキュリティルール
- `voiceStoragePath` の存在で勝手な書き換えを防ぐため、create のみ許可・update では voice 系フィールドを変更不可にする

### Storage セキュリティルール
- `voice/{orderId}/{msgId}.{ext}` への書き込みは「orderId の参加者のみ」
- 読み取りは同上

---

## 5. 推奨判断

### Phase 1（PoC 段階・最小実装）
- 録音 60 秒上限・モバイル UI のみ
- 一旦 **取引チャット（orders/{id}/messages）** にのみ実装。運営チャットは後追い。
- iOS / Android Chrome / Safari の全パターン手動テスト
- Spark 枠内で運用可能

### Phase 2（ネイティブアプリ化以降）
- ネイティブの録音 API を使うほうが安定（特に iOS のバックグラウンド対応）
- React Native + Expo なら `expo-av` で簡単に実装可能
- 文字起こし（音声→テキスト）も追加検討の余地（Google Cloud Speech-to-Text、$0.024/分）

---

## 6. 意思決定が必要な点

クライアントに確認したい項目:

1. **対象範囲**: 取引チャットのみ？ 運営チャットも含む？
2. **最大録音時間**: 60秒で十分か、90秒・120秒が必要か
3. **保存期間**: 配送完了後どれくらいで削除するか（コスト/トラブル証跡のバランス）
4. **PWA 継続か、ネイティブ待ちか**: PWA でも MediaRecorder で実装可能だが、iOS の安定性は妥協が必要
5. **文字起こし（Phase 2）**: 検索可能にしたいか、純粋に音声のみで OK か

---

## 結論

- 技術的実装難易度: **中**（MediaRecorder の iOS 互換が要注意）
- コスト影響: **小**（PoC スケールで月 $0.50 以下）
- スキーマ変更: **小**（既存 messages に 4 フィールド追加のみ）
- 推奨着手タイミング: **次回 MTG でクライアント意思決定後**。ネイティブ化を待たずに PWA で先行実装可能。
