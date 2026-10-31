package com.sleepsound.recorder;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * 一晩分の ADTS ファイルから、指定した時間帯だけを切り出す（再変換なし）。
 * ADTS はフレーム（1024サンプル = 16kHz で64ms）ごとに独立しているため、
 * 必要なフレームをそのままコピーすれば再生できるファイルになる。
 */
final class AudioTrimmer {

    /**
     * @param ranges [{start, end}]（秒, 昇順・重なりなし）
     * @return [{start, end, clip}]（音声を書き出せた範囲のみ）
     */
    static JSONArray trim(File full, File outDir, JSONArray ranges, int sampleRate) throws IOException, JSONException {
        return trim(full, outDir, ranges, sampleRate, null);
    }

    /** @param fileNames 書き出すファイル名（null なら seg_0001.aac 〜） */
    static JSONArray trim(File full, File outDir, JSONArray ranges, int sampleRate, String[] fileNames) throws IOException, JSONException {
        int n = ranges.length();
        double[] st = new double[n], en = new double[n];
        String[] names = new String[n];
        for (int i = 0; i < n; i++) {
            st[i] = ranges.getJSONObject(i).getDouble("start");
            en[i] = ranges.getJSONObject(i).getDouble("end");
            names[i] = fileNames != null ? fileNames[i] : String.format(java.util.Locale.US, "seg_%04d.aac", i + 1);
        }
        boolean[] written = new boolean[n];

        byte[] hdr = new byte[7];
        long pos = 0;   // サンプル位置
        int ri = 0;
        OutputStream cur = null;
        try (InputStream in = new BufferedInputStream(new FileInputStream(full), 64 * 1024)) {
            while (ri < n) {
                if (!readFully(in, hdr, 7)) break;
                if ((hdr[0] & 0xFF) != 0xFF || (hdr[1] & 0xF0) != 0xF0) break; // 壊れた末尾
                int len = ((hdr[3] & 0x03) << 11) | ((hdr[4] & 0xFF) << 3) | ((hdr[5] & 0xE0) >> 5);
                if (len < 7) break;
                byte[] body = new byte[len - 7];
                if (!readFully(in, body, body.length)) break;
                int blocks = (hdr[6] & 0x03) + 1;
                double t = pos / (double) sampleRate;
                pos += 1024L * blocks;

                while (ri < n && t >= en[ri]) {
                    if (cur != null) { cur.close(); cur = null; }
                    ri++;
                }
                if (ri < n && t >= st[ri]) {
                    if (cur == null) {
                        cur = new BufferedOutputStream(new FileOutputStream(new File(outDir, names[ri])), 64 * 1024);
                        written[ri] = true;
                    }
                    cur.write(hdr);
                    cur.write(body);
                }
            }
        } finally {
            if (cur != null) cur.close();
        }

        JSONArray result = new JSONArray();
        for (int i = 0; i < n; i++) {
            if (!written[i]) continue;
            JSONObject o = new JSONObject();
            o.put("start", st[i]);
            o.put("end", en[i]);
            o.put("clip", names[i]);
            result.put(o);
        }
        return result;
    }

    private static boolean readFully(InputStream in, byte[] b, int len) throws IOException {
        int off = 0;
        while (off < len) {
            int r = in.read(b, off, len - off);
            if (r < 0) return false;
            off += r;
        }
        return true;
    }
}
