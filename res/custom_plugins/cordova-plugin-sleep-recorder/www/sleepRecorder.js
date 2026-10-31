var exec = require('cordova/exec');

function call(action, args) {
  return new Promise(function (resolve, reject) {
    exec(resolve, reject, 'SleepRecorder', action, args || []);
  });
}

/**
 * SleepRecorder
 *
 * 録音・検知・保存はすべてネイティブ側で行う。JS側は指示と表示のみ。
 * すべてのメソッドは Promise を返す（start / attach を除く）。
 */
var SleepRecorder = {
  /**
   * 記録を開始する。
   * @param {Object} opts { endAt: 自動終了時刻(epoch ms), sensitivity: 'low'|'mid'|'high' }
   * @param {Function} onEvent 状態通知。{type:'status', ...} または {type:'stopped', ...}
   * @param {Function} onError エラー通知
   */
  start: function (opts, onEvent, onError) {
    exec(onEvent, onError, 'SleepRecorder', 'start', [opts || {}]);
  },

  /** 記録中に画面を再読み込みした場合などに、状態通知を受け取り直す */
  attach: function (onEvent, onError) {
    exec(onEvent, onError, 'SleepRecorder', 'attach', []);
  },

  /** 手動停止 */
  stop: function () { return call('stop'); },

  /** { recording: bool, sessionId, startedAt, endAt } */
  getState: function () { return call('getState'); },

  /** 強制終了で残った未完了セッションを復旧し、保存ルールを適用する */
  recover: function () { return call('recover'); },

  /** セッション情報の一覧（新しい順） */
  listSessions: function () { return call('listSessions'); },

  /**
   * { meta, graph: base64(int16LE, 0.1dB単位, 1秒刻み), segments: segments.json の内容 | null }
   * meta.audio: 'full'（一晩分の音声あり） / 'segments'（切り出し済み。v0.5 で記録したもの） / 'none'
   * meta.analysis: saveAnalysis で保存した解析結果（未解析なら無し）
   */
  getSession: function (id) { return call('getSession', [id]); },

  /**
   * 一晩分の音声から ranges [{start, end}]（秒）だけを切り出して残し、残りを削除する。
   * info（感度など）は segments.json に保存される。→ { info, segments: [{start, end, clip}] }
   */
  trimAudio: function (id, ranges, info) { return call('trimAudio', [id, ranges, info || {}]); },

  /**
   * 一晩分の音声（full.aac）から start〜end 秒を clips/<name> に書き出す（v0.6）。full.aac は残す。
   * name は 'play' で始まり '.aac' で終わる名前。→ { start, end, clip }。以降は playClip / saveClip で扱う
   */
  cutClip: function (id, start, end, name) { return call('cutClip', [id, start, end, name || 'play1.aac']); },

  /** 記録後の解析結果を meta.analysis に保存する（v0.6）。info.eventCount は meta.eventCount にも入る */
  saveAnalysis: function (id, info) { return call('saveAnalysis', [id, info || {}]); },

  deleteAll: function () { return call('deleteAll'); },

  /**
   * イベント音声を再生する。opts: { rate: 0.5〜3, position: 開始位置（秒） }
   * 以降の再生操作はすべて { loaded, playing, position, duration, ended, rate } を返す
   */
  playClip: function (sessionId, clip, opts) { return call('playClip', [sessionId, clip, opts || {}]); },
  pauseClip: function () { return call('pauseClip'); },
  resumeClip: function () { return call('resumeClip'); },
  seekClip: function (sec) { return call('seekClip', [sec]); },
  setClipRate: function (rate) { return call('setClipRate', [rate]); },
  getClipState: function () { return call('getClipState'); },
  stopClip: function () { return call('stopClip'); },

  /**
   * 音声ファイルを端末に保存する。fileName は保存時の名前。
   * iOS: 共有シートを開く（「ファイルに保存」で保存）→ { method: 'share', completed }
   * Android: 「ダウンロード」フォルダに保存 → { method: 'saved', path }
   */
  saveClip: function (sessionId, clip, fileName) { return call('saveClip', [sessionId, clip, fileName]); },

  /** 保存処理の記録（開発用）: { dirs: [...], log: '...' } */
  getDiagnostics: function () { return call('getDiagnostics'); },

  /** { mic: 'granted'|'denied'|'undetermined', notification: 'granted'|'denied'|'notRequired' } */
  checkPermissions: function () { return call('checkPermissions'); },
  requestPermissions: function () { return call('requestPermissions'); },

  /** { charging: bool, freeMB: number, platform: 'ios'|'android' } */
  getDeviceStatus: function () { return call('getDeviceStatus'); },

  openAppSettings: function () { return call('openAppSettings'); },
  /** Android のみ。電池の最適化設定を開く */
  openBatterySettings: function () { return call('openBatterySettings'); }
};

module.exports = SleepRecorder;
