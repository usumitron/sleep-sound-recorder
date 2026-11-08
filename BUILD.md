# Monaca と Mac を使わないビルド

Monaca のクラウドビルドの代わりに、Cordova CLI で直接ビルドする。

- **Android**: この Windows PC でビルドできる。GitHub Actions でもビルドできる
- **iOS**: GitHub Actions のクラウド上の Mac（macOS ランナー）でビルドする。Mac は不要

プロジェクトの `package.json` と `config.xml` は変更しない。そのため、Monaca でのビルドも今までどおり使える。
ビルドには、Monaca 専用で、このアプリでは使っていない `monaca-plugin-monaca-core` を含めない。

## 1. Android を手元でビルドする（Windows）

```
node tools/native-build.js android
```

- できるもの: `dist/nemurinooto-<版>-debug.apk`（デバッグ版。実機に直接インストールできる）
- 必要なもの: Node.js、JDK 17 以降、Android SDK（`ANDROID_HOME`）
  - Gradle が PATH に無くても、`~/.gradle` のキャッシュから自動で探す
- 作業フォルダ: OS の一時フォルダの `nemurinooto-native-build`。プロジェクトの外に置く
- 実機へのインストール: `adb install -r dist\nemurinooto-1.0.0-debug.apk`

Google Play 用の署名付き AAB を作るときは、次の環境変数を設定してから実行する。

```
node tools/native-build.js android --release
```

| 環境変数 | 内容 |
|---|---|
| `ANDROID_KEYSTORE` | キーストア（.jks / .keystore）のパス |
| `ANDROID_KEYSTORE_PASSWORD` | キーストアのパスワード |
| `ANDROID_KEY_ALIAS` | キーの別名 |
| `ANDROID_KEY_PASSWORD` | キーのパスワード |

## 2. GitHub Actions でビルドする（iOS / Android）

ワークフローは `.github/workflows/build.yml`。

- **master に push したとき**（自動）
  - 解析のテストを実行する
  - Android のデバッグ版 APK をビルドする
  - iOS のシミュレーター用ビルドを行う。署名は不要
  - Swift と Java のコンパイルが通るかを、ここで確認できる
- **手動で実行するとき**（GitHub の Actions → Build → Run workflow）
  - `release` にチェックを入れると、ストア提出用の署名付き AAB / IPA を作る
  - さらに `testflight` にもチェックを入れると、IPA を TestFlight にアップロードする
- **結果の取り出し方**: 実行結果のページ下部にある Artifacts から、`android` / `ios` を zip で取り出す
  - 中身は出力ファイルとビルドログ（`build-*.log`）
  - ビルドに失敗したら、ログを `logs/` に置いて Claude Code に確認を頼む

**費用**

- 公開リポジトリなら無料
- 非公開リポジトリでは、macOS ランナーは 1 分を 10 分として数える。無料枠（月 2,000 分）で使える macOS の実時間は約 200 分。iOS のビルドは 1 回 10 分前後かかる

## 3. 署名の情報を GitHub に登録する（ストア提出用だけ）

GitHub のリポジトリ → Settings → Secrets and variables → Actions → New repository secret で登録する。

- 鍵やパスワードはリポジトリにコミットしない
- チャット（Claude）にも貼り付けない。組織のルールで処理が止まる
- 下の手順で作ったファイルは、登録が済んだら安全な場所に保管する
- ファイルを Base64 の文字列にしてクリップボードへコピーするには、PowerShell で次を実行する

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\file")) | Set-Clipboard
```

### iOS

| Secret | 内容 |
|---|---|
| `IOS_TEAM_ID` | Apple Developer のチーム ID（10 文字。Membership のページに表示されている） |
| `IOS_CERT_P12_BASE64` | 配布用証明書（.p12）を Base64 にしたもの |
| `IOS_CERT_PASSWORD` | .p12 を書き出したときに決めたパスワード |
| `IOS_PROFILE_BASE64` | App Store 用プロビジョニングプロファイル（.mobileprovision）を Base64 にしたもの |
| `ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_KEY_P8_BASE64` | TestFlight へのアップロード用。App Store Connect API キーの ID、発行者 ID、.p8 を Base64 にしたもの |

**配布用証明書（.p12）を Windows で作る**

Git for Windows の `openssl` を使う。Git Bash で次の手順を実行する。

1. 秘密鍵と、証明書の署名要求（CSR）を作る。

   ```bash
   openssl genrsa -out ios_distribution.key 2048
   openssl req -new -key ios_distribution.key -out ios_distribution.csr -subj "/emailAddress=<Apple ID のメール>/CN=<名前>/C=JP"
   ```

2. 証明書を発行する。
   - developer.apple.com → Certificates, IDs & Profiles → Certificates → ＋ → **Apple Distribution** を選ぶ
   - 手順 1 の `.csr` をアップロードし、`distribution.cer` をダウンロードする
3. .p12 に変換する。
   - 書き出すときに決めたパスワードを、`IOS_CERT_PASSWORD` に登録する
   - 暗号方式を指定しているのは、macOS が読める形式にするため

   ```bash
   openssl x509 -inform DER -in distribution.cer -out distribution.pem
   openssl pkcs12 -export -inkey ios_distribution.key -in distribution.pem -out ios_distribution.p12 \
     -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
   ```

- Monaca で作った証明書の秘密鍵が手元に無いときは、上の手順で新しく作ってよい。配布用証明書は複数持てる

**プロビジョニングプロファイル**

1. Certificates, IDs & Profiles → Profiles → ＋ → **App Store Connect** を選ぶ
2. App ID に `jp.usumitron.nemurinooto`、証明書に上で作ったものを選ぶ
3. .mobileprovision をダウンロードする

- 証明書を作り直したら、プロファイルも作り直す

**App Store Connect API キー**（TestFlight へのアップロードに使う）

1. App Store Connect → ユーザとアクセス → 統合 → App Store Connect API → キーを生成する。アクセス権は「App マネージャ」
2. .p8 をダウンロードする。ダウンロードできるのは一度だけ
3. キー ID と発行者 ID を控える

**ビルド番号**: iOS のビルド番号（CFBundleVersion）には GitHub Actions の実行番号を自動で入れる。アップロードのたびに上がる。
アプリの版（1.0.0 など）は、今までどおり `config.xml` の `version` で上げる。

### Android

| Secret | 内容 |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | キーストアを Base64 にしたもの |
| `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD` | 1. の表と同じ |

- **Google Play にすでに Monaca でビルドしたものを出している場合**: Monaca の「Android キーストア設定」からキーストアをエクスポートして使う。違う鍵だと更新を出せない
- **まだ出していない場合**: 新しく作ってよい。Play App Signing を使うと、この鍵はアップロード鍵になる

  ```
  keytool -genkeypair -v -keystore upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000
  ```

## 4. 仕組みのメモ

- `tools/native-build.js` は、次の 3 つを作業フォルダにコピーしてから Cordova でビルドする
  - `config.xml`、`www/`、`res/`（録音プラグインを含む）
  - 作業フォルダ用の `package.json`
- 版は Monaca のビルド環境に合わせている（cordova-android 15.1.0 / cordova-ios 8.1.0）
- 毎回 `platforms/` と `plugins/` を作り直す。古い録音プラグインのままビルドされることはない
- Monaca のビルド設定（`build.json`）は使わない。署名の設定は環境変数から作る
