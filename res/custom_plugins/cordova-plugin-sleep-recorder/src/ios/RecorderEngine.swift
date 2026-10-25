import AVFoundation
import AudioToolbox

/// 録音エンジン（v0.4.0）
/// 一晩すべてを録音し（clips/full.aac）、1秒ごとの音量をグラフ用に保存する。
/// 「大きな音が続いた時間帯」の判定と切り出しは記録の後に行う（JS の解析 → trimAudio）。
/// UIBackgroundModes=audio により、画面ロック中も動作し続ける。JS（WebView）には依存しない。
final class RecorderEngine {
    static let shared = RecorderEngine()

    static let sampleRate = 16000
    static let framesPerSec = 10
    static let frameSamples = sampleRate / framesPerSec            // 100ms
    static let checkpointFrames = 30 * framesPerSec                // 30秒ごと
    static let maxRecordingMs: Int64 = 12 * 60 * 60 * 1000         // 安全上限12時間

    var onStatus: (([String: Any]) -> Void)?
    var onStopped: (([String: Any]) -> Void)?

    private(set) var isRecording = false
    private(set) var sessionId: String?
    private(set) var startedAt: Int64 = 0
    private(set) var endAt: Int64 = 0

    private let engine = AVAudioEngine()
    private let queue = DispatchQueue(label: "sleeprecorder.process")
    private let outFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                          sampleRate: Double(RecorderEngine.sampleRate),
                                          channels: 1, interleaved: false)!
    private var converter: AVAudioConverter?

    private var session: SessionStore.Active!
    private var audio: AdtsFileWriter?
    private var frameBuf: [Float] = []
    private var frames = 0
    private var secMax = -Double.infinity
    private var graphBuf: [Int16] = []
    private var maxDb = -Double.infinity
    private var framesSinceCheckpoint = 0
    private var stopping = false
    private var observers: [NSObjectProtocol] = []

    // ------------------------------------------------------------------ 開始・停止

    func start(endAt: Int64, sensitivity: String) throws {
        if isRecording { throw RecorderError.message("すでに記録中です") }

        let av = AVAudioSession.sharedInstance()
        try av.setCategory(.playAndRecord, mode: .measurement,
                           options: [.mixWithOthers, .defaultToSpeaker, .allowBluetooth])
        try av.setActive(true)

        SessionStore.recover(activeId: nil)
        let now = SessionStore.nowMs()
        let s = try SessionStore.Active(startedAt: now, plannedEndAt: endAt, sensitivity: sensitivity)

        let input = engine.inputNode
        let inFormat = input.outputFormat(forBus: 0)
        guard inFormat.sampleRate > 0, let conv = AVAudioConverter(from: inFormat, to: outFormat) else {
            try? FileManager.default.removeItem(at: s.dir)
            throw RecorderError.message("マイクを開始できませんでした")
        }

        var writer: AdtsFileWriter?
        do {
            writer = try AdtsFileWriter(url: s.fullAudioURL, sampleRate: RecorderEngine.sampleRate)
        } catch {
            SessionStore.log("audio writer failed: \(error)") // 音声なしでもグラフは記録する
        }

        queue.sync {
            self.session = s
            self.audio = writer
            self.frameBuf = []
            self.frames = 0
            self.secMax = -Double.infinity
            self.graphBuf = []
            self.maxDb = -Double.infinity
            self.framesSinceCheckpoint = 0
            self.stopping = false
            self.converter = conv
            self.sessionId = s.id
            self.startedAt = now
            self.endAt = endAt
            self.isRecording = true
        }

        input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { [weak self] buf, _ in
            self?.handle(buf)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            queue.sync {
                self.isRecording = false
                self.audio?.close()
                self.audio = nil
            }
            try? FileManager.default.removeItem(at: s.dir)
            throw RecorderError.message("マイクを開始できませんでした")
        }
        addObservers()
    }

    func stop(reason: String) {
        queue.async { self.stopInternal(reason: reason) }
    }

    private func stopInternal(reason: String) {
        guard isRecording, !stopping else { return }
        stopping = true

        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        DispatchQueue.main.async { self.removeObservers() }

        audio?.close()
        audio = nil
        checkpoint()

        let id = session.id
        let saved = SessionStore.finish(id: id, reason: reason, endedAt: SessionStore.nowMs())
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)

        isRecording = false
        stopping = false
        sessionId = nil
        let result: [String: Any] = ["type": "stopped", "sessionId": id, "reason": reason, "saved": saved]
        DispatchQueue.main.async { self.onStopped?(result) }
    }

    // ------------------------------------------------------------------ 音声処理

    /// オーディオスレッド: 16kHz モノラルに変換して処理キューへ渡す
    private func handle(_ buf: AVAudioPCMBuffer) {
        guard let conv = converter else { return }
        let ratio = Double(RecorderEngine.sampleRate) / buf.format.sampleRate
        let cap = AVAudioFrameCount(Double(buf.frameLength) * ratio + 32)
        guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: cap) else { return }
        var supplied = false
        var error: NSError?
        conv.convert(to: out, error: &error) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true
            status.pointee = .haveData
            return buf
        }
        guard error == nil, let ch = out.floatChannelData else { return }
        let samples = Array(UnsafeBufferPointer(start: ch[0], count: Int(out.frameLength)))
        queue.async { self.process(samples) }
    }

    private func process(_ samples: [Float]) {
        guard isRecording, !stopping else { return }

        // 一晩分の音声として書き続ける
        if let w = audio {
            do { try w.write(samples) } catch {
                SessionStore.log("audio write failed: \(error)")
                w.close()
                audio = nil
            }
        }

        frameBuf.append(contentsOf: samples)
        let n = RecorderEngine.frameSamples
        while frameBuf.count >= n {
            let db = RecorderEngine.rmsDb(frameBuf[0..<n])
            frameBuf.removeFirst(n)
            frames += 1

            // 1秒値 = 100msごとの音量の最大値
            if db > secMax { secMax = db }
            if frames % RecorderEngine.framesPerSec == 0 {
                graphBuf.append(Int16(max(-1000, min(0, (secMax * 10).rounded()))))
                if secMax > maxDb { maxDb = secMax }
                pushStatus(levelDb: secMax)
                secMax = -Double.infinity
            }

            framesSinceCheckpoint += 1
            if framesSinceCheckpoint >= RecorderEngine.checkpointFrames {
                checkpoint()
                framesSinceCheckpoint = 0
            }

            let now = SessionStore.nowMs()
            if endAt > 0 && now >= endAt { stopInternal(reason: "auto"); return }
            if now - startedAt >= RecorderEngine.maxRecordingMs { stopInternal(reason: "limit"); return }
        }
    }

    static func rmsDb(_ s: ArraySlice<Float>) -> Double {
        var sum: Double = 0
        for v in s { sum += Double(v) * Double(v) }
        let rms = (sum / Double(max(1, s.count))).squareRoot()
        let db = rms > 0 ? 20 * log10(rms) : -100
        return max(-100, min(0, db))
    }

    private func checkpoint() {
        do {
            try session.appendGraph(graphBuf)
            graphBuf.removeAll(keepingCapacity: true)
            try session.checkpoint(maxDb: maxDb)
        } catch {
            NSLog("[SleepRecorder] checkpoint failed: \(error)")
        }
    }

    // ------------------------------------------------------------------ 通知・中断

    private func pushStatus(levelDb: Double) {
        let s: [String: Any] = [
            "type": "status",
            "sessionId": sessionId ?? "",
            "startedAt": startedAt,
            "elapsedSec": frames / RecorderEngine.framesPerSec,
            "levelDb": SessionStore.round1(levelDb),
            "endAt": endAt,
        ]
        DispatchQueue.main.async { self.onStatus?(s) }
    }

    private func addObservers() {
        let nc = NotificationCenter.default
        let av = AVAudioSession.sharedInstance()
        observers.append(nc.addObserver(forName: AVAudioSession.interruptionNotification, object: av, queue: nil) { [weak self] n in
            guard let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
            self?.stop(reason: "interrupted") // 初回バージョンは再開しない
        })
        observers.append(nc.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
            self?.stop(reason: "interrupted")
        })
        observers.append(nc.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: av, queue: nil) { [weak self] _ in
            self?.stop(reason: "interrupted")
        })
    }

    private func removeObservers() {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers.removeAll()
    }
}

/// 16kHz モノラル Float の PCM を AAC-LC に変換し、ADTS 形式（.aac）で書き続ける。
/// ADTS はフレームごとにヘッダーを持つため、途中でアプリが終了しても書き込み済みの部分は再生でき、
/// フレーム単位で切り出すだけで一部を取り出せる（AudioTrimmer）。
/// 音量: 一定倍率（gainDb）で増幅し、大きすぎる部分は tanh で自然に頭打ちにする。
final class AdtsFileWriter {
    static let gainDb: Float = 30
    static let bitRate: UInt32 = 24000

    private var file: ExtAudioFileRef?
    private let gain = powf(10, AdtsFileWriter.gainDb / 20)

    init(url: URL, sampleRate: Int) throws {
        var dst = AudioStreamBasicDescription(
            mSampleRate: Float64(sampleRate), mFormatID: kAudioFormatMPEG4AAC, mFormatFlags: 0,
            mBytesPerPacket: 0, mFramesPerPacket: 1024, mBytesPerFrame: 0,
            mChannelsPerFrame: 1, mBitsPerChannel: 0, mReserved: 0)
        var ref: ExtAudioFileRef?
        var st = ExtAudioFileCreateWithURL(url as CFURL, kAudioFileAAC_ADTSType, &dst, nil,
                                           AudioFileFlags.eraseFile.rawValue, &ref)
        guard st == noErr, let f = ref else { throw RecorderError.message("音声ファイルを作成できませんでした (\(st))") }
        file = f

        var client = AudioStreamBasicDescription(
            mSampleRate: Float64(sampleRate), mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4,
            mChannelsPerFrame: 1, mBitsPerChannel: 32, mReserved: 0)
        st = ExtAudioFileSetProperty(f, kExtAudioFileProperty_ClientDataFormat,
                                     UInt32(MemoryLayout<AudioStreamBasicDescription>.size), &client)
        guard st == noErr else {
            close()
            throw RecorderError.message("音声の形式を設定できませんでした (\(st))")
        }

        // ビットレート（設定できなくても既定値で続ける）
        var conv: AudioConverterRef?
        var size = UInt32(MemoryLayout<AudioConverterRef?>.size)
        if ExtAudioFileGetProperty(f, kExtAudioFileProperty_AudioConverter, &size, &conv) == noErr, let c = conv {
            var br = AdtsFileWriter.bitRate
            if AudioConverterSetProperty(c, kAudioConverterEncodeBitRate, UInt32(MemoryLayout<UInt32>.size), &br) == noErr {
                var cfg: CFArray? = nil
                _ = ExtAudioFileSetProperty(f, kExtAudioFileProperty_ConverterConfig,
                                            UInt32(MemoryLayout<CFArray?>.size), &cfg)
            }
        }
    }

    func write(_ samples: [Float]) throws {
        guard let f = file, !samples.isEmpty else { return }
        var data = samples.map { tanhf($0 * gain) }
        let st: OSStatus = data.withUnsafeMutableBytes { raw -> OSStatus in
            var abl = AudioBufferList(
                mNumberBuffers: 1,
                mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(raw.count), mData: raw.baseAddress))
            return ExtAudioFileWrite(f, UInt32(samples.count), &abl)
        }
        if st != noErr { throw RecorderError.message("音声を書き込めませんでした (\(st))") }
    }

    func close() {
        if let f = file { ExtAudioFileDispose(f) }
        file = nil
    }

    deinit { close() }
}

enum RecorderError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self { case .message(let m): return m }
    }
}
