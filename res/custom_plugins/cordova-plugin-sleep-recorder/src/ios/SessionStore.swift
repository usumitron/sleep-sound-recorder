import Foundation

/// セッションの保存とルール適用（Android の SessionStore.java と同じ構成）。
///
/// sessions/<id>/meta.json     セッション情報
/// sessions/<id>/graph.bin     1秒値（int16LE, 0.1dB単位）
/// sessions/<id>/segments.json 大きな音が続いた時間帯と音声ファイル（記録後の解析で作成）
/// sessions/<id>/clips/        音声（最新の保存セッションのみ）
///                               full.aac   記録中の一晩分（解析後に削除）
///                               seg_*.aac  時間帯ごとに切り出した音声
enum SessionStore {
    static let maxSessions = 30
    static let minDurationSec = 600
    private static let fm = FileManager.default

    static var root: URL {
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        var r = base.appendingPathComponent("sessions", isDirectory: true)
        if !fm.fileExists(atPath: r.path) {
            try? fm.createDirectory(at: r, withIntermediateDirectories: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true // iCloudバックアップ対象外
            try? r.setResourceValues(values)
        }
        return r
    }

    static func dir(_ id: String) -> URL { root.appendingPathComponent(id, isDirectory: true) }

    // ---------------------------------------------------------------- 書き込み中のセッション

    final class Active {
        let dir: URL
        private(set) var meta: [String: Any]

        init(startedAt: Int64, plannedEndAt: Int64, sensitivity: String) throws {
            let id = String(startedAt)
            dir = SessionStore.dir(id)
            try FileManager.default.createDirectory(at: dir.appendingPathComponent("clips"), withIntermediateDirectories: true)
            meta = [
                "id": id,
                "startedAt": startedAt,
                "endedAt": NSNull(),
                "lastWriteAt": startedAt,
                "durationSec": 0,
                "endReason": NSNull(),
                "sensitivity": sensitivity,
                "algo": 3,
                "audio": "full",   // full: 解析待ち / segments: 切り出し済み / none: 音声なし
                "plannedEndAt": plannedEndAt,
                "eventCount": 0,
                "maxDb": NSNull(),
                "hasAudio": true,
            ]
            try SessionStore.writeMeta(dir, meta)
            SessionStore.log("start \(id) sens=\(sensitivity)")
        }

        var id: String { meta["id"] as? String ?? "" }

        func appendGraph(_ values: [Int16]) throws {
            guard !values.isEmpty else { return }
            var data = Data(capacity: values.count * 2)
            for v in values {
                let le = UInt16(bitPattern: v).littleEndian
                data.append(UInt8(le & 0xff))
                data.append(UInt8(le >> 8))
            }
            try SessionStore.append(data, to: dir.appendingPathComponent("graph.bin"))
        }

        func appendEvent(_ ev: [String: Any]) throws {
            var data = try JSONSerialization.data(withJSONObject: ev)
            data.append(0x0A)
            try SessionStore.append(data, to: dir.appendingPathComponent("events.jsonl"))
        }

        var fullAudioURL: URL { dir.appendingPathComponent("clips").appendingPathComponent("full.aac") }

        func checkpoint(maxDb: Double) throws {
            meta["lastWriteAt"] = SessionStore.nowMs()
            meta["durationSec"] = SessionStore.graphSeconds(dir)
            if maxDb.isFinite { meta["maxDb"] = SessionStore.round1(maxDb) }
            try SessionStore.writeMeta(dir, meta)
        }
    }

    // ---------------------------------------------------------------- 終了処理・ルール

    /// 終了処理。10分未満なら破棄。保存したら true。
    @discardableResult
    static func finish(id: String, reason: String, endedAt: Int64) -> Bool {
        let d = dir(id)
        guard var meta = readMeta(d) else {
            log("finish: meta unreadable, deleted \(id)")
            try? fm.removeItem(at: d)
            return false
        }
        let dur = graphSeconds(d)
        if dur < minDurationSec {
            log("discard \(id) (\(dur)s < 10min) reason=\(reason)")
            try? fm.removeItem(at: d)
            applyRetention()
            return false
        }
        meta["endedAt"] = endedAt
        meta["durationSec"] = dur
        meta["endReason"] = reason
        do { try writeMeta(d, meta) } catch { log("finish: meta write failed \(id): \(error)") }
        log("saved \(id) (\(dur)s) reason=\(reason)")
        applyRetention()
        return true
    }

    /// 強制終了などで終了処理されなかったセッションを復旧する。
    static func recover(activeId: String?) {
        guard let dirs = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { return }
        for d in dirs where d.lastPathComponent != activeId {
            guard let meta = readMeta(d) else {
                log("recover: meta unreadable, deleted \(d.lastPathComponent)")
                try? fm.removeItem(at: d)
                continue
            }
            if meta["endedAt"] is NSNull || meta["endedAt"] == nil {
                log("recover \(d.lastPathComponent)")
                let last = (meta["lastWriteAt"] as? NSNumber)?.int64Value ?? nowMs()
                finish(id: d.lastPathComponent, reason: "interrupted", endedAt: last)
            }
        }
    }

    /// 音声は最新の保存セッションのみ残す。件数は30件まで。
    static func applyRetention() {
        let done = finishedMetas()
        for (i, m) in done.enumerated() {
            guard let id = m["id"] as? String else { continue }
            let d = dir(id)
            if i >= maxSessions {
                log("retention: delete oldest \(id)")
                try? fm.removeItem(at: d)
            } else if i > 0, (m["hasAudio"] as? Bool) == true {
                try? fm.removeItem(at: d.appendingPathComponent("clips"))
                var mm = m
                mm["hasAudio"] = false
                mm["audio"] = "none"
                try? writeMeta(d, mm)
            }
        }
    }

    // ---------------------------------------------------------------- 読み出し

    static func finishedMetas() -> [[String: Any]] {
        guard let dirs = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { return [] }
        let list = dirs.compactMap { readMeta($0) }.filter { !($0["endedAt"] is NSNull) && $0["endedAt"] != nil }
        return list.sorted {
            (($0["startedAt"] as? NSNumber)?.int64Value ?? 0) > (($1["startedAt"] as? NSNumber)?.int64Value ?? 0)
        }
    }

    static func get(_ id: String) -> [String: Any]? {
        let d = dir(id)
        guard let meta = readMeta(d) else { return nil }
        var events: [Any] = []
        if let text = try? String(contentsOf: d.appendingPathComponent("events.jsonl"), encoding: .utf8) {
            for line in text.split(separator: "\n") {
                if let data = line.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: data) {
                    events.append(obj)
                }
            }
        }
        let graph = (try? Data(contentsOf: d.appendingPathComponent("graph.bin"))) ?? Data()
        var segments: Any = NSNull()
        if let sd = try? Data(contentsOf: d.appendingPathComponent("segments.json")),
           let obj = try? JSONSerialization.jsonObject(with: sd) {
            segments = obj
        }
        return ["meta": meta, "events": events, "graph": graph.base64EncodedString(), "segments": segments]
    }

    private static let trimQueue = DispatchQueue(label: "sleeprecorder.trim")

    /// 一晩分の音声から、指定した時間帯だけを切り出して残す。info（感度など）は segments.json にそのまま残す
    static func trim(id: String, ranges: [(Double, Double)], info: [String: Any]) throws -> [String: Any] {
        try trimQueue.sync {
            let d = dir(id)
            guard var meta = readMeta(d) else { throw RecorderError.message("記録が見つかりません") }
            let clips = d.appendingPathComponent("clips")
            let full = clips.appendingPathComponent("full.aac")
            guard fm.fileExists(atPath: full.path) else { return ["info": info, "segments": [Any]()] }
            let segs = try AudioTrimmer.trim(full: full, outDir: clips, ranges: ranges, sampleRate: RecorderEngine.sampleRate)
            let out: [String: Any] = ["info": info, "segments": segs]
            try JSONSerialization.data(withJSONObject: out).write(to: d.appendingPathComponent("segments.json"), options: .atomic)
            try? fm.removeItem(at: full)
            meta["audio"] = "segments"
            meta["eventCount"] = segs.count
            try writeMeta(d, meta)
            log("trim \(id): \(segs.count) segments")
            return out
        }
    }

    static func deleteAll(activeId: String?) {
        log("deleteAll by user")
        guard let dirs = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { return }
        for d in dirs where d.lastPathComponent != activeId { try? fm.removeItem(at: d) }
    }

    // ---------------------------------------------------------------- 診断

    private static let logQueue = DispatchQueue(label: "sleeprecorder.log")

    static var logURL: URL { root.deletingLastPathComponent().appendingPathComponent("sessions-log.txt") }

    /// 保存処理の記録（削除の理由を後から確認するため）
    static func log(_ msg: String) {
        let df = DateFormatter()
        df.locale = Locale(identifier: "en_US_POSIX")
        df.dateFormat = "MM/dd HH:mm:ss"
        let line = df.string(from: Date()) + " " + msg + "\n"
        logQueue.sync {
            let url = logURL
            if let size = (try? fm.attributesOfItem(atPath: url.path))?[.size] as? NSNumber, size.intValue > 200 * 1024 {
                try? fm.removeItem(at: url)
            }
            try? append(Data(line.utf8), to: url)
        }
    }

    static func diagnostics() -> [String: Any] {
        var dirs: [[String: Any]] = []
        if let list = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) {
            for d in list {
                var o: [String: Any] = ["id": d.lastPathComponent, "durationSec": graphSeconds(d)]
                if let m = readMeta(d) {
                    o["finished"] = !(m["endedAt"] is NSNull) && m["endedAt"] != nil
                    o["hasAudio"] = (m["hasAudio"] as? Bool) ?? false
                } else {
                    o["error"] = "meta unreadable"
                }
                o["clips"] = (try? fm.contentsOfDirectory(atPath: d.appendingPathComponent("clips").path))?.count ?? 0
                dirs.append(o)
            }
        }
        let text = (try? String(contentsOf: logURL, encoding: .utf8)) ?? ""
        let tail = text.split(separator: "\n").suffix(80).joined(separator: "\n")
        return ["dirs": dirs, "log": tail]
    }

    // ---------------------------------------------------------------- ユーティリティ

    static func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    static func round1(_ v: Double) -> Double { (v * 10).rounded() / 10 }

    static func graphSeconds(_ d: URL) -> Int {
        let attrs = try? fm.attributesOfItem(atPath: d.appendingPathComponent("graph.bin").path)
        return Int(((attrs?[.size] as? NSNumber)?.int64Value ?? 0) / 2)
    }

    static func readMeta(_ d: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: d.appendingPathComponent("meta.json")) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    static func writeMeta(_ d: URL, _ meta: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: meta)
        try data.write(to: d.appendingPathComponent("meta.json"), options: .atomic)
    }

    static func append(_ data: Data, to url: URL) throws {
        if !fm.fileExists(atPath: url.path) {
            try data.write(to: url)
            return
        }
        let h = try FileHandle(forWritingTo: url)
        defer { try? h.close() }
        h.seekToEndOfFile()
        h.write(data)
    }

    static func countLines(_ url: URL) -> Int {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return 0 }
        return text.split(separator: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.count
    }
}
