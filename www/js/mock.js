/*
 * ブラウザ確認用のモック（v0.6.0）。記録のデータは sample.js で作る。
 * Cordova が無い環境（PCのブラウザ等）でのみ使われ、実機では使われない。
 */
(function () {
  'use strict';

  var makeSession = window.SleepSample.makeSession; // sample.js

  var AUDIO_SESSIONS = 3;   // 一晩分の音声を残す件数（SessionStore と同じ）

  // 解析済みの記録として一覧に出す数（実機ではアプリが saveAnalysis で保存する）
  function analysisOf(s) {
    var bin = atob(s.graph), v = new Int16Array(bin.length / 2);
    for (var i = 0; i < v.length; i++) { var x = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8); v[i] = x >= 0x8000 ? x - 0x10000 : x; }
    var A = window.SleepAnalysis, counts = {};
    Object.keys(A.OFFSET).forEach(function (k) { counts[k] = A.analyze(v, A.OFFSET[k]).segments.length; });
    return { algo: 3, sensitivity: 'mid', offsetDb: A.OFFSET.mid, counts: counts, eventCount: counts.mid };
  }

  function applyRetention() {
    Object.keys(store).map(function (k) { return store[k]; })
      .sort(function (a, b) { return b.meta.startedAt - a.meta.startedAt; })
      .forEach(function (s, i) { if (i >= AUDIO_SESSIONS) { s.meta.hasAudio = false; s.meta.audio = 'none'; s.cuts = {}; } });
  }

  var store = null;
  function ensure() {
    if (store) return;
    store = {};
    var night = new Date(); night.setHours(23, 30, 0, 0);
    for (var d = 1; d <= 4; d++) {
      var st = night.getTime() - d * 86400000 - d * 7 * 60000;
      var s = makeSession(st, 6.5 + d * 0.3, 1234 + d * 77);
      // 最新の記録は未解析（アプリが開いたときに解析する）、それ以外は解析済み
      if (d > 1) { s.meta.analysis = analysisOf(s); s.meta.eventCount = s.meta.analysis.eventCount; }
      s.cuts = {};
      store[String(st)] = s;
    }
    applyRetention();
  }

  var rec = null;
  var play = null;
  function pos() {
    if (!play) return 0;
    var p = play.playing ? play.base + (Date.now() - play.at) / 1000 * play.rate : play.base;
    return Math.min(play.duration, p);
  }
  function playState() {
    if (!play) return { loaded: false, playing: false, position: 0, duration: 0, ended: false, rate: 1 };
    var p = pos(), ended = p >= play.duration;
    if (ended) { play.base = play.duration; play.playing = false; } // 実機と同じく終わりの位置で止まる
    return { loaded: true, playing: play.playing, position: p, duration: play.duration, ended: ended, rate: play.rate };
  }

  var Mock = {
    start: function (opts, onEvent, onError) {
      if (rec) { onError('すでに記録中です'); return; }
      rec = { startedAt: Date.now(), endAt: opts.endAt, cb: onEvent };
      rec.timer = setInterval(function () {
        onEvent({ type: 'status', sessionId: String(rec.startedAt), startedAt: rec.startedAt,
          elapsedSec: Math.floor((Date.now() - rec.startedAt) / 1000),
          levelDb: -70 + Math.random() * (Math.random() < 0.1 ? 25 : 4), endAt: rec.endAt });
      }, 1000);
    },
    attach: function () {},
    stop: function () {
      ensure();
      if (!rec) return Promise.resolve();
      clearInterval(rec.timer);
      var cb = rec.cb, id = String(rec.startedAt);
      store[id] = makeSession(rec.startedAt - 7 * 3600000, 7, Date.now() % 100000 + 1);
      store[id].meta.id = id;
      store[id].meta.startedAt = rec.startedAt - 7 * 3600000;
      store[id].cuts = {};
      applyRetention();
      rec = null;
      setTimeout(function () { cb({ type: 'stopped', sessionId: id, reason: 'manual', saved: true }); }, 300);
      return Promise.resolve();
    },
    getState: function () { return Promise.resolve({ recording: !!rec, sessionId: rec ? String(rec.startedAt) : null, startedAt: rec ? rec.startedAt : 0, endAt: rec ? rec.endAt : 0 }); },
    recover: function () { return Promise.resolve(); },
    listSessions: function () {
      ensure();
      return Promise.resolve(Object.keys(store).map(function (k) { return store[k].meta; })
        .sort(function (a, b) { return b.startedAt - a.startedAt; }));
    },
    getSession: function (id) { ensure(); return store[id] ? Promise.resolve(store[id]) : Promise.reject('セッションを読み込めませんでした'); },
    trimAudio: function (id, ranges, info) {
      var s = store[id];
      s.segments = { info: info, segments: ranges.map(function (r, i) { return { start: r.start, end: r.end, clip: 'seg_' + (i + 1) + '.aac' }; }) };
      s.meta.audio = 'segments';
      s.meta.eventCount = ranges.length;
      return new Promise(function (res) { setTimeout(function () { res(s.segments); }, 400); });
    },
    cutClip: function (id, start, end, name) {
      var s = store[id];
      if (!s || s.meta.audio !== 'full') return Promise.reject('この記録の音声は残っていません');
      var c = { start: start, end: Math.min(end, s.meta.durationSec), clip: name };
      s.cuts[name] = c;
      return new Promise(function (res) { setTimeout(function () { res(c); }, 150); });
    },
    saveAnalysis: function (id, info) {
      var s = store[id];
      s.meta.analysis = info;
      if (info.eventCount != null) s.meta.eventCount = info.eventCount;
      return Promise.resolve();
    },
    deleteAll: function () { store = {}; return Promise.resolve(); },
    playClip: function (sid, clip, opts) {
      var s = store[sid];
      var c = s && ((s.cuts && s.cuts[clip]) || (s.segments && s.segments.segments.filter(function (x) { return x.clip === clip; })[0]));
      if (!c) return Promise.reject('この音声は保存されていません');
      play = { duration: c.end - c.start, base: 0, at: Date.now(), playing: true, rate: (opts && opts.rate) || 1 };
      return Promise.resolve(playState());
    },
    pauseClip: function () { if (play) { play.base = pos(); play.playing = false; } return Promise.resolve(playState()); },
    resumeClip: function () { if (play) { if (pos() >= play.duration) play.base = 0; play.at = Date.now(); play.playing = true; } return Promise.resolve(playState()); },
    seekClip: function (sec) { if (play) { play.base = Math.min(play.duration, Math.max(0, sec)); play.at = Date.now(); } return Promise.resolve(playState()); },
    setClipRate: function (r) { if (play) { play.base = pos(); play.at = Date.now(); play.rate = r; } return Promise.resolve(playState()); },
    getClipState: function () { return Promise.resolve(playState()); },
    stopClip: function () { play = null; return Promise.resolve(); },
    saveClip: function (sid, clip, name) { return Promise.resolve({ method: 'saved', path: 'ダウンロード/' + name }); },
    checkPermissions: function () { return Promise.resolve({ mic: 'granted', notification: 'notRequired' }); },
    requestPermissions: function () { return Promise.resolve({ mic: 'granted', notification: 'notRequired' }); },
    getDeviceStatus: function () { return Promise.resolve({ charging: false, freeMB: 5000, platform: 'browser' }); },
    openAppSettings: function () { return Promise.resolve(); },
    openBatterySettings: function () { return Promise.resolve(); }
  };

  window.SleepRecorderMock = Mock;
})();
