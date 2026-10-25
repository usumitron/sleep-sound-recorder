package com.sleepsound.recorder;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioRecordingConfiguration;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import org.json.JSONObject;

import java.util.List;

/**
 * 録音・検知・保存を行うフォアグラウンドサービス（マイク）。
 * 画面ロック中も動作し、JS（WebView）には依存しない。
 */
public class RecorderService extends Service {
    private static final String TAG = "SleepRecorder";
    static final String EXTRA_END_AT = "endAt";
    static final String EXTRA_SENSITIVITY = "sensitivity";
    static final String ACTION_STOP = "com.sleepsound.recorder.STOP";

    static final int SAMPLE_RATE = 16000;
    static final int FRAMES_PER_SEC = 10;
    static final int FRAME_SAMPLES = SAMPLE_RATE / FRAMES_PER_SEC;           // 100ms
    static final int CHECKPOINT_FRAMES = 30 * FRAMES_PER_SEC;                // 30秒ごと
    static final long MAX_RECORDING_MS = 12L * 60 * 60 * 1000;               // 安全上限12時間

    private static final String CHANNEL_ID = "sleep_recorder";
    private static final int NOTIFICATION_ID = 7301;

    /** プラグインへの通知 */
    interface Listener {
        void onStatus(JSONObject status);
        void onStopped(JSONObject result);
    }

    static volatile RecorderService instance;
    static volatile Listener listener;

    // セッション状態（getState 用）
    static volatile String activeId;
    static volatile long activeStartedAt;
    static volatile long activeEndAt;

    private volatile boolean running = false;
    private volatile String stopReason = "manual";
    private Thread worker;
    private PowerManager.WakeLock wakeLock;
    private AudioRecord record;
    private AudioManager.AudioRecordingCallback recordingCallback;
    private final Handler main = new Handler(Looper.getMainLooper());

    static boolean isRecording() { return instance != null && instance.running; }

    static void requestStop(String reason) {
        RecorderService s = instance;
        if (s != null) s.stopWith(reason);
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopWith("manual");
            return START_NOT_STICKY;
        }
        if (running) return START_NOT_STICKY;
        if (intent == null) { // OSによる再起動では再開しない（初回バージョンの仕様）
            stopSelf();
            return START_NOT_STICKY;
        }

        long endAt = intent.getLongExtra(EXTRA_END_AT, 0);
        String sensitivity = intent.getStringExtra(EXTRA_SENSITIVITY);
        if (sensitivity == null) sensitivity = "mid";

        startForegroundCompat();
        instance = this;

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SleepRecorder:rec");
        wakeLock.acquire(MAX_RECORDING_MS + 10 * 60 * 1000);

        running = true;
        final long fEndAt = endAt;
        final String fSens = sensitivity;
        worker = new Thread(() -> runLoop(fEndAt, fSens), "SleepRecorder");
        worker.start();
        return START_NOT_STICKY;
    }

    private void stopWith(String reason) {
        if (!running) return;
        stopReason = reason;
        running = false;
    }

    // ------------------------------------------------------------------ 録音ループ
    // v0.4.0: 一晩すべてを録音し（clips/full.aac）、1秒ごとの音量をグラフ用に保存する。
    // 「大きな音が続いた時間帯」の判定と切り出しは、記録の後に行う（JS の解析 → trimAudio）。

    private void runLoop(long endAt, String sensitivity) {
        long startedAt = System.currentTimeMillis();
        SessionStore.Active session;
        try {
            SessionStore.recover(this, null);
            session = new SessionStore.Active(this, startedAt, endAt, sensitivity);
        } catch (Exception e) {
            Log.e(TAG, "session create failed", e);
            SessionStore.log(this, "start failed: " + e);
            notifyStopped(null, "error", false);
            shutdown();
            return;
        }
        activeId = session.id();
        activeStartedAt = startedAt;
        activeEndAt = endAt;

        int minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        try {
            record = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(minBuf, FRAME_SAMPLES * 2 * 4));
            record.startRecording();
        } catch (Exception e) {
            Log.e(TAG, "AudioRecord failed", e);
            stopReason = "error";
            running = false;
        }
        registerSilenceCallback();

        AdtsWriter audio = null;
        try {
            audio = new AdtsWriter(session.fullAudioFile(), SAMPLE_RATE);
        } catch (Exception e) {
            Log.e(TAG, "audio writer failed", e);
            SessionStore.log(this, "audio writer failed: " + e);
        }

        short[] frame = new short[FRAME_SAMPLES];
        short[] graphBuf = new short[CHECKPOINT_FRAMES / FRAMES_PER_SEC + 2];
        int graphCount = 0;
        long frames = 0;
        double secMax = Double.NEGATIVE_INFINITY;
        double maxDb = Double.NEGATIVE_INFINITY;
        long framesSinceCheckpoint = 0;

        while (running) {
            int got = 0;
            while (got < FRAME_SAMPLES && running) {
                int n = record.read(frame, got, FRAME_SAMPLES - got);
                if (n < 0) { stopReason = "interrupted"; running = false; break; }
                got += n;
            }
            if (got < FRAME_SAMPLES) break;
            frames++;

            if (audio != null) {
                try {
                    audio.write(frame, FRAME_SAMPLES);
                } catch (Exception e) {
                    Log.e(TAG, "audio write failed", e);
                    SessionStore.log(this, "audio write failed: " + e);
                    audio.finish();
                    audio = null;
                }
            }

            // 1秒値 = 100msごとの音量の最大値
            double db = rmsDb(frame);
            if (db > secMax) secMax = db;
            if (frames % FRAMES_PER_SEC == 0) {
                if (graphCount < graphBuf.length) graphBuf[graphCount++] = (short) Math.round(secMax * 10);
                if (secMax > maxDb) maxDb = secMax;
                pushStatus(frames, secMax, endAt);
                secMax = Double.NEGATIVE_INFINITY;
            }

            if (++framesSinceCheckpoint >= CHECKPOINT_FRAMES) {
                graphCount = checkpoint(session, graphBuf, graphCount, maxDb, audio);
                framesSinceCheckpoint = 0;
            }

            long now = System.currentTimeMillis();
            if (endAt > 0 && now >= endAt) stopWith("auto");
            else if (now - startedAt >= MAX_RECORDING_MS) stopWith("limit");
        }

        // ---- 終了処理
        if (audio != null) audio.finish();
        checkpoint(session, graphBuf, graphCount, maxDb, null);

        releaseRecord();
        boolean saved = SessionStore.finish(this, session.id(), stopReason, System.currentTimeMillis());
        notifyStopped(session.id(), stopReason, saved);
        activeId = null;
        shutdown();
    }

    private int checkpoint(SessionStore.Active session, short[] buf, int count, double maxDb, AdtsWriter audio) {
        try {
            session.appendGraph(buf, count);
            session.checkpoint(maxDb);
            if (audio != null) audio.flush();
        } catch (Exception e) {
            Log.e(TAG, "checkpoint failed", e);
        }
        return 0;
    }

    static double rmsDb(short[] s) {
        double sum = 0;
        for (short v : s) sum += (double) v * v;
        double rms = Math.sqrt(sum / s.length) / 32768.0;
        double db = rms > 0 ? 20 * Math.log10(rms) : -100;
        return Math.max(-100, Math.min(0, db));
    }

    // ------------------------------------------------------------------ 中断検知

    private void registerSilenceCallback() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || record == null) return;
        AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        final int sessionId = record.getAudioSessionId();
        recordingCallback = new AudioManager.AudioRecordingCallback() {
            @Override
            public void onRecordingConfigChanged(List<AudioRecordingConfiguration> configs) {
                for (AudioRecordingConfiguration c : configs) {
                    if (c.getClientAudioSessionId() == sessionId && c.isClientSilenced()) {
                        stopWith("interrupted");
                    }
                }
            }
        };
        am.registerAudioRecordingCallback(recordingCallback, main);
    }

    private void releaseRecord() {
        if (recordingCallback != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            am.unregisterAudioRecordingCallback(recordingCallback);
            recordingCallback = null;
        }
        if (record != null) {
            try { record.stop(); } catch (Exception ignored) { }
            record.release();
            record = null;
        }
    }

    // ------------------------------------------------------------------ 通知

    private void pushStatus(long frames, double levelDb, long endAt) {
        Listener l = listener;
        if (l == null) return;
        try {
            JSONObject st = new JSONObject();
            st.put("type", "status");
            st.put("sessionId", activeId);
            st.put("startedAt", activeStartedAt);
            st.put("elapsedSec", frames / FRAMES_PER_SEC);
            st.put("levelDb", SessionStore.round1(levelDb));
            st.put("endAt", endAt);
            l.onStatus(st);
        } catch (Exception ignored) { }
    }

    private void notifyStopped(String id, String reason, boolean saved) {
        Listener l = listener;
        if (l == null) return;
        try {
            JSONObject s = new JSONObject();
            s.put("type", "stopped");
            s.put("sessionId", id == null ? JSONObject.NULL : id);
            s.put("reason", reason);
            s.put("saved", saved);
            l.onStopped(s);
        } catch (Exception ignored) { }
    }

    private void shutdown() {
        running = false;
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        main.post(() -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE);
            else stopForeground(true);
            stopSelf();
            instance = null;
        });
    }

    private void startForegroundCompat() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "睡眠中の記録", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }

        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent open = PendingIntent.getActivity(this, 0, launch, piFlags);
        Intent stop = new Intent(this, RecorderService.class).setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 1, stop, piFlags);

        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        b.setContentTitle("睡眠中の音を記録しています")
         .setContentText("停止するにはアプリを開くか、ここから停止してください")
         .setSmallIcon(getApplicationInfo().icon)
         .setOngoing(true)
         .setContentIntent(open)
         .addAction(new Notification.Action.Builder(null, "停止", stopPi).build());
        Notification n = b.build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }
}
