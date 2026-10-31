# 眠りの音（睡眠音記録アプリ）— Claude Code 用プロジェクトメモ

このファイルは Claude Code が作業開始時に読む引き継ぎメモ。プロジェクトのルート（`config.xml` と同じ場所）に置く。

## 1. アプリの概要

- 名前: 眠りの音（App ID は Monaca の iOS / Android アプリ設定を参照）
- 目的: 睡眠中のいびき・寝言・歯ぎしりなど、大きめの音が「いつ・どれくらい続いたか」を記録して振り返る
- 現在のバージョン: アプリ v0.6.0 ／ 録音プラグイン v0.6.0 ／ ストアの版（config.xml の version）1.0
- 詳細仕様書（Claude Docs）: https://claude.ai/code/artifact/9b21a65a-e94c-4e65-8d52-0113d09d7eab
- 医療機器ではない。診断・治療・「無呼吸」の判定などの表現はアプリ内・ストア説明文ともに使わない

## 2. 開発環境と制約（必ず守る）

- Monaca（Cordova）で開発。**Mac は無い**。iOS のビルドは Monaca のクラウドビルドのみ。ローカルで xcodebuild / Android Studio は使えない
- Windows + VS Code + Monaca CLI。主に使うコマンドは次の2つだけ
  - `monaca upload` … 手元の変更をクラウドへ反映（カスタムビルドデバッガーには即反映）
  - `monaca remote build --browser` … ブラウザでビルド画面を開く
- `monaca preview` / `monaca debug` など npm を内部で呼ぶコマンドは、Windows 版 Node.js の仕様変更で `spawn EINVAL` になる。`monaca clone` 後の依存関係は手動で `npm install`
- Monaca のビルド環境は Cordova 13（cordova-ios 8）。Swift を書くときの注意:
  - `CDVPluginResult(...)` は optional ではない。`r?.xxx` と書かない（`keepCallback(_:)` のように optional 引数で受ける書き方にする）
  - `self.viewController` も、新旧どちらでも通るよう `let v: UIViewController? = self.viewController` で受けてから使う
  - 新旧の cordova-ios どちらでもコンパイルできる書き方を優先する
- ネイティブ（Swift / Java）はこの環境でコンパイル確認できない。変更したら、ビルドログを `logs/` に保存してもらって確認する

## 3. ファイル構成

```
config.xml                    Monaca が管理。上書きせず、必要な設定だけ書き足す
package.json                  Monaca が管理（プラグイン参照あり）。上書き禁止
www/
  index.html                  全画面（同意・ホーム・記録中・記録の詳細・設定）
  css/style.css               デザイン（夜の藍＋琥珀のランプ色。琥珀は記録に関わる要素だけ）
  js/app.js                   画面と操作
  js/analysis.js              記録後の解析（続いた音の時間帯の判定）。ブラウザと Node の両方で動く
  js/chart.js                 音量グラフ（Canvas、自前描画）
  js/sample.js                サンプルの記録（合成した1秒値）。ホームの「サンプルの記録を表示」とモックが使う
  js/mock.js                  ブラウザ確認用モック（Cordova が無いときだけ使われる）
res/custom_plugins/cordova-plugin-sleep-recorder/   録音プラグイン（Monaca のカスタムプラグイン）
  plugin.xml / www/sleepRecorder.js
  src/ios/      SleepRecorderPlugin.swift, RecorderEngine.swift（AdtsFileWriter を含む）,
                AudioTrimmer.swift, SessionStore.swift
  src/android/  SleepRecorderPlugin.java, RecorderService.java, AdtsWriter.java,
                AudioTrimmer.java, SessionStore.java
res/ios/icon, res/android/icon アプリアイコン（元データは tools/app-icon*.svg。tools/make-icons.js → make-icons.py で作り直す）
                              iOS は RGB（アルファなしでないと App Store で却下）。Android はアダプティブアイコン（*-foreground / *-background）
res/ios/screen, res/android/screen 起動画面。スプラッシュは出さない方針のため、藍色（#1A2138）の無地／透明のアイコン
tools/
  analysis-test.js            解析のテスト: `node tools/analysis-test.js`
  app-icon.svg / app-icon-1024.png      アイコンの元データ（-foreground / -background は Android 用）
  make-icons.js / make-icons.py         アイコン・起動画面の画像を res/ に書き出す
  store-screenshots.js        App Store 用スクリーンショット（1320×2868）を store/screenshots/ に作る
store/                        ストア提出用の資料（アプリには含めない）。審査メモ・申告・テスト手順は store/README.md
  privacy-policy.html         プライバシーポリシーの公開用ページ（アプリ内の文面と合わせる）
```

## 4. 仕組み（v0.6.0 以降）

1. 記録中: ネイティブが一晩すべてを ADTS 形式の AAC（16kHz・モノラル・24kbps、+30dB 増幅＋tanh で頭打ち）で `clips/full.aac` に書き続け、1秒値（100ms ごとの RMS の最大値、0.1dB 単位の int16）を `graph.bin` に30秒ごとに追記する。1時間で約11MB、12時間で約130MB
2. 記録後: 次にアプリを開いたとき（または停止直後）、JS の `analysis.js` が 1秒値から「続いた音」の時間帯を3つの感度で判定し、`saveAnalysis` で meta.analysis（counts など）に保存する。**`full.aac` は削除しない**（v0.5 までは `trimAudio` で時間帯だけ残して削除していた。古いプラグインのときだけこの動作になる）
3. 再生: `cutClip(id, start, end, name)` で `full.aac` から必要な範囲をフレーム単位でコピーして `play1.aac` / `play2.aac`（交互）に書き出し、`playClip` で再生する（再変換なし。ADTS を直接シークすると iOS で位置がずれるため）
   - 時間帯の再生: 一覧の ▶。前後5秒を含めて切り出し、終わりで止まる
   - 好きな時刻から: グラフの帯以外をタップ → 「○:○○:○○ から再生」。30分ずつ切り出し、終わりの20秒前に次を用意して、記録の最後まで続けて再生する。シークバーは記録全体
4. 判定: 1秒値の前後10秒平均（橙の線）が「前後60分の下位5%（いちばん静かなときの音）＋感度」を超え、30秒以内の途切れはつなぎ、30秒以上続いたもの。感度は 低8／中5／高3 dB。開始60秒は対象外
5. 保存: セッションは最大30件。10分未満は保存しない。音声は新しい保存セッション3件のみ残す（`audioSessions` / `AUDIO_SESSIONS`）
6. 同意: データの取り扱いを変えたら app.js の `CONSENT_VERSION` を上げる（既存の利用者にも同意画面が再表示される）。v0.6 で 2
7. データの置き場所: iOS は Application Support/sessions（バックアップ対象外）、Android は filesDir/sessions。外部送信なし

## 5. これまでにハマったこと（同じ失敗をしない）

- **プラグインの更新がビルドに反映されない**ことが2回あった。原因はビルド失敗に気づかず古いデバッガーを使い続けたこと、または `monaca download` の前に `monaca upload` して古いプラグインでクラウドを上書きしたこと
  - 手順: プラグインを変えたら `res/custom_plugins/...` を編集 → `monaca upload` → カスタムビルドデバッガーをビルド → **成功を確認してから**インストール
  - 確認: アプリの設定画面の一番下「録音プラグイン 0.6（最新）」。古いと記録開始時に警告が出る（app.js の `pluginIsCurrent`。`cutClip` の有無で判定）。プラグインの版を上げたら、この判定も更新する
- 記録の詳細画面に「感度 中 (xdB)」と出ても、それだけでは新しいネイティブで録音された証拠にならない（meta.algo === 3 かどうかで判断。v0.6 以降は meta.analysis があり、audio が 'full' のままかも見る）
- `package.json` や `config.xml` を丸ごと上書きすると、Monaca のプラグイン管理が壊れる

## 6. 作業の進め方

- 画面の変更は、まずブラウザで `www/index.html` を開いてモックで確認する（Playwright でのスクリーンショット確認も可）
- 解析のロジックを変えたら `node tools/analysis-test.js` を通す。実機のグラフに近い合成データでテストしている
- ネイティブを変えたら、Swift と Java の両方を同じ仕様で直す
- 文言: 日本語、ですます調、医療的な表現は使わない。ボタン名は動作を表す短い言葉
- 変更したら README.md の変更履歴と、詳細仕様書の該当章を更新する（仕様書の更新は claude.ai 側で依頼）

## 7. 残っている作業（App Store 公開まで）

- [x] App Store 用の設定: `config.xml` に iPhone 専用（`<preference name="target-device" value="handset" />`）、暗号化の申告（`ITSAppUsesNonExemptEncryption` = false を edit-config で Info.plist へ）
- [x] 審査用のデモ: 記録は10分未満だと保存されないため、審査担当者がすぐ確認できる「サンプルの記録を表示」機能、または審査メモでの説明を用意する
- [ ] プライバシーポリシーを公開URLに置く（`store/privacy-policy.html` は問い合わせ先まで記入済み。公開して、URLを App Store Connect と Google Play に登録する）
- [x] スクリーンショット（6.9インチ: 1320×2868）を用意する（`store/screenshots/`）
- [ ] Android: Google Play のフォアグラウンドサービス（マイク）申告用のデモ動画（撮影手順と申告文の例は `store/README.md`）
- [ ] 8時間の連続記録テストを、カスタムビルドデバッガーではなく TestFlight（リリースビルド）で行う（確認項目は `store/README.md`）
