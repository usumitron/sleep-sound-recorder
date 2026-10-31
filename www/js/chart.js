/*
 * 音量グラフ（横軸＝時刻、縦軸＝音量）
 * - 1秒刻みのデータを、画面の1ピクセルごとに最大値・最小値へ間引いて描く（ピークは消えない）
 * - 検知した音の区間を琥珀色で重ねる
 * - 破線は検知のしきい値（周囲の音の中央値＋感度）
 * - 区間以外をタップすると、その時刻にカーソル（再生を始める位置）を置く（onPick）
 */
(function () {
  'use strict';

  var COLORS = {
    grid: 'rgba(152,161,192,0.16)',
    axis: '#98A1C0',
    line: '#8FB3E8',
    fill: 'rgba(143,179,232,0.22)',
    event: 'rgba(242,182,86,0.20)',
    eventOn: 'rgba(242,182,86,0.42)',
    eventMark: '#F2B656',
    thr: 'rgba(236,231,220,0.8)',
    level: 'rgba(242,182,86,0.85)',
    playhead: '#ECE7DC',
    cursor: '#8FB3E8'
  };
  var M = { left: 44, right: 12, top: 14, bottom: 26 };
  var TICK_STEPS = [10, 30, 60, 300, 900, 1800, 3600, 7200]; // 秒

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function SleepChart(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSelect = (opts && opts.onSelect) || function () {};
    this.onPick = (opts && opts.onPick) || null;   // 区間以外をタップしたとき（秒）。null ならカーソルを置かない
    this.cursor = null;
    this.values = new Int16Array(0);
    this.events = [];
    this.thr = null;
    this.windowSec = 0;
    this.v0 = 0;
    this.selected = -1;
    this.playhead = null;
    this._bindPointer();
    var self = this;
    window.addEventListener('resize', function () { self.draw(); });
  }

  SleepChart.prototype.setData = function (d) {
    this.values = d.values;
    this.startedAt = d.startedAt;
    this.events = d.events || [];
    this.selected = -1;
    this.v0 = 0;
    this.playhead = null;
    this.cursor = null;
    this.level = d.level || null;      // 20秒平均の音量（判定に使う値）
    this.thr = d.thr || (d.offsetDb != null
      ? ((d.algo || 1) >= 2 ? computeThresholdV2(d.values, d.offsetDb) : computeThreshold(d.values, this.events, d.offsetDb))
      : null);
    this._yRange();
    this.draw();
  };

  SleepChart.prototype.setWindow = function (sec) {
    var n = this.values.length;
    var center = this.v0 + this._span() / 2;
    this.windowSec = sec >= n ? 0 : sec;
    this.v0 = center - this._span() / 2;
    this._clamp();
    this.draw();
  };

  SleepChart.prototype.select = function (i, center) {
    this.selected = i;
    var e = this.events[i];
    if (e && center && this.windowSec) {
      this.v0 = (e.start + e.end) / 2 - this._span() / 2;
      this._clamp();
    }
    this.draw();
  };

  /** 再生位置（セッション開始からの秒）。null で消す。拡大中は表示範囲を追従させる */
  SleepChart.prototype.setPlayhead = function (sec) {
    this.playhead = sec;
    if (sec != null && this.windowSec && !this._dragging) {
      var span = this._span();
      if (sec < this.v0 || sec > this.v0 + span * 0.85) {
        this.v0 = sec - span * 0.15;
        this._clamp();
      }
    }
    this.draw();
  };

  /** 再生を始める位置のカーソル（セッション開始からの秒）。null で消す */
  SleepChart.prototype.setCursor = function (sec) {
    this.cursor = sec;
    this.draw();
  };

  SleepChart.prototype._span = function () {
    return this.windowSec || Math.max(1, this.values.length);
  };

  SleepChart.prototype._clamp = function () {
    var max = Math.max(0, this.values.length - this._span());
    this.v0 = Math.min(max, Math.max(0, this.v0));
  };

  SleepChart.prototype._yRange = function () {
    var v = this.values;
    if (!v.length) { this.yLo = -80; this.yHi = -20; return; }
    var sorted = Array.prototype.slice.call(v).sort(function (a, b) { return a - b; });
    var lo = sorted[Math.floor(sorted.length * 0.02)] / 10 - 6;
    var hi = sorted[sorted.length - 1] / 10 + 4;
    lo = Math.max(-100, Math.floor(lo / 10) * 10);
    hi = Math.min(0, Math.ceil(hi / 10) * 10);
    if (hi - lo < 30) lo = hi - 30;
    this.yLo = lo;
    this.yHi = hi;
  };

  SleepChart.prototype.draw = function () {
    var c = this.canvas, ctx = this.ctx;
    var dpr = window.devicePixelRatio || 1;
    var w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    var pw = w - M.left - M.right, ph = h - M.top - M.bottom;
    var v0 = this.v0, span = this._span();
    var yLo = this.yLo, yHi = this.yHi;
    var X = function (s) { return M.left + (s - v0) / span * pw; };
    var Y = function (db) { return M.top + (1 - (db - yLo) / (yHi - yLo)) * ph; };
    this._geom = { X: X, pw: pw, span: span };

    ctx.font = '11px "Hiragino Sans","Noto Sans JP",sans-serif';
    ctx.textBaseline = 'middle';

    // 縦軸の目盛り
    ctx.fillStyle = COLORS.axis;
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    var yStep = (yHi - yLo) > 50 ? 20 : 10;
    for (var db = Math.ceil(yLo / yStep) * yStep; db <= yHi; db += yStep) {
      var y = Math.round(Y(db)) + 0.5;
      ctx.beginPath(); ctx.moveTo(M.left, y); ctx.lineTo(w - M.right, y); ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(db + 'dB', M.left - 6, y);
    }

    // 横軸の目盛り（実際の時刻）
    var step = TICK_STEPS[TICK_STEPS.length - 1];
    for (var k = 0; k < TICK_STEPS.length; k++) {
      if (span / TICK_STEPS[k] <= 5) { step = TICK_STEPS[k]; break; }
    }
    var startSec = this.startedAt / 1000;
    var tz = new Date(this.startedAt).getTimezoneOffset() * 60;
    var first = Math.ceil((startSec + v0 - tz) / step) * step + tz - startSec;
    ctx.textAlign = 'center';
    for (var s = first; s <= v0 + span; s += step) {
      var x = Math.round(X(s)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, M.top); ctx.lineTo(x, M.top + ph); ctx.stroke();
      var d = new Date((startSec + s) * 1000);
      var label = d.getHours() + ':' + pad2(d.getMinutes()) + (step < 60 ? ':' + pad2(d.getSeconds()) : '');
      ctx.fillText(label, x, h - M.bottom / 2);
    }

    ctx.save();
    ctx.beginPath(); ctx.rect(M.left, 0, pw, h); ctx.clip();

    // 検知した音の区間
    for (var i = 0; i < this.events.length; i++) {
      var e = this.events[i];
      if (e.end < v0 || e.start > v0 + span) continue;
      var x0 = X(e.start), x1 = Math.max(X(e.end), x0 + 2);
      ctx.fillStyle = i === this.selected ? COLORS.eventOn : COLORS.event;
      ctx.fillRect(x0, M.top, x1 - x0, ph);
      ctx.fillStyle = COLORS.eventMark;
      ctx.fillRect(x0, M.top - 6, x1 - x0, 3);
    }

    // 音量（ピクセルごとの最大・最小）
    var v = this.values;
    if (v.length) {
      var cols = Math.max(1, Math.floor(pw));
      var perCol = span / cols;
      var top = [], bot = [];
      if (perCol >= 1) {
        for (var col = 0; col < cols; col++) {
          var a = Math.floor(v0 + col * perCol), b = Math.min(v.length, Math.floor(v0 + (col + 1) * perCol));
          if (a >= v.length) break;
          var mx = -1e9, mn = 1e9;
          for (var j = a; j < Math.max(b, a + 1); j++) { if (v[j] > mx) mx = v[j]; if (v[j] < mn) mn = v[j]; }
          var cx = M.left + col + 0.5;
          top.push([cx, Y(mx / 10)]); bot.push([cx, Y(mn / 10)]);
        }
      } else {
        // 拡大時は1秒ごとの階段状
        var s0 = Math.floor(v0), s1 = Math.min(v.length, Math.ceil(v0 + span));
        for (var t = s0; t < s1; t++) {
          var yy = Y(v[t] / 10);
          top.push([X(t), yy]); top.push([X(t + 1), yy]);
          bot.push([X(t), Y(yLo)]); bot.push([X(t + 1), Y(yLo)]);
        }
      }
      if (top.length) {
        ctx.beginPath();
        ctx.moveTo(top[0][0], top[0][1]);
        for (var p = 1; p < top.length; p++) ctx.lineTo(top[p][0], top[p][1]);
        for (var q = bot.length - 1; q >= 0; q--) ctx.lineTo(bot[q][0], bot[q][1]);
        ctx.closePath();
        ctx.fillStyle = COLORS.fill;
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(top[0][0], top[0][1]);
        for (var r = 1; r < top.length; r++) ctx.lineTo(top[r][0], top[r][1]);
        ctx.strokeStyle = COLORS.line;
        ctx.lineWidth = 1.25;
        ctx.stroke();
      }
    }

    // しきい値
    if (this.thr) {
      ctx.beginPath();
      var started = false;
      var stepT = Math.max(1, Math.floor(span / pw));
      for (var u = Math.floor(v0); u < Math.min(this.thr.length, v0 + span + 1); u += stepT) {
        var tv = this.thr[u];
        if (isNaN(tv)) { started = false; continue; }
        if (!started) { ctx.moveTo(X(u), Y(tv)); started = true; } else ctx.lineTo(X(u), Y(tv));
      }
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = COLORS.thr;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 20秒平均の音量（これがしきい値を超えて続くと「続いた音」になる）
    if (this.level) {
      ctx.beginPath();
      var stepL = Math.max(1, Math.floor(span / pw));
      var firstL = true;
      for (var w = Math.max(0, Math.floor(v0)); w < Math.min(this.level.length, v0 + span + 1); w += stepL) {
        if (firstL) { ctx.moveTo(X(w), Y(this.level[w])); firstL = false; } else ctx.lineTo(X(w), Y(this.level[w]));
      }
      ctx.strokeStyle = COLORS.level;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // 再生を始める位置（点線）
    if (this.cursor != null && this.cursor >= v0 && this.cursor <= v0 + span) {
      var cxp = Math.round(X(this.cursor)) + 0.5;
      ctx.strokeStyle = COLORS.cursor;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(cxp, M.top); ctx.lineTo(cxp, M.top + ph); ctx.stroke();
      ctx.setLineDash([]);
    }

    // 再生位置
    if (this.playhead != null && this.playhead >= v0 && this.playhead <= v0 + span) {
      var px = Math.round(X(this.playhead)) + 0.5;
      ctx.strokeStyle = COLORS.playhead;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px, M.top - 6); ctx.lineTo(px, M.top + ph); ctx.stroke();
      ctx.fillStyle = COLORS.playhead;
      ctx.beginPath(); ctx.arc(px, M.top - 6, 3.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  };

  SleepChart.prototype._bindPointer = function () {
    var self = this, c = this.canvas;
    var downX = null, startV0 = 0, moved = false;
    c.addEventListener('pointerdown', function (ev) {
      downX = ev.clientX; startV0 = self.v0; moved = false; self._dragging = true;
      c.setPointerCapture(ev.pointerId);
    });
    c.addEventListener('pointermove', function (ev) {
      if (downX === null || !self._geom) return;
      var dx = ev.clientX - downX;
      if (Math.abs(dx) > 6) moved = true;
      if (moved && self.windowSec) {
        self.v0 = startV0 - dx * (self._geom.span / self._geom.pw);
        self._clamp();
        self.draw();
      }
    });
    c.addEventListener('pointerup', function (ev) {
      if (downX === null) return;
      if (!moved && self._geom) {
        var rect = c.getBoundingClientRect();
        var x = ev.clientX - rect.left;
        var sec = self.v0 + (x - M.left) / self._geom.pw * self._geom.span;
        var tol = 8 / self._geom.pw * self._geom.span; // 8px の余裕
        var hit = -1;
        for (var i = 0; i < self.events.length; i++) {
          var e = self.events[i];
          if (sec >= e.start - tol && sec <= e.end + tol) { hit = i; break; }
        }
        if (hit >= 0) { self.select(hit, false); self.onSelect(hit); }
        else if (self.onPick && sec >= 0 && sec < self.values.length) {
          self.cursor = Math.floor(sec);
          self.draw();
          self.onPick(self.cursor);
        }
      }
      downX = null;
      self._dragging = false;
    });
    c.addEventListener('pointercancel', function () { downX = null; self._dragging = false; });
  };

  /*
   * しきい値の再計算（ネイティブの検知と同じ考え方）。
   * 直近300秒のうちイベント外の1秒値の中央値＋感度。開始1分間は表示しない。
   * 計算量を抑えるため10秒ごとに求め、その間は同じ値とする。
   */
  function computeThreshold(values, events, offsetDb) {
    var n = values.length;
    if (!n || offsetDb == null) return null;
    var inEvent = new Uint8Array(n);
    events.forEach(function (e) {
      for (var s = Math.max(0, Math.floor(e.start)); s < Math.min(n, Math.ceil(e.end)); s++) inEvent[s] = 1;
    });
    var thr = new Float32Array(n);
    var current = NaN;
    for (var t = 0; t < n; t++) {
      if (t % 10 === 0) {
        var buf = [];
        for (var k = t - 1; k >= 0 && buf.length < 300; k--) if (!inEvent[k]) buf.push(values[k]);
        if (buf.length) {
          buf.sort(function (a, b) { return a - b; });
          current = buf[Math.floor(buf.length / 2)] / 10 + offsetDb;
        }
      }
      thr[t] = t < 60 ? NaN : current;
    }
    return thr;
  }

  /*
   * しきい値の再計算 v0.3.0（ネイティブの検知と同じ）。
   * 直近300秒の1秒値の下位10%＋感度。開始1分間は表示しない。10秒ごとに求める。
   */
  function computeThresholdV2(values, offsetDb) {
    var n = values.length;
    if (!n || offsetDb == null) return null;
    var thr = new Float32Array(n);
    var current = NaN;
    for (var t = 0; t < n; t++) {
      if (t % 10 === 0 && t > 0) {
        var buf = Array.prototype.slice.call(values, Math.max(0, t - 300), t).sort(function (a, b) { return a - b; });
        current = buf[Math.min(buf.length - 1, Math.floor(buf.length * 0.1))] / 10 + offsetDb;
      }
      thr[t] = t < 60 ? NaN : current;
    }
    return thr;
  }

  window.SleepChart = SleepChart;
})();
