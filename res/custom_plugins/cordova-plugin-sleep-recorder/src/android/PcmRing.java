package com.sleepsound.recorder;

/**
 * 直近 capacity サンプルの PCM(16bit) を保持するリングバッファ。
 * サンプル位置はセッション開始からの通し番号で扱う。
 */
final class PcmRing {
    private final short[] data;
    private long total = 0; // これまでに書き込んだ総サンプル数

    PcmRing(int capacity) { data = new short[capacity]; }

    void write(short[] src, int len) {
        for (int i = 0; i < len; i++) {
            data[(int) (total % data.length)] = src[i];
            total++;
        }
    }

    long total() { return total; }

    /** [from, to) を取り出す。バッファから外れた範囲は切り詰める。 */
    short[] extract(long from, long to) {
        long oldest = Math.max(0, total - data.length);
        from = Math.max(from, oldest);
        to = Math.min(to, total);
        if (to <= from) return new short[0];
        short[] out = new short[(int) (to - from)];
        for (long p = from; p < to; p++) {
            out[(int) (p - from)] = data[(int) (p % data.length)];
        }
        return out;
    }
}
