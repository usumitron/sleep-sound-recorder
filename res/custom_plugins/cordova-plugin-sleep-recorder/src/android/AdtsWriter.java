package com.sleepsound.recorder;

import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;

/**
 * 16bit モノラル PCM を AAC-LC に変換し、ADTS 形式（.aac）で書き続ける。
 * ADTS はフレームごとにヘッダーを持つため、
 * - 途中でアプリが終了しても、書き込み済みの部分はそのまま再生できる
 * - フレーム単位で切り出すだけで、再変換せずに一部を取り出せる（AudioTrimmer）
 *
 * 音量: 一定倍率（GAIN_DB）で増幅し、大きすぎる部分は tanh で自然に頭打ちにする。
 */
final class AdtsWriter {
    static final int BIT_RATE = 24000;
    static final double GAIN_DB = 30;

    private final int sampleRate;
    private final double gain = Math.pow(10, GAIN_DB / 20);
    private final MediaCodec codec;
    private final BufferedOutputStream out;
    private final MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
    private final byte[] header = new byte[7];
    private long samples = 0;
    private boolean closed = false;

    AdtsWriter(File file, int sampleRate) throws IOException {
        this.sampleRate = sampleRate;
        MediaFormat fmt = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, sampleRate, 1);
        fmt.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
        fmt.setInteger(MediaFormat.KEY_BIT_RATE, BIT_RATE);
        fmt.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384);
        codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
        try {
            codec.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            codec.start();
            out = new BufferedOutputStream(new FileOutputStream(file), 64 * 1024);
        } catch (IOException | RuntimeException e) {
            codec.release();
            throw e;
        }
    }

    void write(short[] pcm, int len) throws IOException {
        if (closed || len <= 0) return;
        byte[] b = new byte[len * 2];
        for (int i = 0; i < len; i++) {
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
                if (++spins > 200) throw new IOException("encoder stalled");
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

    /** バッファをファイルへ書き出す（定期保存用） */
    void flush() throws IOException {
        if (!closed) out.flush();
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
        } catch (Exception ignored) {
        } finally {
            closed = true;
            try { codec.stop(); } catch (Exception ignored) { }
            codec.release();
            try { out.close(); } catch (IOException ignored) { }
        }
    }

    private void drain(boolean untilEos) throws IOException {
        int idle = 0;
        while (true) {
            int o = codec.dequeueOutputBuffer(info, untilEos ? 10000 : 0);
            if (o == MediaCodec.INFO_TRY_AGAIN_LATER) {
                if (!untilEos || ++idle > 300) return;
                continue;
            }
            if (o < 0) continue; // フォーマット変更などは ADTS では不要
            ByteBuffer ob = codec.getOutputBuffer(o);
            boolean config = (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0;
            if (!config && info.size > 0 && ob != null) {
                byte[] frame = new byte[info.size];
                ob.position(info.offset);
                ob.get(frame, 0, info.size);
                writeHeader(info.size + 7);
                out.write(header);
                out.write(frame);
            }
            codec.releaseOutputBuffer(o, false);
            if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) return;
        }
    }

    /** ADTS ヘッダー（AAC-LC, 16kHz=index 8, モノラル） */
    private void writeHeader(int packetLen) {
        final int profile = 2;      // AAC LC
        final int freqIdx = 8;      // 16000 Hz
        final int chanCfg = 1;      // モノラル
        header[0] = (byte) 0xFF;
        header[1] = (byte) 0xF1;
        header[2] = (byte) (((profile - 1) << 6) | (freqIdx << 2) | (chanCfg >> 2));
        header[3] = (byte) (((chanCfg & 3) << 6) | (packetLen >> 11));
        header[4] = (byte) ((packetLen & 0x7FF) >> 3);
        header[5] = (byte) (((packetLen & 7) << 5) | 0x1F);
        header[6] = (byte) 0xFC;
    }
}
