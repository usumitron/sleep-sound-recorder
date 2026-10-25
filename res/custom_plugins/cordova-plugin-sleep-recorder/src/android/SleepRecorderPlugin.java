package com.sleepsound.recorder;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.os.StatFs;
import android.provider.Settings;

import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.apache.cordova.PluginResult;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

public class SleepRecorderPlugin extends CordovaPlugin implements RecorderService.Listener {
    private static final int REQ_PERMS = 7302;
    private static final int REQ_SAVE = 7303;
    private String[] pendingSave;
    private CallbackContext saveCallback;

    private CallbackContext eventCallback;
    private CallbackContext permCallback;
    private MediaPlayer player;

    @Override
    public boolean execute(String action, JSONArray args, CallbackContext cb) throws JSONException {
        switch (action) {
            case "start": start(args.optJSONObject(0), cb); return true;
            case "attach": attach(cb); return true;
            case "stop": RecorderService.requestStop("manual"); cb.success(); return true;
            case "getState": cb.success(state()); return true;
            case "recover": runBg(() -> {
                SessionStore.recover(ctx(), RecorderService.activeId);
                SessionStore.applyRetention(ctx());
                cb.success();
            }); return true;
            case "listSessions": runBg(() -> cb.success(SessionStore.list(ctx()))); return true;
            case "getSession": {
                final String id = args.getString(0);
                runBg(() -> {
                    try { cb.success(SessionStore.get(ctx(), id)); }
                    catch (Exception e) { cb.error("セッションを読み込めませんでした"); }
                });
                return true;
            }
            case "trimAudio": {
                final String id = args.getString(0);
                final JSONArray ranges = args.getJSONArray(1);
                final JSONObject info = args.optJSONObject(2);
                runBg(() -> {
                    try { cb.success(SessionStore.trim(ctx(), id, ranges, info)); }
                    catch (Exception e) { cb.error("音声を切り出せませんでした: " + e); }
                });
                return true;
            }
            case "deleteAll": runBg(() -> { SessionStore.deleteAll(ctx(), RecorderService.activeId); cb.success(); }); return true;
            case "playClip": playClip(args.getString(0), args.getString(1), args.optJSONObject(2), cb); return true;
            case "pauseClip": if (player != null && player.isPlaying()) player.pause(); cb.success(clipState()); return true;
            case "resumeClip": resumeClip(); cb.success(clipState()); return true;
            case "seekClip": seekClip(args.getDouble(0)); cb.success(clipState()); return true;
            case "setClipRate": setClipRate((float) args.getDouble(0)); cb.success(clipState()); return true;
            case "getClipState": cb.success(clipState()); return true;
            case "stopClip": stopClip(); cb.success(); return true;
            case "saveClip": saveClip(args.getString(0), args.getString(1), args.optString(2, ""), cb); return true;
            case "getDiagnostics": runBg(() -> {
                try { cb.success(SessionStore.diagnostics(ctx())); }
                catch (Exception e) { cb.error(String.valueOf(e)); }
            }); return true;
            case "checkPermissions": cb.success(permissions()); return true;
            case "requestPermissions": requestPermissions(cb); return true;
            case "getDeviceStatus": cb.success(deviceStatus()); return true;
            case "openAppSettings": openAppSettings(); cb.success(); return true;
            case "openBatterySettings": openBatterySettings(); cb.success(); return true;
            default: return false;
        }
    }

    private Context ctx() { return cordova.getContext().getApplicationContext(); }

    private void runBg(Runnable r) { cordova.getThreadPool().execute(r); }

    // ------------------------------------------------------------------ 記録

    private void start(JSONObject opts, CallbackContext cb) {
        if (RecorderService.isRecording()) { cb.error("すでに記録中です"); return; }
        if (!cordova.hasPermission(Manifest.permission.RECORD_AUDIO)) { cb.error("マイクの使用が許可されていません"); return; }

        eventCallback = cb;
        RecorderService.listener = this;

        Intent i = new Intent(ctx(), RecorderService.class);
        i.putExtra(RecorderService.EXTRA_END_AT, opts == null ? 0 : opts.optLong("endAt", 0));
        i.putExtra(RecorderService.EXTRA_SENSITIVITY, opts == null ? "mid" : opts.optString("sensitivity", "mid"));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx().startForegroundService(i);
        else ctx().startService(i);

        PluginResult pr = new PluginResult(PluginResult.Status.NO_RESULT);
        pr.setKeepCallback(true);
        cb.sendPluginResult(pr);
    }

    private void attach(CallbackContext cb) {
        eventCallback = cb;
        RecorderService.listener = this;
        PluginResult pr = new PluginResult(PluginResult.Status.NO_RESULT);
        pr.setKeepCallback(true);
        cb.sendPluginResult(pr);
    }

    private JSONObject state() throws JSONException {
        JSONObject s = new JSONObject();
        boolean rec = RecorderService.isRecording();
        s.put("recording", rec);
        s.put("sessionId", rec && RecorderService.activeId != null ? RecorderService.activeId : JSONObject.NULL);
        s.put("startedAt", rec ? RecorderService.activeStartedAt : 0);
        s.put("endAt", rec ? RecorderService.activeEndAt : 0);
        return s;
    }

    @Override
    public void onStatus(JSONObject status) { send(status, true); }

    @Override
    public void onStopped(JSONObject result) { send(result, true); }

    private void send(JSONObject obj, boolean keep) {
        CallbackContext cb = eventCallback;
        if (cb == null) return;
        PluginResult pr = new PluginResult(PluginResult.Status.OK, obj);
        pr.setKeepCallback(keep);
        cb.sendPluginResult(pr);
    }

    @Override
    public void onDestroy() {
        if (RecorderService.listener == this) RecorderService.listener = null;
        stopClip();
        super.onDestroy();
    }

    // ------------------------------------------------------------------ 再生

    private float rate = 1f;
    private boolean ended = false;

    private void playClip(String sessionId, String clip, JSONObject opts, CallbackContext cb) {
        stopClip();
        if (clip.contains("/") || sessionId.contains("/")) { cb.error("不正なファイル名です"); return; }
        File f = new File(new File(SessionStore.dir(ctx(), sessionId), "clips"), clip);
        if (!f.exists()) { cb.error("この音声は保存されていません"); return; }
        if (opts != null) rate = (float) opts.optDouble("rate", rate);
        try {
            player = new MediaPlayer();
            player.setDataSource(f.getAbsolutePath());
            player.setOnCompletionListener(mp -> ended = true);
            player.prepare();
            double pos = opts == null ? 0 : opts.optDouble("position", 0);
            if (pos > 0) player.seekTo((int) (pos * 1000));
            ended = false;
            player.start();
            applyRate();
            cb.success(clipState());
        } catch (Exception e) {
            stopClip();
            cb.error("音声を再生できませんでした");
        }
    }

    private void resumeClip() {
        if (player == null) return;
        if (ended) { player.seekTo(0); ended = false; }
        player.start();
        applyRate();
    }

    private void seekClip(double sec) {
        if (player == null) return;
        int ms = (int) Math.max(0, Math.min(player.getDuration(), sec * 1000));
        player.seekTo(ms);
        ended = ms >= player.getDuration();
    }

    private void setClipRate(float r) {
        rate = Math.max(0.5f, Math.min(3f, r));
        if (player != null && player.isPlaying()) applyRate();
    }

    private void applyRate() {
        if (player == null || Build.VERSION.SDK_INT < 23) return;
        try {
            player.setPlaybackParams(player.getPlaybackParams().setSpeed(rate));
        } catch (Exception ignored) { }
    }

    private JSONObject clipState() throws JSONException {
        JSONObject s = new JSONObject();
        boolean has = player != null;
        s.put("loaded", has);
        s.put("playing", has && player.isPlaying());
        s.put("position", has ? player.getCurrentPosition() / 1000.0 : 0);
        s.put("duration", has ? player.getDuration() / 1000.0 : 0);
        s.put("ended", ended);
        s.put("rate", rate);
        return s;
    }

    private void stopClip() {
        if (player != null) {
            try { player.stop(); } catch (Exception ignored) { }
            player.release();
            player = null;
        }
        ended = false;
    }

    // ------------------------------------------------------------------ 保存（ダウンロードフォルダ）

    private void saveClip(String sid, String clip, String name, CallbackContext cb) {
        if (clip.contains("/") || sid.contains("/")) { cb.error("不正なファイル名です"); return; }
        if (name.isEmpty() || name.contains("/")) name = clip;
        File src = new File(new File(SessionStore.dir(ctx(), sid), "clips"), clip);
        if (!src.exists()) { cb.error("この音声は保存されていません"); return; }
        // Android 9 以前は共有ストレージへの書き込み権限が必要
        if (Build.VERSION.SDK_INT < 29 && !cordova.hasPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)) {
            pendingSave = new String[] { sid, clip, name };
            saveCallback = cb;
            cordova.requestPermission(this, REQ_SAVE, Manifest.permission.WRITE_EXTERNAL_STORAGE);
            return;
        }
        final String fname = name;
        runBg(() -> {
            try {
                String path = copyToDownloads(src, fname);
                JSONObject r = new JSONObject();
                r.put("method", "saved");
                r.put("path", path);
                cb.success(r);
            } catch (Exception e) {
                cb.error("保存できませんでした: " + e.getMessage());
            }
        });
    }

    private String copyToDownloads(File src, String name) throws Exception {
        String mime = name.endsWith(".m4a") ? "audio/mp4" : "audio/aac";
        if (Build.VERSION.SDK_INT >= 29) {
            android.content.ContentValues v = new android.content.ContentValues();
            v.put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(android.provider.MediaStore.MediaColumns.MIME_TYPE, mime);
            v.put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, android.os.Environment.DIRECTORY_DOWNLOADS);
            android.content.ContentResolver cr = ctx().getContentResolver();
            Uri uri = cr.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (uri == null) throw new java.io.IOException("insert failed");
            try (java.io.OutputStream out = cr.openOutputStream(uri);
                 java.io.InputStream in = new java.io.FileInputStream(src)) {
                copy(in, out);
            }
        } else {
            File dir = android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS);
            dir.mkdirs();
            try (java.io.OutputStream out = new java.io.FileOutputStream(new File(dir, name));
                 java.io.InputStream in = new java.io.FileInputStream(src)) {
                copy(in, out);
            }
        }
        return "ダウンロード/" + name;
    }

    private static void copy(java.io.InputStream in, java.io.OutputStream out) throws java.io.IOException {
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }

    // ------------------------------------------------------------------ 権限・端末状態

    private JSONObject permissions() throws JSONException {
        JSONObject p = new JSONObject();
        p.put("mic", cordova.hasPermission(Manifest.permission.RECORD_AUDIO) ? "granted" : "undetermined");
        if (Build.VERSION.SDK_INT >= 33) {
            p.put("notification", cordova.hasPermission(Manifest.permission.POST_NOTIFICATIONS) ? "granted" : "undetermined");
        } else {
            p.put("notification", "notRequired");
        }
        return p;
    }

    private void requestPermissions(CallbackContext cb) throws JSONException {
        List<String> need = new ArrayList<>();
        if (!cordova.hasPermission(Manifest.permission.RECORD_AUDIO)) need.add(Manifest.permission.RECORD_AUDIO);
        if (Build.VERSION.SDK_INT >= 33 && !cordova.hasPermission(Manifest.permission.POST_NOTIFICATIONS)) {
            need.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (need.isEmpty()) { cb.success(permissions()); return; }
        permCallback = cb;
        cordova.requestPermissions(this, REQ_PERMS, need.toArray(new String[0]));
    }

    @Override
    public void onRequestPermissionResult(int requestCode, String[] permissions, int[] grantResults) throws JSONException {
        if (requestCode == REQ_SAVE && saveCallback != null) {
            CallbackContext cb = saveCallback;
            String[] a = pendingSave;
            saveCallback = null;
            pendingSave = null;
            if (cordova.hasPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)) saveClip(a[0], a[1], a[2], cb);
            else cb.error("ファイルを保存する権限が許可されませんでした");
            return;
        }
        if (requestCode != REQ_PERMS || permCallback == null) return;
        JSONObject p = new JSONObject();
        p.put("mic", cordova.hasPermission(Manifest.permission.RECORD_AUDIO) ? "granted" : "denied");
        if (Build.VERSION.SDK_INT >= 33) {
            p.put("notification", cordova.hasPermission(Manifest.permission.POST_NOTIFICATIONS) ? "granted" : "denied");
        } else {
            p.put("notification", "notRequired");
        }
        permCallback.success(p);
        permCallback = null;
    }

    private JSONObject deviceStatus() throws JSONException {
        JSONObject s = new JSONObject();
        Intent bat = ctx().registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        int st = bat == null ? -1 : bat.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
        s.put("charging", st == BatteryManager.BATTERY_STATUS_CHARGING || st == BatteryManager.BATTERY_STATUS_FULL);
        StatFs fs = new StatFs(ctx().getFilesDir().getAbsolutePath());
        s.put("freeMB", fs.getAvailableBytes() / (1024 * 1024));
        s.put("platform", "android");
        return s;
    }

    private void openAppSettings() {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + ctx().getPackageName()));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        cordova.getActivity().startActivity(i);
    }

    private void openBatterySettings() {
        Intent i = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        cordova.getActivity().startActivity(i);
    }
}
