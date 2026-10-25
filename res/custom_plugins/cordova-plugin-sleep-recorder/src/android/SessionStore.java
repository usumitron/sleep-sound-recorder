package com.sleepsound.recorder;

import android.content.Context;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FileReader;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * セッションの保存とルール適用。
 *
 * sessions/<id>/meta.json     セッション情報
 * sessions/<id>/graph.bin     1秒値（int16LE, 0.1dB単位）
 * sessions/<id>/segments.json 大きな音が続いた時間帯と音声ファイル（記録後の解析で作成）
 * sessions/<id>/clips/        音声（最新の保存セッションのみ）
 *                               full.aac   記録中の一晩分（解析後に削除）
 *                               seg_*.aac  時間帯ごとに切り出した音声
 */
final class SessionStore {
    static final int MAX_SESSIONS = 30;
    static final int MIN_DURATION_SEC = 600;

    static File root(Context ctx) {
        File r = new File(ctx.getFilesDir(), "sessions");
        if (!r.exists()) r.mkdirs();
        return r;
    }

    static File dir(Context ctx, String id) { return new File(root(ctx), id); }

    // ---------------------------------------------------------------- 書き込み中のセッション

    static final class Active {
        final File dir;
        final JSONObject meta;

        Active(Context ctx, long startedAt, long plannedEndAt, String sensitivity) throws Exception {
            String id = String.valueOf(startedAt);
            dir = dir(ctx, id);
            new File(dir, "clips").mkdirs();
            meta = new JSONObject();
            meta.put("id", id);
            meta.put("startedAt", startedAt);
            meta.put("endedAt", JSONObject.NULL);
            meta.put("lastWriteAt", startedAt);
            meta.put("durationSec", 0);
            meta.put("endReason", JSONObject.NULL);
            meta.put("sensitivity", sensitivity);
            meta.put("algo", 3);
            meta.put("audio", "full");   // full: 解析待ち / segments: 切り出し済み / none: 音声なし
            meta.put("plannedEndAt", plannedEndAt);
            meta.put("eventCount", 0);
            meta.put("maxDb", JSONObject.NULL);
            meta.put("hasAudio", true);
            writeMeta(dir, meta);
            log(ctx, "start " + id + " sens=" + sensitivity);
        }

        String id() { return meta.optString("id"); }

        void appendGraph(short[] values, int count) throws IOException {
            if (count == 0) return;
            byte[] b = new byte[count * 2];
            for (int i = 0; i < count; i++) {
                b[i * 2] = (byte) (values[i] & 0xff);
                b[i * 2 + 1] = (byte) ((values[i] >> 8) & 0xff);
            }
            try (FileOutputStream fo = new FileOutputStream(new File(dir, "graph.bin"), true)) {
                fo.write(b);
            }
        }

        void appendEvent(JSONObject ev) throws IOException {
            try (FileOutputStream fo = new FileOutputStream(new File(dir, "events.jsonl"), true)) {
                fo.write((ev.toString() + "\n").getBytes(StandardCharsets.UTF_8));
            }
        }

        File fullAudioFile() { return new File(new File(dir, "clips"), "full.aac"); }

        void checkpoint(double maxDb) throws Exception {
            meta.put("lastWriteAt", System.currentTimeMillis());
            meta.put("durationSec", graphSeconds(dir));
            if (!Double.isInfinite(maxDb)) meta.put("maxDb", round1(maxDb));
            writeMeta(dir, meta);
        }
    }

    // ---------------------------------------------------------------- 終了処理・ルール

    /** 終了処理。10分未満なら破棄。保存したら true。 */
    static boolean finish(Context ctx, String id, String reason, long endedAt) {
        File d = dir(ctx, id);
        try {
            JSONObject meta = readMeta(d);
            int dur = graphSeconds(d);
            if (dur < MIN_DURATION_SEC) {
                log(ctx, "discard " + id + " (" + dur + "s < 10min) reason=" + reason);
                deleteRecursive(d);
                applyRetention(ctx);
                return false;
            }
            meta.put("endedAt", endedAt);
            meta.put("durationSec", dur);
            meta.put("endReason", reason);
            writeMeta(d, meta);
            log(ctx, "saved " + id + " (" + dur + "s) reason=" + reason);
            applyRetention(ctx);
            return true;
        } catch (Exception e) {
            log(ctx, "finish failed " + id + ": " + e);
            deleteRecursive(d);
            return false;
        }
    }

    /** 強制終了などで終了処理されなかったセッションを復旧する。 */
    static void recover(Context ctx, String activeId) {
        File[] dirs = root(ctx).listFiles();
        if (dirs == null) return;
        for (File d : dirs) {
            if (!d.isDirectory() || d.getName().equals(activeId)) continue;
            try {
                JSONObject meta = readMeta(d);
                if (meta.isNull("endedAt")) {
                    log(ctx, "recover " + d.getName());
                    finish(ctx, d.getName(), "interrupted", meta.optLong("lastWriteAt"));
                }
            } catch (Exception e) {
                log(ctx, "unreadable, deleted " + d.getName() + ": " + e);
                deleteRecursive(d);
            }
        }
    }

    /** 音声は最新の保存セッションのみ残す。件数は30件まで。 */
    static void applyRetention(Context ctx) {
        List<JSONObject> done = finishedMetas(ctx);
        for (int i = 0; i < done.size(); i++) {
            JSONObject m = done.get(i);
            File d = dir(ctx, m.optString("id"));
            if (i >= MAX_SESSIONS) {
                log(ctx, "retention: delete oldest " + m.optString("id"));
                deleteRecursive(d);
            } else if (i > 0 && m.optBoolean("hasAudio")) {
                deleteRecursive(new File(d, "clips"));
                try {
                    m.put("hasAudio", false);
                    m.put("audio", "none");
                    writeMeta(d, m);
                } catch (Exception ignored) { }
            }
        }
    }

    // ---------------------------------------------------------------- 読み出し

    /** 終了済みセッション（新しい順） */
    static List<JSONObject> finishedMetas(Context ctx) {
        List<JSONObject> list = new ArrayList<>();
        File[] dirs = root(ctx).listFiles();
        if (dirs != null) {
            for (File d : dirs) {
                if (!d.isDirectory()) continue;
                try {
                    JSONObject m = readMeta(d);
                    if (!m.isNull("endedAt")) list.add(m);
                } catch (Exception ignored) { }
            }
        }
        Collections.sort(list, (a, b) -> Long.compare(b.optLong("startedAt"), a.optLong("startedAt")));
        return list;
    }

    static JSONArray list(Context ctx) {
        JSONArray arr = new JSONArray();
        for (JSONObject m : finishedMetas(ctx)) arr.put(m);
        return arr;
    }

    static JSONObject get(Context ctx, String id) throws Exception {
        File d = dir(ctx, id);
        JSONObject out = new JSONObject();
        out.put("meta", readMeta(d));
        JSONArray events = new JSONArray();
        File ef = new File(d, "events.jsonl");
        if (ef.exists()) {
            try (BufferedReader br = new BufferedReader(new FileReader(ef))) {
                String line;
                while ((line = br.readLine()) != null) {
                    line = line.trim();
                    if (line.isEmpty()) continue;
                    try { events.put(new JSONObject(line)); } catch (JSONException ignored) { }
                }
            }
        }
        out.put("events", events);
        File sf = new File(d, "segments.json");
        out.put("segments", sf.exists() ? new JSONObject(new String(readAll(sf), StandardCharsets.UTF_8)) : JSONObject.NULL);
        File gf = new File(d, "graph.bin");
        byte[] g = gf.exists() ? readAll(gf) : new byte[0];
        out.put("graph", Base64.encodeToString(g, Base64.NO_WRAP));
        return out;
    }

    /**
     * 一晩分の音声から、指定した時間帯だけを切り出して残す。
     * @param ranges [{start, end}]（秒）  @param info 解析の条件（感度など。segments.json にそのまま残す）
     */
    static synchronized JSONObject trim(Context ctx, String id, JSONArray ranges, JSONObject info) throws Exception {
        File d = dir(ctx, id);
        JSONObject meta = readMeta(d);
        File clips = new File(d, "clips");
        File full = new File(clips, "full.aac");
        JSONObject out = new JSONObject();
        out.put("info", info == null ? new JSONObject() : info);
        if (!full.exists()) {
            out.put("segments", new JSONArray());
            return out;
        }
        JSONArray segs = AudioTrimmer.trim(full, clips, ranges, RecorderService.SAMPLE_RATE);
        out.put("segments", segs);
        File tmp = new File(d, "segments.json.tmp");
        try (FileOutputStream fo = new FileOutputStream(tmp)) {
            fo.write(out.toString().getBytes(StandardCharsets.UTF_8));
        }
        if (!tmp.renameTo(new File(d, "segments.json"))) throw new IOException("rename failed");
        full.delete();
        meta.put("audio", "segments");
        meta.put("eventCount", segs.length());
        writeMeta(d, meta);
        log(ctx, "trim " + id + ": " + segs.length() + " segments");
        return out;
    }

    static void deleteAll(Context ctx, String activeId) {
        log(ctx, "deleteAll by user");
        File[] dirs = root(ctx).listFiles();
        if (dirs == null) return;
        for (File d : dirs) {
            if (!d.getName().equals(activeId)) deleteRecursive(d);
        }
    }

    // ---------------------------------------------------------------- 診断

    /** 保存処理の記録（削除の理由を後から確認するため） */
    static synchronized void log(Context ctx, String msg) {
        File f = new File(ctx.getFilesDir(), "sessions-log.txt");
        if (f.length() > 200 * 1024) f.delete();
        String line = new java.text.SimpleDateFormat("MM/dd HH:mm:ss", java.util.Locale.US)
                .format(new java.util.Date()) + " " + msg + "\n";
        try (FileOutputStream fo = new FileOutputStream(f, true)) {
            fo.write(line.getBytes(StandardCharsets.UTF_8));
        } catch (IOException ignored) { }
    }

    static JSONObject diagnostics(Context ctx) throws JSONException {
        JSONObject out = new JSONObject();
        JSONArray dirs = new JSONArray();
        File[] list = root(ctx).listFiles();
        if (list != null) {
            for (File d : list) {
                JSONObject o = new JSONObject();
                o.put("id", d.getName());
                try {
                    JSONObject m = readMeta(d);
                    o.put("finished", !m.isNull("endedAt"));
                    o.put("hasAudio", m.optBoolean("hasAudio"));
                } catch (Exception e) {
                    o.put("error", "meta unreadable");
                }
                o.put("durationSec", graphSeconds(d));
                File[] clips = new File(d, "clips").listFiles();
                o.put("clips", clips == null ? 0 : clips.length);
                dirs.put(o);
            }
        }
        out.put("dirs", dirs);
        File lf = new File(ctx.getFilesDir(), "sessions-log.txt");
        String text = "";
        try { if (lf.exists()) text = new String(readAll(lf), StandardCharsets.UTF_8); } catch (IOException ignored) { }
        String[] lines = text.split("\n");
        StringBuilder tail = new StringBuilder();
        for (int i = Math.max(0, lines.length - 80); i < lines.length; i++) tail.append(lines[i]).append('\n');
        out.put("log", tail.toString());
        return out;
    }

    // ---------------------------------------------------------------- ユーティリティ

    static int graphSeconds(File d) {
        File g = new File(d, "graph.bin");
        return g.exists() ? (int) (g.length() / 2) : 0;
    }

    static double round1(double v) { return Math.round(v * 10) / 10.0; }

    static JSONObject readMeta(File d) throws Exception {
        return new JSONObject(new String(readAll(new File(d, "meta.json")), StandardCharsets.UTF_8));
    }

    static void writeMeta(File d, JSONObject meta) throws IOException {
        File tmp = new File(d, "meta.json.tmp");
        try (FileOutputStream fo = new FileOutputStream(tmp)) {
            fo.write(meta.toString().getBytes(StandardCharsets.UTF_8));
            fo.getFD().sync();
        }
        if (!tmp.renameTo(new File(d, "meta.json"))) throw new IOException("rename failed");
    }

    static byte[] readAll(File f) throws IOException {
        try (InputStream in = new FileInputStream(f)) {
            byte[] b = new byte[(int) f.length()];
            int off = 0;
            while (off < b.length) {
                int n = in.read(b, off, b.length - off);
                if (n < 0) break;
                off += n;
            }
            return b;
        }
    }

    static int countLines(File f) {
        if (!f.exists()) return 0;
        int n = 0;
        try (BufferedReader br = new BufferedReader(new FileReader(f))) {
            String line;
            while ((line = br.readLine()) != null) if (!line.trim().isEmpty()) n++;
        } catch (IOException ignored) { }
        return n;
    }

    static void deleteRecursive(File f) {
        if (f == null || !f.exists()) return;
        File[] children = f.listFiles();
        if (children != null) for (File c : children) deleteRecursive(c);
        f.delete();
    }
}
