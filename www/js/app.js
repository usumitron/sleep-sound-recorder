/*
 * 眠りの音 — 画面と操作
 * 録音・検知・保存はネイティブプラグイン（SleepRecorder）が行う。ここでは指示と表示のみ。
 */
(function () {
  'use strict';

  var APP_VERSION = '0.6.0';
  var SENS_LABEL = { low: '低', mid: '中', high: '高' };
  // 感度ごとのしきい値（周囲の音＋何dBで検知するか）。新しい記録は meta.offsetDb に保存された値を使う
  var SENS_OFFSET = window.SleepAnalysis.OFFSET;     // 記録後解析の感度（v0.4.0）
  var REASON_LABEL = { manual: '手動で停止', auto: '時刻で自動終了', limit: '12時間で自動終了', interrupted: '途中で中断', error: 'エラーで終了' };
  var REASON_TAG = { interrupted: '中断', limit: '上限', error: 'エラー' };
  var WEEK = ['日', '月', '火', '水', '木', '金', '土'];
  // 同意の版。データの取り扱いを変えたら上げ、既存の利用者にも同意画面をもう一度出す（2: v0.6 で一晩分の音声を残すようにした）
  var CONSENT_VERSION = 2;

  var R = null;          // SleepRecorder（実機）またはモック
  var platform = 'browser';
  var current = null;    // 表示中の画面
  var prevScreen = 'home';
  var chart = null;
  var detail = null;     // 表示中のセッション
  var recTicker = null;
  var recStartedAt = 0;
  var pl = { mode: null, index: -1, timer: null, dragging: false, last: null, gen: 0, slot: 0 }; // 再生中の音声（openPlayer / playFrom）

  function $(id) { return document.getElementById(id); }

  // ---------------------------------------------------------------- 設定（端末内）

  var settings = (function () {
    var KEY = 'nemuri.settings';
    var s = {};
    try { s = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { s = {}; }
    if (!s.sensitivity) s.sensitivity = 'mid';
    if (!s.defaultEnd) s.defaultEnd = '06:30';
    s.save = function () {
      try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* 保存できなくても動作は続ける */ }
    };
    return s;
  })();

  // ---------------------------------------------------------------- 起動

  function boot() {
    R = (window.cordova && window.SleepRecorder) ? window.SleepRecorder : window.SleepRecorderMock;
    platform = window.cordova ? window.cordova.platformId : 'browser';
    chart = new window.SleepChart($('chart'), { onSelect: selectEvent });
    bindUI();
    $('app-version').textContent = 'バージョン ' + APP_VERSION + '　録音プラグイン ' +
      (pluginIsCurrent() ? '0.6（最新）' : typeof R.saveClip === 'function' ? '0.5（ビルドし直してください）' : '古い版（ビルドし直してください）');
    $('android-only').hidden = platform !== 'android';

    if (!settings.consented || (settings.consentVersion || 1) < CONSENT_VERSION) {
      $('consent-update').hidden = !settings.consented;
      show('consent');
      return;
    }
    afterConsent();
  }

  function afterConsent() {
    R.getState().then(function (st) {
      if (st && st.recording) {
        R.attach(onRecEvent, onRecError);
        enterRecording(st.startedAt, st.endAt);
      } else {
        R.recover().catch(function () {}).then(function () {
          show('home');
          processPendingAudio().then(function () { if (current === 'home') renderHome(); });
        });
      }
    }).catch(function () { show('home'); });
  }

  if (window.cordova) document.addEventListener('deviceready', boot, false);
  else document.addEventListener('DOMContentLoaded', boot, false);

  document.addEventListener('resume', function () {
    if (current === 'recording') {
      R.getState().then(function (st) { if (!st.recording) leaveRecording(); });
    } else {
      processPendingAudio().then(function () { if (current === 'home') renderHome(); });
    }
  }, false);

  document.addEventListener('backbutton', function () {
    if (!$('dialog').hidden) { closeDialog(null); return; }
    if (current === 'detail') { show(prevScreen); return; }
    if (current === 'settings') { show('home'); return; }
    if (navigator.app && navigator.app.exitApp) navigator.app.exitApp(); // 記録中でもサービスは動き続ける
  }, false);

  // ---------------------------------------------------------------- 画面切り替え

  var TAB_SCREENS = { home: 1, settings: 1 };

  function show(name) {
    if (current === 'detail' && name !== 'detail') stopPlayback();
    document.querySelectorAll('.screen').forEach(function (el) { el.hidden = el.id !== 'screen-' + name; });
    $('tabs').hidden = !TAB_SCREENS[name];
    document.querySelectorAll('.tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === name); });
    if (TAB_SCREENS[name]) prevScreen = name;
    current = name;
    render(name);
  }

  function render(name) {
    if (name === 'home') renderHome();
    else if (name === 'settings') renderSettings();
  }

  function bindUI() {
    document.querySelectorAll('[data-go]').forEach(function (b) {
      b.addEventListener('click', function () { show(b.dataset.go); });
    });
    document.querySelectorAll('[data-back]').forEach(function (b) {
      b.addEventListener('click', function () { show(prevScreen); });
    });
    document.querySelectorAll('[data-open-policy]').forEach(function (b) {
      b.addEventListener('click', openPolicy);
    });

    // 同意
    $('consent-check').addEventListener('change', function () { $('consent-accept').disabled = !this.checked; });
    $('consent-accept').addEventListener('click', function () {
      settings.consented = true;
      settings.consentedAt = Date.now();
      settings.consentVersion = CONSENT_VERSION;
      settings.save();
      afterConsent();
    });

    // ホーム
    $('start-btn').addEventListener('click', startRecording);
    $('sample-btn').addEventListener('click', function () { openDetail(SAMPLE_ID); });
    $('end-time').addEventListener('change', function () {
      if (this.value) { settings.lastEnd = this.value; settings.save(); }
    });

    // 記録中
    bindHoldToStop($('stop-btn'));

    // 詳細
    document.querySelectorAll('[data-window]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('[data-window]').forEach(function (x) { x.classList.toggle('on', x === b); });
        chart.setWindow(Number(b.dataset.window));
        $('chart-hint').hidden = b.dataset.window === '0';
      });
    });
    $('chart-hint').hidden = true;

    bindPlayer();

    // 設定
    document.querySelectorAll('input[name="sens"]').forEach(function (r) {
      r.addEventListener('change', function () { settings.sensitivity = r.value; settings.save(); });
    });
    $('default-end-time').addEventListener('change', function () {
      if (!this.value) return;
      settings.defaultEnd = this.value;
      settings.lastEnd = this.value;
      settings.save();
    });
    $('open-battery').addEventListener('click', function () { R.openBatterySettings(); });
    $('delete-all').addEventListener('click', function () {
      dialog({
        title: 'すべての記録を削除しますか？',
        body: '<p>グラフと音声をすべて削除します。削除した記録は元に戻せません。</p>',
        actions: [{ label: '削除する', value: true, kind: 'danger' }, { label: 'キャンセル', value: false }]
      }).then(function (yes) {
        if (!yes) return;
        R.deleteAll().then(function () { toast('すべての記録を削除しました'); });
      });
    });
  }

  // ---------------------------------------------------------------- ホーム

  function renderHome() {
    var h = new Date().getHours();
    $('home-greeting').textContent = (h >= 4 && h < 17) ? '今夜、寝る前にタップしてください' : 'おやすみの準備ができたら';
    $('end-time').value = settings.lastEnd || settings.defaultEnd;
    $('home-sensitivity').textContent = sensText(settings.sensitivity);
    $('start-btn').disabled = false;

    R.listSessions().then(function (list) {
      var box = $('records');
      var ul = $('session-list');
      ul.innerHTML = '';
      box.hidden = list.length === 0;
      $('list-foot').textContent = list.length
        ? list.length + ' / 30 件を保存しています。音声は新しい記録3回分だけ残ります。'
        : '';
      list.forEach(function (m) {
        var li = document.createElement('li');
        var b = document.createElement('button');
        b.className = 'session-row';
        b.innerHTML = sessionRowHtml(m);
        b.addEventListener('click', function () { openDetail(m.id); });
        li.appendChild(b);
        ul.appendChild(li);
      });
    }).catch(function () { $('records').hidden = true; });
  }

  function computeEndAt(hhmm) {
    var p = (hhmm || '06:30').split(':');
    var d = new Date();
    d.setHours(Number(p[0]), Number(p[1]), 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  // ---------------------------------------------------------------- 開始前チェックと開始

  function startRecording() {
    var btn = $('start-btn');
    btn.disabled = true;
    var endValue = $('end-time').value || settings.lastEnd || settings.defaultEnd;

    preflight(endValue).then(function (ok) {
      if (!ok) { btn.disabled = false; return; }
      settings.lastEnd = endValue;
      settings.save();
      var endAt = computeEndAt(endValue);
      R.start({ endAt: endAt, sensitivity: settings.sensitivity }, onRecEvent, onRecError);
      enterRecording(Date.now(), endAt);
    }).catch(function (e) {
      btn.disabled = false;
      toast(String(e && e.message || e || '記録を開始できませんでした'));
    });
  }

  /** ビルドに入っている録音プラグインが v0.6 以降か（画面だけ新しく、プラグインが古いままのビルドを見分ける） */
  function pluginIsCurrent() { return canCut(); }

  function preflight(endValue) {
    // 0. 録音プラグインが古いままのビルドでないか
    var check = pluginIsCurrent() ? Promise.resolve(true) : dialog({
      title: '録音プラグインが古いままです',
      body: '<p>このアプリに入っている録音プラグインが v0.6 より前のものです。このまま記録すると、一晩分の音声が残らず、好きな時刻から再生できません。</p>' +
        '<p>Monaca でプラグインを入れ直し、カスタムビルドデバッガーをビルドし直してください。</p>',
      actions: [{ label: 'やめる', value: false, kind: 'primary' }, { label: 'このまま始める', value: true }]
    });
    // 1. マイク（Android 13以降は通知も）
    return check.then(function (go) {
      if (!go) return { mic: 'cancel' };
      return R.checkPermissions();
    }).then(function (p) {
      if (p.mic === 'cancel') return p;
      if (p.mic === 'granted' && p.notification !== 'undetermined') return p;
      return R.requestPermissions();
    }).then(function (p) {
      if (p.mic === 'cancel') return null;
      if (p.mic !== 'granted') {
        return dialog({
          title: 'マイクの使用が許可されていません',
          body: '<p>音を記録するには、マイクの許可が必要です。設定アプリでこのアプリの「マイク」をオンにしてください。</p>',
          actions: [{ label: '設定を開く', value: 'settings', kind: 'primary' }, { label: '閉じる', value: null }]
        }).then(function (v) { if (v === 'settings') R.openAppSettings(); return false; });
      }
      return R.getDeviceStatus();
    }).then(function (st) {
      if (!st) return false;
      var chain = Promise.resolve(true);

      // 2. 中断についての案内（初回のみ）
      if (!settings.interruptTipShown) {
        chain = chain.then(function (go) {
          if (!go) return false;
          settings.interruptTipShown = true;
          settings.save();
          return dialog({
            title: '記録が止まる場合について',
            body: '<p>記録中に通話をしたり、ほかのアプリで音楽や動画を再生したりすると、記録はその時点で終了します。</p>' +
              (st.platform === 'android' ? '<p>一部の機種では省電力機能で記録が止まることがあります。電池の最適化からこのアプリを外しておくと安心です。</p>' : ''),
            actions: st.platform === 'android'
              ? [{ label: 'このまま始める', value: true, kind: 'primary' }, { label: '電池の最適化設定を開く', value: 'battery' }]
              : [{ label: 'わかりました', value: true, kind: 'primary' }]
          }).then(function (v) {
            if (v === 'battery') { R.openBatterySettings(); return false; }
            return !!v;
          });
        });
      }

      // 3. 充電
      chain = chain.then(function (go) {
        if (!go || st.charging) return go;
        return dialog({
          title: '充電されていません',
          body: '<p>一晩の記録はバッテリーを多く使います。充電ケーブルをつないでから始めることをおすすめします。</p>',
          actions: [{ label: '充電せずに始める', value: true, kind: 'primary' }, { label: 'やめる', value: false }]
        });
      });

      // 4. 空き容量
      chain = chain.then(function (go) {
        if (!go || st.freeMB >= 200) return go;
        return dialog({
          title: '空き容量が少なくなっています',
          body: '<p>空き容量は約' + st.freeMB + 'MBです。一晩の記録には最大で約130MBを使うため、保存できない場合があります。</p>',
          actions: [{ label: 'このまま始める', value: true, kind: 'primary' }, { label: 'やめる', value: false }]
        });
      });

      // 5. 終了時刻が近すぎないか
      chain = chain.then(function (go) {
        if (!go) return false;
        if (computeEndAt(endValue) - Date.now() >= 10 * 60 * 1000) return true;
        return dialog({
          title: '終了時刻が近すぎます',
          body: '<p>10分未満の記録は保存されません。自動で終了する時刻を確認してください。</p>',
          actions: [{ label: 'このまま始める', value: true, kind: 'primary' }, { label: 'やめる', value: false }]
        });
      });
      return chain;
    });
  }

  // ---------------------------------------------------------------- 記録中

  function enterRecording(startedAt, endAt) {
    recStartedAt = startedAt || Date.now();
    var end = new Date(endAt);
    $('rec-end').textContent = endAt ? fmtClock(end) + ' に自動で終了します' : '';
    $('stop-btn').classList.remove('holding');
    $('stop-btn').querySelector('span').textContent = '長押しで停止';
    setRing(-100);
    show('recording');
    tickElapsed();
    clearInterval(recTicker);
    recTicker = setInterval(tickElapsed, 1000);
  }

  function tickElapsed() {
    var s = Math.max(0, Math.floor((Date.now() - recStartedAt) / 1000));
    $('rec-elapsed').textContent = Math.floor(s / 3600) + ':' + pad2(Math.floor(s / 60) % 60) + ':' + pad2(s % 60);
  }

  function setRing(db) {
    // -70dB〜-20dB を 40px〜132px に対応させる
    var t = Math.min(1, Math.max(0, (db + 70) / 50));
    var size = 40 + t * 92;
    var ring = $('rec-ring');
    ring.style.width = size + 'px';
    ring.style.height = size + 'px';
    ring.style.borderColor = 'rgba(242,182,86,' + (0.35 + t * 0.5).toFixed(2) + ')';
  }

  function onRecEvent(e) {
    if (!e || !e.type) return;
    if (e.type === 'status') {
      if (e.startedAt) recStartedAt = e.startedAt;
      setRing(e.levelDb);
    } else if (e.type === 'stopped') {
      leaveRecording(e);
    }
  }

  function onRecError(err) {
    clearInterval(recTicker);
    show('home');
    dialog({
      title: '記録を開始できませんでした',
      body: '<p>' + escapeHtml(String(err || 'マイクを使用できませんでした')) + '</p>',
      actions: [{ label: '閉じる', value: null, kind: 'primary' }]
    });
  }

  function leaveRecording(e) {
    clearInterval(recTicker);
    if (!e) { show('home'); return; }
    if (e.saved) {
      openDetail(e.sessionId);
      if (e.reason === 'interrupted') {
        dialog({
          title: '記録が途中で止まりました',
          body: '<p>通話や、ほかのアプリの音声再生などで録音が中断されたため、その時点までを保存しました。</p>',
          actions: [{ label: '閉じる', value: null, kind: 'primary' }]
        });
      } else {
        toast('記録を保存しました');
      }
    } else {
      show('home');
      dialog({
        title: '記録は保存されませんでした',
        body: e.reason === 'error'
          ? '<p>マイクを開始できなかったため、記録を終了しました。ほかのアプリがマイクを使っていないか確認してください。</p>'
          : '<p>10分未満の記録は保存しません。</p>',
        actions: [{ label: '閉じる', value: null, kind: 'primary' }]
      });
    }
  }

  function bindHoldToStop(btn) {
    var timer = null;
    var label = btn.querySelector('span');
    function cancel() {
      clearTimeout(timer);
      timer = null;
      btn.classList.remove('holding');
    }
    btn.addEventListener('pointerdown', function (ev) {
      ev.preventDefault();
      btn.classList.add('holding');
      timer = setTimeout(function () {
        timer = null;
        label.textContent = '停止しています';
        R.stop().catch(function () { toast('停止できませんでした。もう一度お試しください'); cancel(); label.textContent = '長押しで停止'; });
      }, 1200);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (t) {
      btn.addEventListener(t, function () { if (timer) cancel(); });
    });
    btn.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
  }

  // ---------------------------------------------------------------- 記録一覧

  function sessionRowHtml(m) {
    var st = new Date(m.startedAt), en = new Date(m.endedAt);
    var tag = REASON_TAG[m.endReason] ? '<span class="session-tag">' + REASON_TAG[m.endReason] + '</span>' : '';
    var count = sessionCount(m);
    return '<span class="session-date">' + fmtDate(st) + tag + '</span>' +
      (count != null
        ? '<span class="session-count"><b>' + count + '</b><small>か所</small></span>'
        : '<span class="session-count"><b>—</b><small></small></span>') +
      '<span class="session-span">' + fmtClock(st) + '〜' + fmtClock(en) + '（' + fmtDuration(m.durationSec) + '）</span>';
  }

  /** 一覧に出す「○か所」。v0.6 以降は今の感度の数、v0.5 は切り出したときの数。未解析は null */
  function sessionCount(m) {
    var counts = m.analysis && m.analysis.counts;
    if (counts && counts[settings.sensitivity] != null) return counts[settings.sensitivity];
    if ((m.algo || 1) >= 3 && m.audio !== 'full') return m.eventCount || 0;
    return null;
  }

  // ---------------------------------------------------------------- 記録後の解析

  /** まだ解析していない記録を解析する（v0.6 以降は一晩分の音声をそのまま残す） */
  var analyzing = null;
  function processPendingAudio() {
    if (analyzing) return analyzing;
    analyzing = R.listSessions().then(function (list) {
      return list.filter(function (m) { return m.audio === 'full' && !m.analysis; }).reduce(function (p, m) {
        return p.then(function () { return analyzeSession(m.id); });
      }, Promise.resolve());
    }).catch(function () {}).then(function () { analyzing = null; });
    return analyzing;
  }

  function analyzeSession(id) {
    return R.getSession(id).then(function (s) {
      if (s.meta.audio !== 'full' || s.meta.analysis) return;
      var values = decodeGraph(s.graph);
      var sens = SENS_OFFSET[s.meta.sensitivity] != null ? s.meta.sensitivity : 'mid';
      // 録音プラグインが v0.6 より前なら、以前どおり時間帯だけ切り出して残す
      if (!canCut()) {
        var a = window.SleepAnalysis.analyze(values, SENS_OFFSET[sens]);
        var ranges = window.SleepAnalysis.clipRanges(a.segments, values.length);
        return R.trimAudio(id, ranges, { sensitivity: sens, offsetDb: SENS_OFFSET[sens], algo: 3 });
      }
      // 感度を変えても一覧の「○か所」がすぐ出るよう、3つの感度すべての数を残す
      var counts = {};
      Object.keys(SENS_OFFSET).forEach(function (k) { counts[k] = window.SleepAnalysis.analyze(values, SENS_OFFSET[k]).segments.length; });
      return R.saveAnalysis(id, { algo: 3, sensitivity: sens, offsetDb: SENS_OFFSET[sens], counts: counts, eventCount: counts[sens] });
    });
  }

  /** 一晩分の音声から好きな範囲を切り出せる録音プラグイン（v0.6 以降）か */
  function canCut() { return typeof R.cutClip === 'function' && typeof R.saveAnalysis === 'function'; }

  // ---------------------------------------------------------------- 詳細

  // サンプルの記録（sample.js）。審査や初めての利用者が、記録しなくても記録の画面を確認できるようにする
  var SAMPLE_ID = 'sample';
  var CLIP_PAD = 5;          // 時間帯の再生は前後5秒を含める
  var CHUNK_SEC = 30 * 60;   // 好きな時刻からの再生は30分ずつ切り出して、続けて再生する

  function openDetail(id) {
    show('detail');
    $('detail-title').textContent = '記録';
    $('detail-summary').innerHTML = '';
    $('event-list').innerHTML = '';
    $('audio-note').textContent = '';
    setPick(null);
    var load = id === SAMPLE_ID ? Promise.resolve(window.SleepSample.demo()) : R.getSession(id).then(function (s) {
      if (s.meta.audio !== 'full' || s.meta.analysis) return s;
      $('audio-note').textContent = '記録を整理しています…';
      return analyzeSession(id).then(function () { return R.getSession(id); });
    });
    load.then(function (s) {
      var m = s.meta;
      var st = new Date(m.startedAt), en = new Date(m.endedAt);
      var values = decodeGraph(s.graph);

      // v0.5 で時間帯だけ切り出した記録は、切り出したときの感度で解析すると時間帯と音声が一致する。
      // それ以外（一晩分の音声あり・音声なし）は今の設定の感度で解析する
      var info = s.segments && s.segments.info;
      var sensKey = info && info.sensitivity ? info.sensitivity : settings.sensitivity;
      var offset = info && info.offsetDb != null ? info.offsetDb : SENS_OFFSET[settings.sensitivity];
      var a = window.SleepAnalysis.analyze(values, offset);
      var clips = (s.segments && s.segments.segments) || [];
      var hasFull = m.audio === 'full' && canCut();
      var hasClips = m.audio === 'segments' && clips.length > 0;
      // 以前の方式（v0.3 以前のプラグイン）で録音し、検知した音の音声が残っている場合はそれを使う
      var legacy = (m.algo || 1) < 3 && m.hasAudio && (s.events || []).some(function (e) { return e.clip; });
      if (legacy) {
        a.segments = s.events.map(function (e) {
          var off = e.clipOffset != null ? e.clipOffset : 1;
          return { start: e.start, end: e.end, dur: e.dur, peakDb: e.peakDb, aboveDb: null,
            clip: e.clip || null, clipStart: e.start - off };
        });
      }
      a.segments.forEach(function (seg) {
        if (legacy) return;
        if (hasFull) {
          // 再生するときに一晩分の音声から切り出す
          seg.cut = true;
          seg.clip = 'cut';
          seg.clipStart = Math.max(0, seg.start - CLIP_PAD);
          seg.clipEnd = Math.min(values.length, seg.end + CLIP_PAD);
          return;
        }
        var c = clips.filter(function (x) { return x.start <= seg.start && x.end >= seg.end; })[0];
        if (c && hasClips) { seg.clip = c.clip; seg.clipStart = c.start; }
      });
      detail = { meta: m, segments: a.segments, total: values.length, full: hasFull };

      var total = a.segments.reduce(function (t, x) { return t + x.dur; }, 0);
      $('detail-title').textContent = m.sample ? 'サンプルの記録' : fmtDate(st) + 'の記録';
      $('detail-summary').innerHTML =
        '<p class="detail-span">' + fmtClock(st) + '〜' + fmtClock(en) + '　' + (REASON_LABEL[m.endReason] || '') +
        '　感度 ' + sensText(sensKey, offset) + '</p>' +
        stat(fmtDuration(m.durationSec), '記録時間') +
        stat(a.segments.length + ' か所', '続いた音 計' + fmtHm(total)) +
        stat(m.maxDb == null ? '—' : m.maxDb.toFixed(1) + ' dB', '最大の音量');

      // 表示範囲を「全体」に戻す
      document.querySelectorAll('[data-window]').forEach(function (x) { x.classList.toggle('on', x.dataset.window === '0'); });
      $('chart-hint').hidden = true;
      chart.windowSec = 0;
      chart.onPick = hasFull ? setPick : null;
      chart.setData({ values: values, startedAt: m.startedAt, events: a.segments, thr: a.thr, level: a.level });

      $('audio-note').textContent = m.sample
        ? 'これは表示の例として作ったサンプルの記録で、音声はありません。実際の記録では、グラフの好きな位置をタップしてその時刻から音を聞いたり、時間帯ごとに再生ボタンで聞いたりできます。'
        : hasFull
        ? 'グラフの好きな位置をタップすると、その時刻から続けて再生できます。' +
          (a.segments.length ? '再生ボタンでは、その時間帯の音を聞けます（前後5秒を含む）。' : '大きめの音が続いた時間帯はありませんでした。') +
          '音声は新しい記録3回分だけ残ります。'
        : !a.segments.length
        ? '大きめの音が続いた時間帯はありませんでした。'
        : legacy
          ? 'この記録は以前の方式（記録中に検知）で録音したため、そのとき検知した音を表示しています。'
          : hasClips
          ? '再生ボタンで、その時間帯の音を聞けます（前後5秒を含む）。'
          : m.audio === 'full'
            ? '録音プラグインが古いため、この記録の音声を再生できません。ビルドし直してください。'
            : (m.algo || 1) >= 3
              ? '音声は新しい記録3回分だけ残すため、この記録はグラフのみです。'
              : 'この記録は以前の方式で録音したため、時間帯の音声はありません。';
      renderEvents(detail);
    }).catch(function () {
      toast('記録を読み込めませんでした');
      show('home');
    });
  }

  function stat(v, label) { return '<div class="stat"><b>' + v + '</b><span>' + label + '</span></div>'; }

  function renderEvents(d) {
    var ul = $('event-list');
    ul.innerHTML = '';
    d.segments.forEach(function (e, i) {
      var li = document.createElement('li');
      li.className = 'event-row';
      li.dataset.index = i;
      var t0 = new Date(d.meta.startedAt + e.start * 1000), t1 = new Date(d.meta.startedAt + e.end * 1000);
      li.innerHTML =
        '<button class="event-main" type="button">' +
          '<div class="event-time">' + fmtClock(t0, true) + ' <span class="event-span">〜' + fmtClock(t1, true) + '</span></div>' +
          '<div class="event-meta">' + fmtSeconds(e.dur) + (e.aboveDb != null ? '　平均 +' + e.aboveDb.toFixed(1) + ' dB' : '') +
            '　最大 ' + Number(e.peakDb).toFixed(1) + ' dB</div>' +
        '</button>' +
        (e.clip ? '<button class="play" type="button" aria-label="' + fmtClock(t0, true) + ' からの音を再生">' + PLAY_ICON + '</button>' : '');
      li.querySelector('.event-main').addEventListener('click', function () { selectEvent(i, true); });
      var pb = li.querySelector('.play');
      if (pb) pb.addEventListener('click', function () { openPlayer(i); });
      ul.appendChild(li);
    });
  }

  var PLAY_ICON = '<svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z"/></svg>';
  var PAUSE_ICON = '<svg viewBox="0 0 16 16"><rect x="3.5" y="2.5" width="3" height="11" rx="1"/><rect x="9.5" y="2.5" width="3" height="11" rx="1"/></svg>';

  function selectEvent(i, fromList) {
    document.querySelectorAll('.event-row').forEach(function (r) { r.classList.toggle('selected', Number(r.dataset.index) === i); });
    if (fromList) chart.select(i, true);
    else {
      var row = document.querySelector('.event-row[data-index="' + i + '"]');
      if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  /** グラフでタップした時刻（再生を始める位置）。null で消す */
  function setPick(sec) {
    $('pick-play').hidden = sec == null;
    if (sec == null) { if (chart) chart.setCursor(null); return; }
    $('pick-label').textContent = clockAt(sec) + ' から再生';
  }

  // ---------------------------------------------------------------- 再生（プレーヤー）
  //
  // event: 一覧の時間帯を再生（前後5秒を含む）。その時間帯の終わりで止まる
  // free : グラフで選んだ時刻から再生。30分ずつ切り出し、終わりが近づいたら次を用意して記録の最後まで続ける

  function clockAt(sec) { return fmtClock(new Date(detail.meta.startedAt + sec * 1000), true); }

  /** 切り出しに使うファイル名。再生中のファイルを上書きしないよう2つを交互に使う */
  function nextSlot() { pl.slot = pl.slot === 1 ? 2 : 1; return 'play' + pl.slot + '.aac'; }

  function cut(start, end) { return R.cutClip(detail.meta.id, start, end, nextSlot()); }

  /** プレーヤーを開いて再生を始める。load は { clip, start, end } を返す Promise */
  function startClip(mode, index, load, title) {
    stopPlayback();
    var gen = pl.gen;
    $('player-title').textContent = title;
    $('player-pos').textContent = mode === 'free' ? title.replace(' から', '') : '0:00';
    $('player-dur').textContent = '';
    $('player-seek').value = 0;
    $('player').hidden = false;
    return load.then(function (c) {
      if (gen !== pl.gen) return;
      return R.playClip(detail.meta.id, c.clip, { rate: 1 }).then(function (st) {
        if (gen !== pl.gen) return;
        pl.mode = mode;
        pl.index = index;
        pl.clip = c.clip;
        pl.base = c.start;
        pl.chunkEnd = c.end;
        updateNavButtons();
        applyState(st);
        pl.timer = setInterval(pollPlayer, 250);
      });
    }).catch(function (err) {
      if (gen !== pl.gen) return;
      $('player').hidden = true;
      toast(String(err || '音声を再生できませんでした'));
    });
  }

  function openPlayer(i) {
    if (pl.mode === 'event' && pl.index === i && pl.last && pl.last.loaded) { togglePause(); return; }
    var e = detail.segments[i];
    if (!e.clip) { toast('この時間帯の音声はありません'); return; }
    selectEvent(i, true);
    var title = clockAt(e.start) + ' からの ' + fmtSeconds(e.dur);
    var load = e.cut ? cut(e.clipStart, e.clipEnd) : Promise.resolve({ clip: e.clip, start: e.clipStart, end: null });
    startClip('event', i, load, title);
  }

  /** sec（記録開始からの秒）から、記録の最後まで続けて再生する */
  function playFrom(sec, origin) {
    sec = Math.max(0, Math.min(detail.total - 1, sec));
    var p = startClip('free', -1, cut(sec, Math.min(detail.total, sec + CHUNK_SEC)), clockAt(sec) + ' から');
    pl.origin = origin != null ? origin : sec;
    return p;
  }

  /** free の再生中に、記録全体の中の位置 sec へ移る（今の30分の外なら切り出し直す） */
  function seekAbs(sec) {
    sec = Math.max(0, Math.min(detail.total - 1, sec));
    if (sec >= pl.base && sec < pl.chunkEnd - 1) { R.seekClip(sec - pl.base).then(applyState); return; }
    var paused = pl.last && !pl.last.playing && !pl.last.ended;
    playFrom(sec, pl.origin).then(function () {
      // 一時停止中に動かしたときは、一時停止のままにする
      if (paused && pl.mode) R.pauseClip().then(applyState);
    });
  }

  function pollPlayer() { R.getClipState().then(applyState).catch(function () {}); }

  function posAbs() { return pl.base + (pl.last ? pl.last.position : 0); }

  function applyState(st) {
    if (!pl.mode) return;
    pl.last = st;
    if (!st || !st.loaded) return;
    var seek = $('player-seek'), abs = pl.base + st.position;
    if (pl.mode === 'free') {
      // シークバーは記録全体。時刻で表示する
      seek.max = Math.max(1, Math.round(detail.total * 10));
      if (!pl.dragging) {
        seek.value = Math.round(abs * 10);
        $('player-pos').textContent = clockAt(abs);
      }
      $('player-dur').textContent = clockAt(detail.total);
      continueFree(st);
    } else {
      var e = detail.segments[pl.index];
      var dur = st.duration || (e.dur + 10);
      seek.max = Math.max(1, Math.round(dur * 10));
      if (!pl.dragging) {
        seek.value = Math.round(st.position * 10);
        $('player-pos').textContent = fmtTime(st.position);
      }
      $('player-dur').textContent = fmtTime(dur);
    }
    var playing = st.playing || pl.switching;
    var tg = $('player-toggle');
    tg.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
    tg.setAttribute('aria-label', playing ? '一時停止' : '再生');
    setRowPlaying(pl.mode === 'event' ? pl.index : -1, st.playing);
    chart.setPlayhead(abs);
  }

  /** free: 終わりの20秒前に次の30分を切り出しておき、終わったらすぐ続きを再生する */
  function continueFree(st) {
    if (pl.chunkEnd >= detail.total || pl.switching) return;
    var gen = pl.gen;
    if (!pl.next && !pl.fetching && st.duration && st.position >= st.duration - 20) {
      pl.fetching = true;
      cut(pl.chunkEnd, Math.min(detail.total, pl.chunkEnd + CHUNK_SEC)).then(function (c) {
        if (gen !== pl.gen) return;
        pl.fetching = false;
        pl.next = c;
      }).catch(function () { if (gen === pl.gen) pl.fetching = false; });
    }
    if (st.ended && pl.next) {
      var next = pl.next;
      pl.next = null;
      pl.switching = true;
      R.playClip(detail.meta.id, next.clip, { rate: 1 }).then(function (s2) {
        if (gen !== pl.gen) return;
        pl.switching = false;
        pl.clip = next.clip;
        pl.base = next.start;
        pl.chunkEnd = next.end;
        applyState(s2);
      }).catch(function () {
        if (gen !== pl.gen) return;
        pl.switching = false;
        toast('続きを再生できませんでした');
      });
    }
  }

  function togglePause() {
    var st = pl.last;
    if (!st || !st.loaded) return;
    if (pl.mode === 'free' && st.ended && pl.chunkEnd >= detail.total) { seekAbs(pl.origin); return; }
    (st.playing ? R.pauseClip() : R.resumeClip()).then(applyState);
  }

  function skip(delta) {
    if (!pl.last) return;
    if (pl.mode === 'free') { seekAbs(posAbs() + delta); return; }
    R.seekClip(Math.max(0, pl.last.position + delta)).then(applyState);
  }

  /** 音声のある時間帯を、i から dir 方向（-1 / +1）に探す。なければ -1 */
  function clipIndex(i, dir) {
    for (var k = i + dir; k >= 0 && k < detail.segments.length; k += dir) {
      if (detail.segments[k].clip) return k;
    }
    return -1;
  }

  /** free: sec より後（dir=1）／前（dir=-1）に始まる時間帯。なければ -1 */
  function segmentNear(sec, dir) {
    var s = detail.segments, k;
    if (dir > 0) { for (k = 0; k < s.length; k++) if (s[k].start - CLIP_PAD > sec + 1) return k; }
    else { for (k = s.length - 1; k >= 0; k--) if (s[k].start - CLIP_PAD < sec - 3) return k; }
    return -1;
  }

  function updateNavButtons() {
    $('player-next').disabled = pl.mode === 'event' && clipIndex(pl.index, 1) < 0;
  }

  // 「最初に戻す」: 1回目で先頭（free は再生を始めた時刻）へ。続けてもう1回（0.4秒以内）で前の時間帯へ
  var lastRestartTap = 0;
  function onRestart() {
    var now = Date.now();
    var dbl = now - lastRestartTap < 400;
    lastRestartTap = now;
    if (!pl.mode) return;
    if (dbl) {
      lastRestartTap = 0;
      if (pl.mode === 'free') {
        var k = segmentNear(posAbs(), -1);
        if (k >= 0) seekAbs(detail.segments[k].start - CLIP_PAD);
        else toast('前の時間帯はありません');
        return;
      }
      var prev = clipIndex(pl.index, -1);
      if (prev >= 0) openPlayer(prev);
      else toast('前の時間帯はありません');
      return;
    }
    if (pl.mode === 'free') { seekAbs(pl.origin); return; }
    R.seekClip(0).then(applyState);
  }

  function onNext() {
    if (pl.mode === 'free') {
      var k = segmentNear(posAbs(), 1);
      if (k >= 0) seekAbs(detail.segments[k].start - CLIP_PAD);
      else toast('この後に続いた音はありません');
      return;
    }
    if (pl.index < 0) return;
    var next = clipIndex(pl.index, 1);
    if (next >= 0) openPlayer(next);
  }

  /** 再生中の音声を端末に保存する（iOS は共有シートから「ファイルに保存」）。free は再生中の30分 */
  function saveCurrentClip() {
    if (!pl.mode || !pl.clip) return;
    var t = new Date(detail.meta.startedAt + pl.base * 1000);
    var ext = /\.m4a$/.test(pl.clip) ? '.m4a' : '.aac';
    var name = 'nemuri_' + t.getFullYear() + pad2(t.getMonth() + 1) + pad2(t.getDate()) + '_' +
      pad2(t.getHours()) + pad2(t.getMinutes()) + pad2(t.getSeconds()) + ext;
    if (typeof R.saveClip !== 'function') { toast('録音プラグインが古いため保存できません。ビルドし直してください'); return; }
    R.saveClip(detail.meta.id, pl.clip, name).then(function (r) {
      if (r && r.method === 'saved') toast('「' + (r.path || name) + '」に保存しました');
      else if (r && r.completed) toast('保存しました');
    }).catch(function (err) { toast(String(err || '保存できませんでした')); });
  }

  function stopPlayback() {
    clearInterval(pl.timer);
    pl.timer = null;
    pl.gen++;
    if (pl.mode) { setRowPlaying(-1, false); R.stopClip(); }
    pl.mode = null;
    pl.index = -1;
    pl.last = null;
    pl.clip = null;
    pl.next = null;
    pl.fetching = false;
    pl.switching = false;
    $('player').hidden = true;
    if (chart) chart.setPlayhead(null);
  }

  function setRowPlaying(i, playing) {
    document.querySelectorAll('.event-row').forEach(function (row) {
      var b = row.querySelector('.play');
      if (!b) return;
      var on = Number(row.dataset.index) === i && playing;
      b.innerHTML = on ? PAUSE_ICON : PLAY_ICON;
      b.classList.toggle('playing', on);
    });
  }

  function bindPlayer() {
    $('player-toggle').addEventListener('click', togglePause);
    $('player-back').addEventListener('click', function () { skip(-10); });
    $('player-fwd').addEventListener('click', function () { skip(10); });
    $('player-restart').addEventListener('click', onRestart);
    $('player-next').addEventListener('click', onNext);
    $('player-save').addEventListener('click', saveCurrentClip);
    $('player-close').addEventListener('click', stopPlayback);
    $('pick-play').addEventListener('click', function () { if (chart.cursor != null) playFrom(chart.cursor); });
    var seek = $('player-seek');
    seek.addEventListener('input', function () {
      pl.dragging = true;
      $('player-pos').textContent = pl.mode === 'free' ? clockAt(seek.value / 10) : fmtTime(seek.value / 10);
    });
    seek.addEventListener('change', function () {
      pl.dragging = false;
      if (pl.mode === 'free') seekAbs(seek.value / 10);
      else R.seekClip(seek.value / 10).then(applyState);
    });
  }

  function decodeGraph(b64) {
    var bin = atob(b64 || '');
    var n = Math.floor(bin.length / 2);
    var out = new Int16Array(n);
    for (var i = 0; i < n; i++) {
      var v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
      out[i] = v >= 0x8000 ? v - 0x10000 : v; // little-endian int16
    }
    return out;
  }

  // ---------------------------------------------------------------- 設定

  function renderSettings() {
    document.querySelectorAll('[data-sens-label]').forEach(function (el) { el.textContent = sensText(el.dataset.sensLabel); });
    document.querySelectorAll('input[name="sens"]').forEach(function (r) { r.checked = r.value === settings.sensitivity; });
    $('default-end-time').value = settings.defaultEnd;
  }

  function openPolicy() {
    var tpl = $('policy-template').content.cloneNode(true);
    var wrap = document.createElement('div');
    wrap.appendChild(tpl);
    dialog({ title: 'プライバシーポリシー', body: wrap.innerHTML, actions: [{ label: '閉じる', value: null, kind: 'primary' }] });
  }

  // ---------------------------------------------------------------- ダイアログ・トースト

  var dialogResolve = null;

  function dialog(opt) {
    if (dialogResolve) closeDialog(null);
    $('dialog-title').textContent = opt.title;
    $('dialog-body').innerHTML = opt.body || '';
    var box = $('dialog-actions');
    box.innerHTML = '';
    (opt.actions || []).forEach(function (a) {
      var b = document.createElement('button');
      b.className = 'btn' + (a.kind ? ' ' + a.kind : '');
      b.textContent = a.label;
      b.addEventListener('click', function () { closeDialog(a.value); });
      box.appendChild(b);
    });
    $('dialog').hidden = false;
    var first = box.querySelector('button');
    if (first) first.focus();
    return new Promise(function (resolve) { dialogResolve = resolve; });
  }

  function closeDialog(value) {
    $('dialog').hidden = true;
    var r = dialogResolve;
    dialogResolve = null;
    if (r) r(value);
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    // プレーヤー表示中はその上に、タブのある画面ではタブの上に出す
    var player = $('player');
    t.style.bottom = (!player.hidden && current === 'detail')
      ? (player.getBoundingClientRect().height + 12) + 'px'
      : '';
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  // ---------------------------------------------------------------- 書式

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDate(d) { return (d.getMonth() + 1) + '月' + d.getDate() + '日（' + WEEK[d.getDay()] + '）'; }
  function fmtClock(d, sec) { return d.getHours() + ':' + pad2(d.getMinutes()) + (sec ? ':' + pad2(d.getSeconds()) : ''); }
  function fmtDuration(s) {
    s = Math.round(s || 0);
    var h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
    return h ? h + '時間' + m + '分' : m + '分';
  }
  function fmtSeconds(s) {
    s = Math.round(s);
    if (s >= 3600) return Math.floor(s / 3600) + '時間' + (Math.floor(s / 60) % 60) + '分';
    return s >= 60 ? Math.floor(s / 60) + '分' + (s % 60) + '秒' : s + '秒';
  }
  /** 1時間25分 → 1:25 */
  function fmtHm(s) {
    s = Math.round(s || 0);
    return Math.floor(s / 3600) + ':' + pad2(Math.floor(s / 60) % 60);
  }
  function fmtTime(s) {
    s = Math.max(0, Math.floor(s || 0));
    var h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
    return h ? h + ':' + pad2(m) + ':' + pad2(x) : m + ':' + pad2(x);
  }
  /** 「中 (10dB)」の形式 */
  function sensText(key, offset) {
    return (SENS_LABEL[key] || '') + ' (' + (offset != null ? offset : SENS_OFFSET[key]) + 'dB)';
  }
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
})();
