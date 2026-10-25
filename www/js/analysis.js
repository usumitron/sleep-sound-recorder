/*
 * 記録後の解析（v0.4.0）
 * 一晩の1秒値（グラフのデータ）から「大きめの音が続いた時間帯」を求める。
 * 記録中はすべて録音しておき、この結果の時間帯だけ音声を残す。
 *
 * 考え方
 * - 基準値: その時刻の前後60分の1秒値のうち、下位5%（いちばん静かなときの音）
 * - 音量: 1秒値を前後10秒（計20秒）で平均したもの。単発の物音は平均で薄まり、続く音だけが残る
 * - 「音量 > 基準値 + 感度」の状態を判定し、30秒以内の途切れはつなぎ、30秒未満の時間帯は捨てる
 *
 * ブラウザでは window.SleepAnalysis、Node では module.exports で使える。
 */
(function (root) {
  'use strict';

  var P = {
    floorHalfWindow: 60 * 60,  // 基準値を求める範囲（前後60分。長く続く音で基準値が持ち上がらないよう広めに）
    floorStep: 60,             // 基準値は60秒ごとに求める
    floorPercentile: 0.05,
    smoothHalfWindow: 10,      // 平均する範囲（前後10秒）
    mergeGap: 30,              // 30秒以内の途切れはつなぐ
    minLength: 30,             // 30秒未満は捨てる
    clipPad: 5,                // 音声は前後5秒の余白をつけて残す
    calib: 60                  // 開始直後の60秒は判定しない
  };
  var OFFSET = { low: 8, mid: 5, high: 3 };

  function percentile(arr, p) {
    var s = Array.prototype.slice.call(arr).sort(function (a, b) { return a - b; });
    return s[Math.min(s.length - 1, Math.floor(s.length * p))];
  }

  /**
   * @param {Int16Array|number[]} values 1秒ごとの音量（0.1dB単位）
   * @param {number} offsetDb 感度
   * @returns {{segments: Array, floor: Float32Array, level: Float32Array, thr: Float32Array}}
   */
  function analyze(values, offsetDb) {
    var n = values.length;
    var db = new Float32Array(n);
    for (var i = 0; i < n; i++) db[i] = values[i] / 10;

    // 基準値（60秒ごとに求めて、その間は同じ値）
    var floor = new Float32Array(n);
    var cur = NaN;
    for (var t = 0; t < n; t++) {
      if (t % P.floorStep === 0) {
        var a = Math.max(0, t - P.floorHalfWindow), b = Math.min(n, t + P.floorHalfWindow);
        cur = percentile(db.subarray(a, b), P.floorPercentile);
      }
      floor[t] = cur;
    }

    // 平均した音量（累積和で計算）
    var cum = new Float64Array(n + 1);
    for (var k = 0; k < n; k++) cum[k + 1] = cum[k] + db[k];
    var level = new Float32Array(n);
    var thr = new Float32Array(n);
    for (var u = 0; u < n; u++) {
      var lo = Math.max(0, u - P.smoothHalfWindow), hi = Math.min(n, u + P.smoothHalfWindow + 1);
      level[u] = (cum[hi] - cum[lo]) / (hi - lo);
      thr[u] = u < P.calib ? NaN : floor[u] + offsetDb;
    }

    // 判定 → 時間帯
    var raw = [];
    var start = -1;
    for (var x = 0; x <= n; x++) {
      var on = x < n && x >= P.calib && level[x] > thr[x];
      if (on && start < 0) start = x;
      if (!on && start >= 0) { raw.push([start, x]); start = -1; }
    }
    var merged = [];
    raw.forEach(function (r) {
      var last = merged[merged.length - 1];
      if (last && r[0] - last[1] <= P.mergeGap) last[1] = r[1];
      else merged.push([r[0], r[1]]);
    });
    var segments = merged.filter(function (r) { return r[1] - r[0] >= P.minLength; }).map(function (r) {
      var peak = -Infinity, sum = 0, fsum = 0;
      for (var s = r[0]; s < r[1]; s++) {
        if (db[s] > peak) peak = db[s];
        sum += level[s];
        fsum += floor[s];
      }
      var len = r[1] - r[0];
      return { start: r[0], end: r[1], dur: len, peakDb: Math.round(peak * 10) / 10, aboveDb: Math.round((sum - fsum) / len * 10) / 10 };
    });
    return { segments: segments, floor: floor, level: level, thr: thr };
  }

  /** 音声を残す範囲（前後5秒の余白。重なったらつなぐ） */
  function clipRanges(segments, total) {
    var out = [];
    segments.forEach(function (s) {
      var a = Math.max(0, s.start - P.clipPad), b = Math.min(total, s.end + P.clipPad);
      var last = out[out.length - 1];
      if (last && a <= last.end) last.end = b;
      else out.push({ start: a, end: b });
    });
    return out;
  }

  var api = { analyze: analyze, clipRanges: clipRanges, OFFSET: OFFSET, PARAMS: P };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SleepAnalysis = api;
})(this);
