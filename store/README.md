# ストア提出用の資料

このフォルダはアプリには含めない（`.monacaignore` で除外）。

| ファイル | 内容 |
|---|---|
| `privacy-policy.html` | プライバシーポリシーの公開用ページ（2026-10-31 改定: 一晩分の音声を3回分残すように変更）。アプリ内の文面（`www/index.html` の `policy-template`）をもとにしている。どちらかを変えたら、もう一方も合わせる |
| `screenshots/` | App Store 用スクリーンショット（6.9インチ: 1320×2868）。`tools/store-screenshots.js` で作り直せる |

## プライバシーポリシーの公開

1. `privacy-policy.html` の「お問い合わせ」の【要記入】を埋める
2. 公開URLに置く（例: GitHub Pages、または自分のサイト）
3. そのURLを App Store Connect の「プライバシーポリシーURL」と Google Play Console に登録する

## スクリーンショットの作り直し

```
# playwright はプロジェクトの package.json に入れない（Monaca の管理が壊れるため）。別のフォルダに入れる
cd <作業用フォルダ> && npm init -y && npm i playwright
# プロジェクトのルートで
NODE_PATH=<作業用フォルダ>/node_modules node tools/store-screenshots.js [chrome.exe のパス]
```

モックのデータ（`www/js/sample.js`）で撮るため、実機の画面と同じ見た目になる。ステータスバーは入らない。

## App Store 審査メモ（App Review Information → Notes）

> This app records sounds such as snoring or sleep talking during the night and shows when loud sounds continued.
> Recordings shorter than 10 minutes are not saved, so a real recording cannot be checked quickly.
> To see the result screen right away, tap "サンプルの記録を表示" (Show sample record) on the Home screen. It shows a graph and the detected time ranges made from synthetic data (no audio).
> To test recording: tap "記録を始める" (Start), allow microphone access, wait at least 10 minutes, then press and hold "長押しで停止" (Hold to stop). The detected time ranges are listed with playback buttons, and tapping anywhere on the graph lets you play the recording from that time.
> Background audio (UIBackgroundModes: audio) is used only to keep recording from the microphone while the screen is off during the night. No data leaves the device. No login is required.
> This app is not a medical device and does not diagnose any condition.

## App Store Connect の入力メモ

- App のプライバシー（データの収集）: 「データを収集しない」（すべて端末内で処理し、外部へ送信しないため）
- 輸出コンプライアンス: `config.xml` で `ITSAppUsesNonExemptEncryption = false` を設定済み
- 対応デバイス: iPhone のみ（`target-device = handset`）
- カテゴリ: 「ヘルスケア／フィットネス」または「ライフスタイル」。説明文に診断・治療・「無呼吸」などの表現を使わない

## Android: フォアグラウンドサービス（マイク）申告用のデモ動画

Google Play Console の「フォアグラウンドサービスの権限」で、`FOREGROUND_SERVICE_MICROPHONE` の用途を説明する動画（YouTube の限定公開URLなど）が必要。端末の画面収録で、次の流れを1本（1〜2分）に収める。

1. ホームで「記録を始める」をタップ → マイク・通知の許可
2. 記録中の画面 → ホームボタンでアプリを閉じ、通知領域に記録中の通知が出ていることを見せる
3. 画面を消す → 少し待って画面をつけ、通知から戻ると記録が続いていることを見せる
4. 「長押しで停止」→ 記録の画面（10分以上記録した後で撮ると、時間帯と再生まで見せられる。撮影時間を短くするなら、停止後の部分だけ別に撮ってつなぐ）

申告文の例: 「利用者が開始した睡眠中の音の記録を、画面を消した後も続けるためにマイクのフォアグラウンドサービスを使います。記録は利用者が停止するか、設定した時刻になると終了します。」

## 8時間の連続記録テスト（TestFlight）

カスタムビルドデバッガーではなく、リリースビルドを TestFlight で入れて行う。

- [ ] 充電しながら、設定した時刻まで記録が続き「時刻で自動終了」になる
- [ ] 充電せずに記録したときのバッテリーの減り方（目安を記録しておく）
- [ ] 翌朝アプリを開くと、時間帯ごとに再生できる。グラフの好きな位置をタップして、その時刻から再生できる
- [ ] 好きな時刻からの再生が30分の切れ目で止まらずに続く（途切れはわずかか）。後半（6時間目以降）でもグラフの再生位置と音がずれていない
- [ ] 設定画面の一番下が「録音プラグイン 0.6（最新）」になっている（新しいネイティブで録音されたかは、詳細画面の感度表示ではなく meta.algo === 3 で判断する）
- [ ] 途中で他のアプリの音を鳴らしたときに「途中で中断」として保存される
- [ ] 4回目の記録を保存すると、4つ前の記録の音声が消えてグラフのみになる（空き容量の増え方は1回あたり約11MB／時間）
