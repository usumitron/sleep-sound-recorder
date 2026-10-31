/*
 * アイコン・起動画面の画像を作る。
 *   1. SVG（app-icon*.svg）を 1024px の PNG にする（この JS。playwright が必要）
 *   2. 各サイズに縮小して res/ に書き出す（make-icons.py。Python の Pillow が必要）
 *
 * 使い方（playwright はプロジェクトの package.json に入れず、別のフォルダに入れて使う）:
 *   NODE_PATH=<playwright を入れたフォルダ>/node_modules node tools/make-icons.js [chrome.exe のパス]
 *   python tools/make-icons.py
 */
'use strict';
var path = require('path');
var fs = require('fs');
var chromium = require('playwright').chromium;

var DIR = __dirname;
var JOBS = [
  { svg: 'app-icon.svg', png: 'app-icon-1024.png', transparent: false },
  { svg: 'app-icon-foreground.svg', png: 'app-icon-foreground-1024.png', transparent: true },
  { svg: 'app-icon-background.svg', png: 'app-icon-background-1024.png', transparent: false }
];

(async function () {
  var browser = await chromium.launch(process.argv[2] ? { executablePath: process.argv[2] } : {});
  var page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  for (var i = 0; i < JOBS.length; i++) {
    var j = JOBS[i];
    var svg = fs.readFileSync(path.join(DIR, j.svg), 'utf8');
    await page.setContent('<html><body style="margin:0;background:transparent">' + svg + '</body></html>');
    await page.screenshot({ path: path.join(DIR, j.png), omitBackground: j.transparent, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
    console.log('saved', j.png);
  }
  await browser.close();
})().catch(function (e) { console.error(e); process.exit(1); });
