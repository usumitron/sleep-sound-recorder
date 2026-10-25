/*
 * サンプルの記録（v0.5.2）。
 * 記録が10分未満だと保存されないため、ストアの審査や初めての利用者がすぐに記録の画面を確認できるよう、
 * 合成した一晩分の1秒値を作る。ブラウザ確認用のモック（mock.js）もこれを使う。音声は含まない。
 */
(function (root) {
  'use strict';

  /** 1秒値（0.1dB 単位の int16）を作る。seed が同じなら同じ値になる */
  function makeValues(hours, seed) {
    var rnd = function () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    var n = Math.round(hours * 3600);
    var vals = new Int16Array(n);
    for (var s = 0; s < n; s++) vals[s] = Math.round((-71.5 + rnd() * 2) * 10);
    // 持続音（いびき等）をいくつか
    var t = 1200;
    while (t < n - 1200) {
      var len = 300 + Math.floor(rnd() * 2400), lo = -69 + rnd() * 4, hi = lo + 8 + rnd() * 4;
      for (var k = t; k < Math.min(n, t + len); k++) vals[k] = Math.round((lo + rnd() * (hi - lo)) * 10);
      t += len + 1800 + Math.floor(rnd() * 3600);
    }
    // 単発の物音
    for (var j = 100; j < n; j += 120 + Math.floor(rnd() * 200)) vals[j] = Math.round((-50 - rnd() * 10) * 10);
    return vals;
  }

  function encode(vals) {
    var bytes = new Uint8Array(vals.buffer), bin = '';
    for (var b = 0; b < bytes.length; b += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(b, b + 0x8000));
    return btoa(bin);
  }

  /** getSession() と同じ形のセッション。audio は 'full'（モックで切り出しを試す用） */
  function makeSession(startedAt, hours, seed) {
    var vals = makeValues(hours, seed), n = vals.length;
    var maxDb = -100;
    for (var m = 0; m < n; m++) if (vals[m] / 10 > maxDb) maxDb = vals[m] / 10;
    return {
      meta: { id: String(startedAt), startedAt: startedAt, endedAt: startedAt + n * 1000, lastWriteAt: startedAt + n * 1000,
        durationSec: n, endReason: 'auto', sensitivity: 'mid', plannedEndAt: startedAt + n * 1000,
        eventCount: 0, maxDb: maxDb, hasAudio: true, audio: 'full', algo: 3 },
      graph: encode(vals),
      segments: null
    };
  }

  /** アプリ内で表示するサンプル。昨夜 23:10〜翌 6:40 の記録で、音声は無い */
  function demo() {
    var st = new Date();
    st.setDate(st.getDate() - 1);
    st.setHours(23, 10, 0, 0);
    var s = makeSession(st.getTime(), 7.5, 2468);
    s.meta.id = 'sample';
    s.meta.sample = true;
    s.meta.hasAudio = false;
    s.meta.audio = 'none';
    return s;
  }

  root.SleepSample = { makeValues: makeValues, makeSession: makeSession, demo: demo };
})(typeof window !== 'undefined' ? window : globalThis);
