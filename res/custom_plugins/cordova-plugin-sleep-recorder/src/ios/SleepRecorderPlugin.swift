import AVFoundation
import UIKit

@objc(SleepRecorderPlugin)
class SleepRecorderPlugin: CDVPlugin {
    private var eventCallbackId: String?
    private var player: AVPlayer?
    private var rate: Float = 1
    private var ended = false
    private var endObserver: NSObjectProtocol?

    override func pluginInitialize() {
        super.pluginInitialize()
        let engine = RecorderEngine.shared
        engine.onStatus = { [weak self] s in self?.sendEvent(s) }
        engine.onStopped = { [weak self] s in self?.sendEvent(s) }
    }

    // ------------------------------------------------------------------ 記録

    @objc(start:)
    func start(_ command: CDVInvokedUrlCommand) {
        let opts = command.argument(at: 0) as? [String: Any] ?? [:]
        let endAt = (opts["endAt"] as? NSNumber)?.int64Value ?? 0
        let sensitivity = opts["sensitivity"] as? String ?? "mid"

        guard AVAudioSession.sharedInstance().recordPermission == .granted else {
            fail(command, "マイクの使用が許可されていません")
            return
        }
        stopClipInternal()
        eventCallbackId = command.callbackId
        do {
            try RecorderEngine.shared.start(endAt: endAt, sensitivity: sensitivity)
            let r = CDVPluginResult(status: CDVCommandStatus_NO_RESULT)
            keepCallback(r)
            commandDelegate.send(r, callbackId: command.callbackId)
        } catch {
            eventCallbackId = nil
            fail(command, error.localizedDescription)
        }
    }

    @objc(attach:)
    func attach(_ command: CDVInvokedUrlCommand) {
        eventCallbackId = command.callbackId
        let r = CDVPluginResult(status: CDVCommandStatus_NO_RESULT)
        keepCallback(r)
        commandDelegate.send(r, callbackId: command.callbackId)
    }

    @objc(stop:)
    func stop(_ command: CDVInvokedUrlCommand) {
        RecorderEngine.shared.stop(reason: "manual")
        ok(command)
    }

    @objc(getState:)
    func getState(_ command: CDVInvokedUrlCommand) {
        let e = RecorderEngine.shared
        ok(command, [
            "recording": e.isRecording,
            "sessionId": e.sessionId ?? NSNull(),
            "startedAt": e.isRecording ? e.startedAt : 0,
            "endAt": e.isRecording ? e.endAt : 0,
        ])
    }

    private func sendEvent(_ obj: [String: Any]) {
        guard let id = eventCallbackId else { return }
        let r = CDVPluginResult(status: CDVCommandStatus_OK, messageAs: obj)
        keepCallback(r)
        commandDelegate.send(r, callbackId: id)
    }

    // ------------------------------------------------------------------ データ

    @objc(recover:)
    func recover(_ command: CDVInvokedUrlCommand) {
        commandDelegate.run(inBackground: {
            SessionStore.recover(activeId: RecorderEngine.shared.sessionId)
            SessionStore.applyRetention()
            self.ok(command)
        })
    }

    @objc(listSessions:)
    func listSessions(_ command: CDVInvokedUrlCommand) {
        commandDelegate.run(inBackground: {
            let r = CDVPluginResult(status: CDVCommandStatus_OK, messageAs: SessionStore.finishedMetas())
            self.commandDelegate.send(r, callbackId: command.callbackId)
        })
    }

    @objc(getSession:)
    func getSession(_ command: CDVInvokedUrlCommand) {
        let id = command.argument(at: 0) as? String ?? ""
        commandDelegate.run(inBackground: {
            if let s = SessionStore.get(id) { self.ok(command, s) }
            else { self.fail(command, "セッションを読み込めませんでした") }
        })
    }

    @objc(trimAudio:)
    func trimAudio(_ command: CDVInvokedUrlCommand) {
        let id = command.argument(at: 0) as? String ?? ""
        let list = command.argument(at: 1) as? [[String: Any]] ?? []
        let info = command.argument(at: 2) as? [String: Any] ?? [:]
        let ranges: [(Double, Double)] = list.compactMap {
            guard let a = ($0["start"] as? NSNumber)?.doubleValue, let b = ($0["end"] as? NSNumber)?.doubleValue else { return nil }
            return (a, b)
        }
        commandDelegate.run(inBackground: {
            do { self.ok(command, try SessionStore.trim(id: id, ranges: ranges, info: info)) }
            catch { self.fail(command, "音声を切り出せませんでした: \(error.localizedDescription)") }
        })
    }

    @objc(deleteAll:)
    func deleteAll(_ command: CDVInvokedUrlCommand) {
        commandDelegate.run(inBackground: {
            SessionStore.deleteAll(activeId: RecorderEngine.shared.sessionId)
            self.ok(command)
        })
    }

    // ------------------------------------------------------------------ 再生
    // AVPlayer を使う（AVAudioPlayer は2倍速までのため）。位置の変更・一時停止・速度変更に対応

    @objc(playClip:)
    func playClip(_ command: CDVInvokedUrlCommand) {
        let sid = command.argument(at: 0) as? String ?? ""
        let clip = command.argument(at: 1) as? String ?? ""
        let opts = command.argument(at: 2) as? [String: Any] ?? [:]
        stopClipInternal()
        guard !sid.contains("/"), !clip.contains("/") else { fail(command, "不正なファイル名です"); return }
        let url = SessionStore.dir(sid).appendingPathComponent("clips").appendingPathComponent(clip)
        guard FileManager.default.fileExists(atPath: url.path) else {
            fail(command, "この音声は保存されていません")
            return
        }
        if let r = opts["rate"] as? NSNumber { rate = max(0.5, min(3, r.floatValue)) }
        do {
            if !RecorderEngine.shared.isRecording {
                try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
                try AVAudioSession.sharedInstance().setActive(true)
            }
        } catch {
            fail(command, "音声を再生できませんでした")
            return
        }
        let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        let item = AVPlayerItem(asset: asset)
        item.audioTimePitchAlgorithm = .timeDomain // 速度を上げても音の高さを変えない
        let p = AVPlayer(playerItem: item)
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
            self?.ended = true
        }
        player = p
        ended = false
        if let pos = opts["position"] as? NSNumber, pos.doubleValue > 0 {
            p.seek(to: CMTime(seconds: pos.doubleValue, preferredTimescale: 600))
        }
        p.rate = rate
        ok(command, clipState())
    }

    @objc(pauseClip:)
    func pauseClip(_ command: CDVInvokedUrlCommand) {
        player?.pause()
        ok(command, clipState())
    }

    @objc(resumeClip:)
    func resumeClip(_ command: CDVInvokedUrlCommand) {
        if let p = player {
            if ended { p.seek(to: .zero); ended = false }
            p.rate = rate
        }
        ok(command, clipState())
    }

    @objc(seekClip:)
    func seekClip(_ command: CDVInvokedUrlCommand) {
        let sec = (command.argument(at: 0) as? NSNumber)?.doubleValue ?? 0
        guard let p = player else { ok(command, clipState()); return }
        let dur = duration()
        let target = max(0, dur > 0 ? min(dur, sec) : sec)
        ended = dur > 0 && target >= dur
        p.seek(to: CMTime(seconds: target, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { _ in
            DispatchQueue.main.async { self.ok(command, self.clipState()) }
        }
    }

    @objc(setClipRate:)
    func setClipRate(_ command: CDVInvokedUrlCommand) {
        let r = (command.argument(at: 0) as? NSNumber)?.floatValue ?? 1
        rate = max(0.5, min(3, r))
        if let p = player, p.rate != 0 { p.rate = rate }
        ok(command, clipState())
    }

    @objc(getClipState:)
    func getClipState(_ command: CDVInvokedUrlCommand) {
        ok(command, clipState())
    }

    @objc(stopClip:)
    func stopClip(_ command: CDVInvokedUrlCommand) {
        stopClipInternal()
        ok(command)
    }

    private func duration() -> Double {
        guard let d = player?.currentItem?.asset.duration, d.isNumeric else { return 0 }
        return CMTimeGetSeconds(d)
    }

    private func clipState() -> [String: Any] {
        guard let p = player else {
            return ["loaded": false, "playing": false, "position": 0, "duration": 0, "ended": false, "rate": rate]
        }
        let pos = CMTimeGetSeconds(p.currentTime())
        return [
            "loaded": true,
            "playing": p.rate != 0 && !ended,
            "position": pos.isFinite ? pos : 0,
            "duration": duration(),
            "ended": ended,
            "rate": rate,
        ]
    }

    private func stopClipInternal() {
        player?.pause()
        player = nil
        ended = false
        if let o = endObserver { NotificationCenter.default.removeObserver(o) }
        endObserver = nil
    }

    // ------------------------------------------------------------------ 保存（共有シート）

    @objc(saveClip:)
    func saveClip(_ command: CDVInvokedUrlCommand) {
        let sid = command.argument(at: 0) as? String ?? ""
        let clip = command.argument(at: 1) as? String ?? ""
        var name = command.argument(at: 2) as? String ?? clip
        guard !sid.contains("/"), !clip.contains("/") else { fail(command, "不正なファイル名です"); return }
        if name.isEmpty || name.contains("/") { name = clip }
        let src = SessionStore.dir(sid).appendingPathComponent("clips").appendingPathComponent(clip)
        guard FileManager.default.fileExists(atPath: src.path) else { fail(command, "この音声は保存されていません"); return }

        // 分かりやすい名前のコピーを一時フォルダに作って共有する
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        do {
            try? FileManager.default.removeItem(at: tmp)
            try FileManager.default.copyItem(at: src, to: tmp)
        } catch {
            fail(command, "保存の準備ができませんでした")
            return
        }
        DispatchQueue.main.async {
            // cordova-ios のバージョンにより viewController が optional かどうかが異なるため、いったん optional で受ける
            let hostOpt: UIViewController? = self.viewController
            guard let host = hostOpt else { self.fail(command, "保存画面を開けませんでした"); return }
            let vc = UIActivityViewController(activityItems: [tmp], applicationActivities: nil)
            if let pop = vc.popoverPresentationController { // iPad
                pop.sourceView = host.view
                pop.sourceRect = CGRect(x: host.view.bounds.midX, y: host.view.bounds.maxY - 120, width: 1, height: 1)
            }
            vc.completionWithItemsHandler = { _, completed, _, _ in
                try? FileManager.default.removeItem(at: tmp)
                self.ok(command, ["method": "share", "completed": completed])
            }
            host.present(vc, animated: true)
        }
    }

    // ------------------------------------------------------------------ 診断

    @objc(getDiagnostics:)
    func getDiagnostics(_ command: CDVInvokedUrlCommand) {
        commandDelegate.run(inBackground: {
            self.ok(command, SessionStore.diagnostics())
        })
    }

    // ------------------------------------------------------------------ 権限・端末状態

    private func micState() -> String {
        switch AVAudioSession.sharedInstance().recordPermission {
        case .granted: return "granted"
        case .denied: return "denied"
        default: return "undetermined"
        }
    }

    @objc(checkPermissions:)
    func checkPermissions(_ command: CDVInvokedUrlCommand) {
        ok(command, ["mic": micState(), "notification": "notRequired"])
    }

    @objc(requestPermissions:)
    func requestPermissions(_ command: CDVInvokedUrlCommand) {
        AVAudioSession.sharedInstance().requestRecordPermission { _ in
            DispatchQueue.main.async {
                self.ok(command, ["mic": self.micState(), "notification": "notRequired"])
            }
        }
    }

    @objc(getDeviceStatus:)
    func getDeviceStatus(_ command: CDVInvokedUrlCommand) {
        UIDevice.current.isBatteryMonitoringEnabled = true
        let state = UIDevice.current.batteryState
        var freeMB: Int64 = 0
        let home = URL(fileURLWithPath: NSHomeDirectory())
        if let v = try? home.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
           let cap = v.volumeAvailableCapacityForImportantUsage {
            freeMB = cap / (1024 * 1024)
        }
        ok(command, [
            "charging": state == .charging || state == .full,
            "freeMB": freeMB,
            "platform": "ios",
        ])
    }

    @objc(openAppSettings:)
    func openAppSettings(_ command: CDVInvokedUrlCommand) {
        if let url = URL(string: UIApplication.openSettingsURLString) {
            UIApplication.shared.open(url)
        }
        ok(command)
    }

    @objc(openBatterySettings:)
    func openBatterySettings(_ command: CDVInvokedUrlCommand) {
        ok(command) // iOS では不要
    }

    // ------------------------------------------------------------------ 共通

    /// コールバックを使い続ける設定。
    /// cordova-ios 8 以降は CDVPluginResult の生成結果が optional でなくなったため、
    /// optional の引数で受けて、新旧どちらの cordova-ios でもコンパイルできるようにする。
    private func keepCallback(_ r: CDVPluginResult?) {
        r?.setKeepCallbackAs(true)
    }

    private func ok(_ command: CDVInvokedUrlCommand, _ obj: [String: Any]? = nil) {
        let r = obj == nil
            ? CDVPluginResult(status: CDVCommandStatus_OK)
            : CDVPluginResult(status: CDVCommandStatus_OK, messageAs: obj!)
        commandDelegate.send(r, callbackId: command.callbackId)
    }

    private func fail(_ command: CDVInvokedUrlCommand, _ message: String) {
        let r = CDVPluginResult(status: CDVCommandStatus_ERROR, messageAs: message)
        commandDelegate.send(r, callbackId: command.callbackId)
    }
}
