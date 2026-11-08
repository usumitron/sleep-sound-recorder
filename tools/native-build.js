/*
 * Monaca を使わずにアプリをビルドする（Cordova CLI を直接使う）。
 *
 *   node tools/native-build.js android            … デバッグ版 APK（Windows でも可）
 *   node tools/native-build.js android --release  … 署名付き AAB（Google Play 用）
 *   node tools/native-build.js ios                … シミュレーター用（署名なし。Swift のコンパイル確認）
 *   node tools/native-build.js ios --release      … 署名付き IPA（App Store / TestFlight 用。macOS のみ）
 *
 * - プロジェクトの package.json / config.xml には手を触れない。一時フォルダ（NATIVE_BUILD_DIR で変更可）に
 *   必要なファイルをコピーし、Monaca 専用のプラグイン（monaca-plugin-monaca-core。アプリでは使っていない）を外してビルドする
 * - 毎回 platforms/ と plugins/ を作り直す（古い録音プラグインのままビルドされるのを防ぐ）
 * - できたファイルは dist/ に置く
 * - 署名の情報は環境変数で渡す（ファイルやリポジトリには書かない）
 *     Android: ANDROID_KEYSTORE（.jks のパス）, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD
 *     iOS:     IOS_TEAM_ID, IOS_PROFILE_UUID（証明書はキーチェーンに入れておく）
 *   ほかに IOS_BUILD_NUMBER（iOS のビルド番号）を指定できる
 */
'use strict';
var fs = require('fs');
var os = require('os');
var path = require('path');
var spawnSync = require('child_process').spawnSync;

// Monaca のビルド環境（Cordova 13）に合わせる
var PLATFORM_VERSIONS = { android: '15.1.0', ios: '8.1.0' };
var MONACA_ONLY_PLUGINS = ['monaca-plugin-monaca-core'];

var ROOT = path.join(__dirname, '..');
// 作業フォルダはプロジェクトの外に置く（Documents の中だと Windows でファイルの権限変更に失敗することがある）
var WORK = path.resolve(process.env.NATIVE_BUILD_DIR || path.join(os.tmpdir(), 'nemurinooto-native-build'));
var DIST = path.join(ROOT, 'dist');

var platform = process.argv[2];
var release = process.argv.indexOf('--release') >= 0;
if (!PLATFORM_VERSIONS[platform]) {
  console.error('使い方: node tools/native-build.js android|ios [--release]');
  process.exit(2);
}
if (platform === 'ios' && process.platform !== 'darwin') {
  console.error('iOS のビルドは macOS が必要です（GitHub Actions の「Build」ワークフローを使ってください）');
  process.exit(2);
}

function run(cmd, args, env) {
  console.log('\n$ ' + cmd + ' ' + args.join(' '));
  // Windows の .cmd は shell 経由でないと spawn EINVAL になる
  // Cordova は cwd より環境変数 PWD を優先してプロジェクトを探すため、PWD も作業フォルダにする
  env = Object.assign({}, env || process.env, { PWD: WORK });
  var r = spawnSync(cmd, args, { cwd: WORK, stdio: 'inherit', shell: process.platform === 'win32', env: env });
  if (r.status !== 0) {
    console.error('失敗しました: ' + cmd + ' ' + args.join(' '));
    process.exit(r.status || 1);
  }
}

// fs.cpSync は Windows で権限の書き換え（chmod）に失敗することがあるため、自前でコピーする
function copyTree(from, to) {
  if (fs.statSync(from).isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    fs.readdirSync(from).forEach(function (n) { copyTree(path.join(from, n), path.join(to, n)); });
  } else {
    fs.copyFileSync(from, to);
  }
}

function copy(rel) {
  var to = path.join(WORK, rel);
  fs.rmSync(to, { recursive: true, force: true });
  copyTree(path.join(ROOT, rel), to);
}

function need(name) {
  if (!process.env[name]) {
    console.error('環境変数 ' + name + ' が設定されていません');
    process.exit(2);
  }
  return process.env[name];
}

// gradle が PATH に無いとき（Android Studio だけ入っている Windows など）、Gradle のキャッシュから探す
function gradleEnv() {
  var env = Object.assign({}, process.env);
  var probe = spawnSync('gradle', ['--version'], { shell: process.platform === 'win32', stdio: 'ignore' });
  if (probe.status === 0) return env;
  var dists = path.join(os.homedir(), '.gradle', 'wrapper', 'dists');
  var found = [];
  if (fs.existsSync(dists)) {
    fs.readdirSync(dists).forEach(function (d) {
      var m = /^gradle-(\d+)\.(\d+)/.exec(d);
      if (!m) return;
      fs.readdirSync(path.join(dists, d)).forEach(function (h) {
        var home = path.join(dists, d, h);
        fs.readdirSync(home).forEach(function (g) {
          var bin = path.join(home, g, 'bin');
          if (/^gradle-/.test(g) && fs.existsSync(bin)) found.push({ major: +m[1], minor: +m[2], bin: bin });
        });
      });
    });
  }
  // 8.x を優先（cordova-android 15 は Gradle 8.14 を使う）
  found.sort(function (a, b) { return ((b.major === 8) - (a.major === 8)) || (b.major - a.major) || (b.minor - a.minor); });
  if (found.length) {
    console.log('gradle: ' + found[0].bin);
    env.PATH = found[0].bin + path.delimiter + env.PATH;
  }
  return env;
}

// 1. 作業フォルダを用意する
fs.mkdirSync(WORK, { recursive: true });
['config.xml', 'www', 'res'].forEach(copy);
['platforms', 'plugins'].forEach(function (d) { fs.rmSync(path.join(WORK, d), { recursive: true, force: true }); });
// platforms/ が無いと、Cordova は親フォルダ（このプロジェクト本体）をプロジェクトとみなして本体の package.json を書き換える
fs.mkdirSync(path.join(WORK, 'platforms'));

// ビルド番号（App Store はアップロードごとに CFBundleVersion を上げる必要がある）。コピーした config.xml にだけ書く
if (process.env.IOS_BUILD_NUMBER) {
  var xmlPath = path.join(WORK, 'config.xml');
  var xml = fs.readFileSync(xmlPath, 'utf8');
  if (!/ios-CFBundleVersion=/.test(xml)) {
    fs.writeFileSync(xmlPath, xml.replace('<widget ', '<widget ios-CFBundleVersion="' + process.env.IOS_BUILD_NUMBER + '" '));
  }
}

var pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
MONACA_ONLY_PLUGINS.forEach(function (id) {
  delete pkg.dependencies[id];
  delete pkg.cordova.plugins[id];
});
fs.writeFileSync(path.join(WORK, 'package.json'), JSON.stringify({
  name: 'nemuri-no-oto-native-build',
  private: true,
  dependencies: pkg.dependencies,
  devDependencies: { cordova: pkg.devDependencies.cordova },
  cordova: { plugins: pkg.cordova.plugins }
}, null, 2));
fs.rmSync(path.join(WORK, 'package-lock.json'), { force: true });

// 2. 署名の設定（環境変数から作る。Monaca 用の build.json は使わない）
var buildConfig = {};
if (release && platform === 'android') {
  buildConfig.android = { release: {
    keystore: path.resolve(ROOT, need('ANDROID_KEYSTORE')),
    storePassword: need('ANDROID_KEYSTORE_PASSWORD'),
    alias: need('ANDROID_KEY_ALIAS'),
    password: need('ANDROID_KEY_PASSWORD'),
    packageType: 'bundle'
  } };
}
if (release && platform === 'ios') {
  buildConfig.ios = { release: {
    codeSignIdentity: 'Apple Distribution',
    developmentTeam: need('IOS_TEAM_ID'),
    provisioningProfile: need('IOS_PROFILE_UUID'),
    packageType: 'app-store-connect',
    automaticProvisioning: false
  } };
}
var configPath = path.join(WORK, 'build-config.json');
fs.writeFileSync(configPath, JSON.stringify(buildConfig, null, 2));

// 3. ビルド
var env = platform === 'android' ? gradleEnv() : process.env;
run('npm', ['install', '--no-audit', '--no-fund']);
run('npx', ['cordova', 'platform', 'add', platform + '@' + PLATFORM_VERSIONS[platform]]);
var args = ['cordova', 'build', platform, release ? '--release' : '--debug', '--buildConfig=build-config.json'];
if (platform === 'ios') args.push(release ? '--device' : '--emulator');
run('npx', args, env);
fs.rmSync(configPath, { force: true });

// 4. できたファイルを dist/ に集める
var outDir = platform === 'android'
  ? path.join(WORK, 'platforms', 'android', 'app', 'build', 'outputs')
  : path.join(WORK, 'platforms', 'ios', 'build');
var want = platform === 'android' ? /\.(apk|aab)$/ : (release ? /\.ipa$/ : /\.app$/);
var outputs = [];
(function walk(dir) {
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    var p = path.join(dir, e.name);
    if (want.test(e.name)) outputs.push(p);
    else if (e.isDirectory()) walk(p);
  });
})(outDir);

fs.mkdirSync(DIST, { recursive: true });
var version = (/<widget[^>]*\sversion="([^"]+)"/.exec(fs.readFileSync(path.join(ROOT, 'config.xml'), 'utf8')) || [])[1] || '0';
outputs.forEach(function (p) {
  var name = 'nemurinooto-' + version + '-' + (release ? 'release' : 'debug') + path.extname(p);
  if (platform === 'ios' && !release) name = 'nemurinooto-' + version + '-simulator.app';
  var to = path.join(DIST, name);
  fs.rmSync(to, { recursive: true, force: true });
  copyTree(p, to);
  console.log('出力: ' + path.relative(ROOT, to));
});
if (!outputs.length) {
  console.error('ビルドは終わりましたが、出力ファイルが見つかりません: ' + outDir);
  process.exit(1);
}
