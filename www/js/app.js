/*
 * 眠りの音 — 画面と操作
 * 録音・検知・保存はネイティブプラグイン（SleepRecorder）が行う。ここでは指示と表示のみ。
 */
(function () {
  'use strict';

  var APP_VERSION = '0.5.2';
  var SENS_LABEL = { low: '低', mid: '中', high: '高' };
  // 感度ごとのしきい値（周囲の音＋何dBで検知するか）。新しい記録は meta.offsetDb に保存された値を使う
  var SENS_OFFSET = window.SleepAnalysis.OFFSET;     // 記録後解析の感度（v0.4.0）
  var REASON_LABEL = { manual: '手動で停止', auto: '時刻で自動終了', limit: '12時間で自動終了', interrupted: '途中で中断', error: 'エラーで終了' };
  var REASON_TAG = { interrupted: '中断', limit: '上限', error: 'エラー' };
  var WEEK = ['日', '月', '火', '水', '木', '金', '土'];

  var R = null;          // SleepRecorder（実機）またはモック
  var platform = 'browser';
  var current = null;    // 表示中の画面
  var prevScreen = 'home';
  var chart = null;
  var detail = null;     // 表示中のセッション
  var recTicker = null;
  var recStartedAt = 0;
  var pl = { index: -1, timer: null, dragging: false, last: null }; // 再生中のイベント音声

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
      (typeof R.saveClip === 'function' ? '0.5（最新）' : pluginIsCurrent() ? '0.4（ビルドし直してください）' : '古い版（ビルドし直してください）');
    $('android-only').hidden = platform !== 'android';

    if (!settings.consented) { show('consent'); return; }
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
        ? list.length + ' / 30 件を保存しています。音声は最新の記録のみ残ります。'
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

  /** ビルドに入っている録音プラグインが v0.4 以降か（画面だけ新しく、プラグインが古いままのビルドを見分ける） */
  function pluginIsCurrent() { return typeof R.trimAudio === 'function'; }

  function preflight(endValue) {
    // 0. 録音プラグインが古いままのビルドでないか
    var check = pluginIsCurrent() ? Promise.resolve(true) : dialog({
      title: '録音プラグインが古いままです',
      body: '<p>このアプリに入っている録音プラグインが v0.4 より前のものです。このまま記録すると、新しい方式（一晩録音して、続いた音を残す）では録音されません。</p>' +
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
        if (!go || st.freeMB >= 100) return go;
        return dialog({
          title: '空き容量が少なくなっています',
          body: '<p>空き容量は約' + st.freeMB + 'MBです。記録を保存できない場合があります。</p>',
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
    return '<span class="session-date">' + fmtDate(st) + tag + '</span>' +
      ((m.algo || 1) >= 3 && m.audio !== 'full'
        ? '<span class="session-count"><b>' + (m.eventCount || 0) + '</b><small>か所</small></span>'
        : '<span class="session-count"><b>—</b><small></small></span>') +
      '<span class="session-span">' + fmtClock(st) + '〜' + fmtClock(en) + '（' + fmtDuration(m.durationSec) + '）</span>';
  }

  // ---------------------------------------------------------------- 詳細

  /** 一晩分の音声が残っている記録を解析し、大きめの音が続いた時間帯だけ音声を残す */
  var trimming = null;
  function processPendingAudio() {
    if (trimming) return trimming;
    trimming = R.listSessions().then(function (list) {
      return list.filter(function (m) { return m.audio === 'full'; }).reduce(function (p, m) {
        return p.then(function () { return trimSession(m.id); });
      }, Promise.resolve());
    }).catch(function () {}).then(function () { trimming = null; });
    return trimming;
  }

  function trimSession(id) {
    return R.getSession(id).then(function (s) {
      if (s.meta.audio !== 'full') return;
      var values = decodeGraph(s.graph);
      var offset = SENS_OFFSET[s.meta.sensitivity] != null ? SENS_OFFSET[s.meta.sensitivity] : SENS_OFFSET.mid;
      var a = window.SleepAnalysis.analyze(values, offset);
      var ranges = window.SleepAnalysis.clipRanges(a.segments, values.length);
      return R.trimAudio(id, ranges, { sensitivity: s.meta.sensitivity, offsetDb: offset, algo: 3 });
    });
  }

  // サンプルの記録（sample.js）。審査や初めての利用者が、記録しなくても記録の画面を確認できるようにする
  var SAMPLE_ID = 'sample';

  function openDetail(id) {
    show('detail');
    $('detail-title').textContent = '記録';
    $('detail-summary').innerHTML = '';
    $('event-list').innerHTML = '';
    $('audio-note').textContent = '';
    var load = id === SAMPLE_ID ? Promise.resolve(window.SleepSample.demo()) : R.getSession(id).then(function (s) {
      if (s.meta.audio !== 'full') return s;
      $('audio-note').textContent = '音声を整理しています…';
      return trimSession(id).then(function () { return R.getSession(id); });
    });
    load.then(function (s) {
      var m = s.meta;
      var st = new Date(m.startedAt), en = new Date(m.endedAt);
      var values = decodeGraph(s.graph);

      // 音声を切り出したときの感度で解析すると、時間帯と音声が一致する。
      // それ以外（音声なし）は今の設定の感度で解析する
      var info = s.segments && s.segments.info;
      var sensKey = info && info.sensitivity ? info.sensitivity : settings.sensitivity;
      var offset = info && info.offsetDb != null ? info.offsetDb : SENS_OFFSET[settings.sensitivity];
      var a = window.SleepAnalysis.analyze(values, offset);
      var clips = (s.segments && s.segments.segments) || [];
      var hasAudio = m.audio === 'segments' && clips.length > 0;
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
        var c = clips.filter(function (x) { return x.start <= seg.start && x.end >= seg.end; })[0];
        if (c && hasAudio) { seg.clip = c.clip; seg.clipStart = c.start; }
      });
      detail = { meta: m, segments: a.segments };

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
      chart.setData({ values: values, startedAt: m.startedAt, events: a.segments, thr: a.thr, level: a.level });

      $('audio-note').textContent = m.sample
        ? 'これは表示の例として作ったサンプルの記録で、音声はありません。実際の記録では、時間帯ごとに再生ボタンで音を聞けます。'
        : !a.segments.length
        ? '大きめの音が続いた時間帯はありませんでした。'
        : legacy
          ? 'この記録は以前の方式（記録中に検知）で録音したため、そのとき検知した音を表示しています。'
          : hasAudio
          ? '再生ボタンで、その時間帯の音を聞けます（前後5秒を含む）。音声は最新の記録のみ残ります。'
          : (m.algo || 1) >= 3
            ? '音声は最新の記録のみ残すため、この記録はグラフのみです。'
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

  // ---------------------------------------------------------------- 再生（プレーヤー）

  function openPlayer(i) {
    if (pl.index === i && pl.last && pl.last.loaded) { togglePause(); return; }
    stopPlayback();
    var e = detail.segments[i];
    if (!e.clip) { toast('この時間帯の音声はありません'); return; }
    selectEvent(i, true);
    var t = new Date(detail.meta.startedAt + e.start * 1000);
    $('player-title').textContent = fmtClock(t, true) + ' からの ' + fmtSeconds(e.dur);
    $('player-pos').textContent = '0:00';
    $('player-dur').textContent = '';
    $('player-seek').value = 0;
    $('player').hidden = false;
    updateNavButtons(i);
    R.playClip(detail.meta.id, e.clip, { rate: 1 }).then(function (st) {
      pl.index = i;
      applyState(st);
      pl.timer = setInterval(pollPlayer, 250);
    }).catch(function (err) {
      $('player').hidden = true;
      toast(String(err || '音声を再生できませんでした'));
    });
  }

  function pollPlayer() { R.getClipState().then(applyState).catch(function () {}); }

  function applyState(st) {
    if (pl.index < 0) return;
    pl.last = st;
    if (!st || !st.loaded) return;
    var e = detail.segments[pl.index];
    var dur = st.duration || (e.dur + 10);
    var seek = $('player-seek');
    seek.max = Math.max(1, Math.round(dur * 10));
    if (!pl.dragging) {
      seek.value = Math.round(st.position * 10);
      $('player-pos').textContent = fmtTime(st.position);
    }
    $('player-dur').textContent = fmtTime(dur);
    var tg = $('player-toggle');
    tg.innerHTML = st.playing ? PAUSE_ICON : PLAY_ICON;
    tg.setAttribute('aria-label', st.playing ? '一時停止' : '再生');
    setRowPlaying(pl.index, st.playing);
    // グラフ上の再生位置（音声ファイルの先頭は clipStart 秒）
    chart.setPlayhead(e.clipStart + st.position);
  }

  function togglePause() {
    var st = pl.last;
    if (!st || !st.loaded) return;
    (st.playing ? R.pauseClip() : R.resumeClip()).then(applyState);
  }

  function skip(delta) {
    if (!pl.last) return;
    R.seekClip(Math.max(0, pl.last.position + delta)).then(applyState);
  }

  /** 音声のある時間帯を、i から dir 方向（-1 / +1）に探す。なければ -1 */
  function clipIndex(i, dir) {
    for (var k = i + dir; k >= 0 && k < detail.segments.length; k += dir) {
      if (detail.segments[k].clip) return k;
    }
    return -1;
  }

  function updateNavButtons(i) {
    $('player-next').disabled = clipIndex(i, 1) < 0;
  }

  // 「最初に戻す」: 1回目で先頭へ。続けてもう1回（0.4秒以内）で前の時間帯へ
  var lastRestartTap = 0;
  function onRestart() {
    var now = Date.now();
    var dbl = now - lastRestartTap < 400;
    lastRestartTap = now;
    if (pl.index < 0) return;
    if (dbl) {
      lastRestartTap = 0;
      var prev = clipIndex(pl.index, -1);
      if (prev >= 0) openPlayer(prev);
      else toast('前の時間帯はありません');
      return;
    }
    R.seekClip(0).then(applyState);
  }

  function onNext() {
    if (pl.index < 0) return;
    var next = clipIndex(pl.index, 1);
    if (next >= 0) openPlayer(next);
  }

  /** 再生中の時間帯の音声を端末に保存する（iOS は共有シートから「ファイルに保存」） */
  function saveCurrentClip() {
    if (pl.index < 0) return;
    var e = detail.segments[pl.index];
    var t = new Date(detail.meta.startedAt + (e.clipStart != null ? e.clipStart : e.start) * 1000);
    var ext = /\.m4a$/.test(e.clip) ? '.m4a' : '.aac';
    var name = 'nemuri_' + t.getFullYear() + pad2(t.getMonth() + 1) + pad2(t.getDate()) + '_' +
      pad2(t.getHours()) + pad2(t.getMinutes()) + pad2(t.getSeconds()) + ext;
    if (typeof R.saveClip !== 'function') { toast('録音プラグインが古いため保存できません。ビルドし直してください'); return; }
    R.saveClip(detail.meta.id, e.clip, name).then(function (r) {
      if (r && r.method === 'saved') toast('「' + (r.path || name) + '」に保存しました');
      else if (r && r.completed) toast('保存しました');
    }).catch(function (err) { toast(String(err || '保存できませんでした')); });
  }

  function stopPlayback() {
    clearInterval(pl.timer);
    pl.timer = null;
    if (pl.index >= 0) { setRowPlaying(pl.index, false); R.stopClip(); }
    pl.index = -1;
    pl.last = null;
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
    var seek = $('player-seek');
    seek.addEventListener('input', function () {
      pl.dragging = true;
      $('player-pos').textContent = fmtTime(seek.value / 10);
    });
    seek.addEventListener('change', function () {
      pl.dragging = false;
      R.seekClip(seek.value / 10).then(applyState);
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
