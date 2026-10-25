/*
 * App Store 用スクリーンショット（6.9インチ: 1320×2868）を作る。
 * ブラウザ確認用のモック（www/js/mock.js）の画面を撮る。
 *
 * 使い方（playwright はプロジェクトの package.json に入れず、別のフォルダに入れて使う）:
 *   NODE_PATH=<playwright を入れたフォルダ>/node_modules node tools/store-screenshots.js [chrome.exe のパス]
 * 出力: store/screenshots/*.png
 */
'use strict';
var path = require('path');
var fs = require('fs');
var chromium = require('playwright').chromium;

var ROOT = path.join(__dirname, '..');
var OUT = path.join(ROOT, 'store', 'screenshots');
var URL = 'file:///' + path.join(ROOT, 'www', 'index.html').replace(/\\/g, '/');
var SETTINGS = { consented: true, consentedAt: 1, interruptTipShown: true, sensitivity: 'mid', defaultEnd: '06:30', lastEnd: '06:30' };

function at(h, m, s, dayOffset) {
  var d = new Date();
  d.setDate(d.getDate() + (dayOffset || 0));
  d.setHours(h, m, s || 0, 0);
  return d;
}

(async function () {
  fs.mkdirSync(OUT, { recursive: true });
  var browser = await chromium.launch(process.argv[2] ? { executablePath: process.argv[2] } : {});
  // iPhone 6.9インチ（440×956pt、3倍）
  var ctx = await browser.newContext({ viewport: { width: 440, height: 956 }, deviceScaleFactor: 3, colorScheme: 'dark', locale: 'ja-JP' });
  var page = await ctx.newPage();
  page.on('pageerror', function (e) { console.error('pageerror:', e.message); });
  await page.addInitScript(function (s) { localStorage.setItem('nemuri.settings', JSON.stringify(s)); }, SETTINGS);
  async function shot(name) {
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, name + '.png') });
    console.log('saved', name);
  }

  // 1. ホーム（夜）
  await page.clock.setFixedTime(at(23, 5));
  await page.goto(URL);
  await page.waitForSelector('#session-list li');
  await shot('1-home');

  // 2. 記録中
  await page.evaluate(function () { window.SleepRecorderMock.getDeviceStatus = function () { return Promise.resolve({ charging: true, freeMB: 5000, platform: 'browser' }); }; });
  await page.clock.setFixedTime(at(23, 10));
  await page.click('#start-btn');
  await page.waitForSelector('#screen-recording:not([hidden])');
  await page.clock.setFixedTime(at(1, 24, 37, 1));
  await page.waitForTimeout(1200);
  await shot('2-recording');

  // 3. 記録の詳細（最新の記録。音声つき）。日付がホームと合うよう同じ日時で開く
  await page.clock.setFixedTime(at(23, 5));
  await page.goto(URL);
  await page.waitForSelector('#session-list li');
  await page.click('#session-list li:first-child button');
  await page.waitForSelector('.event-row .play');
  await page.click('.event-row:nth-child(2) .event-main');
  await shot('3-detail');

  // 4. 1時間表示で再生
  await page.click('[data-window="3600"]');
  await page.click('.event-row:nth-child(2) .play');
  await page.waitForSelector('#player:not([hidden])');
  await page.clock.setFixedTime(at(23, 9, 12));
  await page.waitForTimeout(800);
  await page.click('#player-toggle');
  await shot('4-player');

  // 5. 設定（このアプリについて）
  await page.click('[data-back]');
  await page.click('.tabs [data-go="settings"]');
  await shot('5-settings');

  await browser.close();
})().catch(function (e) { console.error(e); process.exit(1); });
