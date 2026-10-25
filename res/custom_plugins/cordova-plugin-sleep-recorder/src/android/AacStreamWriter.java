package com.sleepsound.recorder;

import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.MediaMuxer;

import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;

/**
 * 16bit モノラル PCM を、届いた順に AAC-LC (.m4a) へ書き出す。
 * イベントが続くあいだ書き続けるため、録音の長さに上限はない。
 *
 * 音量: しきい値付近の音が聞き取りやすい大きさになるよう一定倍率で増幅し、
 * 大きすぎる部分は tanh で自然に頭打ちにする（割れた音にしない）。
 */
final class AacStreamWriter {
    static final int BIT_RATE = 24000;
    static final double TARGET_DB = -26;   // しきい値の音をこの大きさにする
    static final double MAX_GAIN_DB = 50;

    final File file;
    private final int sampleRate;
    private final double gain;
    private final MediaCodec codec;
    private final MediaMuxer muxer;
    private final MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
    private int track = -1;
    private boolean muxStarted = false;
    private long samples = 0;
    private boolean closed = false;

    /** しきい値（dBFS）から増幅率を決める */
    static double gainFor(double thrDb) {
        double g = Math.max(0, Math.min(MAX_GAIN_DB, TARGET_DB - thrDb));
        return Math.pow(10, g / 20);
    }

    AacStreamWriter(File out, int sampleRate, double gain) throws IOException {
        this.file = out;
        this.sampleRate = sampleRate;
        this.gain = gain;
        MediaFormat fmt = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, sampleRate, 1);
        fmt.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
        fmt.setInteger(MediaFormat.KEY_BIT_RATE, BIT_RATE);
        fmt.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384);
        codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
        try {
            codec.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            codec.start();
            muxer = new MediaMuxer(out.getAbsolutePath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
        } catch (IOException | RuntimeException e) {
            codec.release();
            throw e;
        }
    }

    void write(short[] pcm) {
        if (closed || pcm.length == 0) return;
        byte[] b = new byte[pcm.length * 2];
        for (int i = 0; i < pcm.length; i++) {
            int v = (int) Math.round(32767 * Math.tanh(pcm[i] / 32768.0 * gain));
            b[i * 2] = (byte) (v & 0xff);
            b[i * 2 + 1] = (byte) ((v >> 8) & 0xff);
        }
        int pos = 0;
        int spins = 0;
        while (pos < b.length) {
            int idx = codec.dequeueInputBuffer(10000);
            if (idx < 0) {
                drain(false);
                if (++spins > 200) throw new IllegalStateException("encoder stalled");
                continue;
            }
            ByteBuffer in = codec.getInputBuffer(idx);
            in.clear();
            int n = Math.min(in.remaining(), b.length - pos) & ~1;
            in.put(b, pos, n);
            codec.queueInputBuffer(idx, 0, n, samples * 1_000_000L / sampleRate, 0);
            samples += n / 2;
            pos += n;
            drain(false);
        }
    }

    /** 書き終えてファイルを閉じる */
    void finish() {
        if (closed) return;
        try {
            for (int i = 0; i < 200; i++) {
                int idx = codec.dequeueInputBuffer(10000);
                if (idx >= 0) {
                    codec.queueInputBuffer(idx, 0, 0, samples * 1_000_000L / sampleRate, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                    break;
                }
                drain(false);
            }
            drain(true);
        } finally {
            release();
        }
    }

    /** 書きかけを捨てる */
    void abort() {
        release();
        file.delete();
    }

    private void drain(boolean untilEos) {
        int idle = 0;
        while (true) {
            int o = codec.dequeueOutputBuffer(info, untilEos ? 10000 : 0);
            if (o == MediaCodec.INFO_TRY_AGAIN_LATER) {
                if (!untilEos || ++idle > 300) return;
                continue;
            }
            if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                track = muxer.addTrack(codec.getOutputFormat());
                muxer.start();
                muxStarted = true;
                continue;
            }
            if (o < 0) continue;
            ByteBuffer ob = codec.getOutputBuffer(o);
            if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) info.size = 0;
            if (info.size > 0 && muxStarted && ob != null) {
                ob.position(info.offset);
                ob.limit(info.offset + info.size);
                muxer.writeSampleData(track, ob, info);
            }
            codec.releaseOutputBuffer(o, false);
            if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) return;
        }
    }

    private void release() {
        if (closed) return;
        closed = true;
        try { codec.stop(); } catch (Exception ignored) { }
        codec.release();
        try { if (muxStarted) muxer.stop(); } catch (Exception ignored) { }
        muxer.release();
    }
}
