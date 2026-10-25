import Foundation

/// 一晩分の ADTS ファイルから、指定した時間帯だけを切り出す（再変換なし）。
/// ADTS はフレーム（1024サンプル = 16kHz で64ms）ごとに独立しているため、
/// 必要なフレームをそのままコピーすれば再生できるファイルになる。（Android の AudioTrimmer.java と同じ処理）
enum AudioTrimmer {

    /// - Parameter ranges: [(start, end)]（秒, 昇順・重なりなし）
    /// - Returns: 音声を書き出せた範囲 [start, end, clip]
    static func trim(full: URL, outDir: URL, ranges: [(Double, Double)], sampleRate: Int) throws -> [[String: Any]] {
        let data = try Data(contentsOf: full, options: .alwaysMapped)
        let names = ranges.indices.map { String(format: "seg_%04d.aac", $0 + 1) }
        var outputs = [Data?](repeating: nil, count: ranges.count)

        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            let b = raw.bindMemory(to: UInt8.self)
            var i = 0
            var pos = 0      // サンプル位置
            var ri = 0
            while ri < ranges.count && i + 7 <= b.count {
                guard b[i] == 0xFF, (b[i + 1] & 0xF0) == 0xF0 else { break } // 壊れた末尾
                let len = (Int(b[i + 3] & 0x03) << 11) | (Int(b[i + 4]) << 3) | (Int(b[i + 5] & 0xE0) >> 5)
                guard len >= 7, i + len <= b.count else { break }
                let blocks = Int(b[i + 6] & 0x03) + 1
                let t = Double(pos) / Double(sampleRate)
                pos += 1024 * blocks

                while ri < ranges.count && t >= ranges[ri].1 { ri += 1 }
                if ri < ranges.count && t >= ranges[ri].0 {
                    if outputs[ri] == nil { outputs[ri] = Data() }
                    outputs[ri]!.append(b.baseAddress! + i, count: len)
                }
                i += len
            }
        }

        var result: [[String: Any]] = []
        for (k, d) in outputs.enumerated() {
            guard let d = d, !d.isEmpty else { continue }
            try d.write(to: outDir.appendingPathComponent(names[k]), options: .atomic)
            result.append(["start": ranges[k].0, "end": ranges[k].1, "clip": names[k]])
        }
        return result
    }
}
