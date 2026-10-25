/*
 * 記録後解析のテスト（v0.4.0）
 *   node tools/analysis-test.js
 * 10/17 の実機グラフに近い一晩を合成して、時間帯の抽出を確認する。
 */
'use strict';
const assert = require('assert');
const { analyze, clipRanges, OFFSET } = require('../www/js/analysis.js');

let seed = 3;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const quiet = (s) => Array.from({ length: s }, () => -71.5 + rnd() * 2);              // 静か（下限 -71dB 前後）
const band = (s, lo, hi) => Array.from({ length: s }, () => lo + rnd() * (hi - lo));  // ばらつく持続音
function spikes(s) {                                                                    // ときどき単発の物音
  const a = quiet(s);
  for (let i = 30; i < s; i += 90 + Math.floor(rnd() * 60)) a[i] = -48 - rnd() * 8;
  return a;
}
const toVals = (arr) => Int16Array.from(arr.map((d) => Math.round(d * 10)));

// 23:44〜 の一晩（秒）
const night = [
  ...quiet(20 * 60),
  ...band(9 * 60, -66, -58),     // 0:04〜 画像2のような音（平均 -62dB）
  ...spikes(70 * 60),            // 物音が散発
  ...band(16 * 60, -70, -60),    // 1:43〜 画像3のような音（平均 -65dB）
  ...quiet(30 * 60),
  ...band(11, -36, -34),         // 2:18 単発の大きな音 11秒
  ...spikes(60 * 60),
  ...band(40 * 60, -69, -59),    // 3:40〜 画像4のような音（平均 -64dB）
  ...quiet(30 * 60),
  ...band(15 * 60, -62, -54),    // 4:55〜 画像5のような音（平均 -58dB）
  ...spikes(100 * 60),
];
const v = toVals(night);

const mid = analyze(v, OFFSET.mid).segments;
const long = mid.filter((s) => s.dur >= 5 * 60);
// 4か所の持続音（開始・終了の分）が、それぞれ8割以上カバーされていること
const truth = [[20, 29], [99, 115], [205, 245], [275, 290]];
truth.forEach(([a, b]) => {
  const cov = mid.reduce((acc, s) => acc + Math.max(0, Math.min(s.end, b * 60) - Math.max(s.start, a * 60)), 0);
  assert.ok(cov >= (b - a) * 60 * 0.8, `${a}〜${b}分のカバー率 ${Math.round(cov / ((b - a) * 60) * 100)}%`);
});
console.log('中:', mid.map((s) => `${Math.round(s.start / 60)}分〜${Math.round(s.end / 60)}分(${s.dur}s, +${s.aboveDb}dB)`).join(' / '));
assert.strictEqual(long.length, 4, '続いた音4か所をすべて検出');
// 散発する物音の区間（それぞれ1時間以上）が、長い時間帯として拾われていない
const spikyLong = mid.filter((s) => s.dur > 60 * 60);
assert.strictEqual(spikyLong.length, 0, '物音だけの区間は拾わない');

const low = analyze(v, OFFSET.low).segments.filter((s) => s.dur >= 5 * 60);
const high = analyze(v, OFFSET.high).segments;
console.log('低: 長い時間帯', low.length, '件 / 高: 全', high.length, '件');
assert.ok(low.length <= long.length);

// 静かなだけの夜は何も拾わない
assert.strictEqual(analyze(toVals(quiet(3 * 3600)), OFFSET.mid).segments.length, 0);

// 音声の範囲は前後5秒の余白つき、範囲内
const ranges = clipRanges(mid, v.length);
assert.ok(ranges.every((r) => r.start >= 0 && r.end <= v.length && r.end > r.start));
const total = ranges.reduce((a, r) => a + r.end - r.start, 0);
console.log('残す音声: ' + Math.round(total / 60) + '分（約' + Math.round(total * 3 / 1024) + 'MB） / 一晩 ' + Math.round(v.length / 60) + '分');

console.log('All analysis tests passed.');
