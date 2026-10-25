package com.sleepsound.recorder;

import java.util.ArrayDeque;
import java.util.Arrays;

/**
 * 検知アルゴリズム（tools/detector.js と同一ロジック, v0.3.0）。
 * 1フレーム = 100ms。時刻はセッション開始からのフレーム番号。
 * 基準値 = 直近5分の1秒値の下位10%。しきい値 = 基準値 + 感度。
 */
final class Detector {
    static final int FRAMES_PER_SEC = 10;
    static final int CALIB_FRAMES = 60 * FRAMES_PER_SEC;
    static final int BASELINE_SECONDS = 300;
    static final double BASELINE_PERCENTILE = 0.10;
    static final int MIN_ABOVE_FRAMES = 2 * FRAMES_PER_SEC;
    static final int GAP_FRAMES = 5 * FRAMES_PER_SEC;
    static final int ALGO_VERSION = 2;

    static double offsetFor(String sensitivity) {
        if ("low".equals(sensitivity)) return 14;
        if ("high".equals(sensitivity)) return 7;
        return 10;
    }

    static final class Event {
        long startFrame, endFrame, peakFrame;
        double peakDb, thrDb;
    }

    static final class Result {
        boolean hasSecond;
        double second;
        boolean opened;      // このフレームでイベントが始まった
        long openedFrame;
        double openedThrDb;
        Event closed;        // 成立したイベント
        boolean discarded;   // 始まったイベントが不成立で終わった
    }

    private final double offset;
    private long frame = 0;
    private double secMax = Double.NEGATIVE_INFINITY;
    private int secCount = 0;
    private final ArrayDeque<Double> buf = new ArrayDeque<>();
    private double baseline = Double.NaN;

    private boolean inEvent = false;
    private long evStart, lastAbove, peakFrame;
    private int above;
    private double peakDb, evThr;

    Detector(double offsetDb) { this.offset = offsetDb; }

    Result processFrame(double db) {
        Result r = new Result();
        long f = frame++;

        if (f >= CALIB_FRAMES && !Double.isNaN(baseline)) {
            double thr = baseline + offset;
            if (!inEvent) {
                if (db > thr) {
                    inEvent = true;
                    evStart = f; lastAbove = f; above = 1;
                    peakDb = db; peakFrame = f; evThr = thr;
                    r.opened = true; r.openedFrame = f; r.openedThrDb = thr;
                }
            } else {
                // しきい値はイベント中も更新する（持続音なら基準値が追従してイベントが終わる）
                if (db > thr) {
                    above++;
                    lastAbove = f;
                    if (db > peakDb) { peakDb = db; peakFrame = f; }
                }
                if (f - lastAbove >= GAP_FRAMES) {
                    r.closed = close(lastAbove + 1);
                    r.discarded = r.closed == null;
                }
            }
        }

        if (db > secMax) secMax = db;
        if (++secCount == FRAMES_PER_SEC) {
            r.hasSecond = true;
            r.second = secMax;
            buf.addLast(secMax);
            if (buf.size() > BASELINE_SECONDS) buf.removeFirst();
            double[] s = new double[buf.size()];
            int i = 0;
            for (Double v : buf) s[i++] = v;
            Arrays.sort(s);
            baseline = s[Math.min(s.length - 1, (int) Math.floor(s.length * BASELINE_PERCENTILE))];
            secMax = Double.NEGATIVE_INFINITY;
            secCount = 0;
        }
        return r;
    }

    boolean inEvent() { return inEvent; }

    /** 記録終了時に、進行中のイベントを閉じる。成立しなければ null */
    Event finish() {
        if (!inEvent) return null;
        return close(Math.min(lastAbove + 1, frame));
    }

    long currentFrame() { return frame; }

    private Event close(long endFrame) {
        inEvent = false;
        if (above < MIN_ABOVE_FRAMES) return null;
        Event e = new Event();
        e.startFrame = evStart;
        e.endFrame = endFrame;
        e.peakDb = peakDb;
        e.peakFrame = peakFrame;
        e.thrDb = evThr;
        return e;
    }
}
