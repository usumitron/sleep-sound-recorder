import Foundation

/// 検知アルゴリズム（tools/detector.js と同一ロジック, v0.3.0）。
/// 1フレーム = 100ms。時刻はセッション開始からのフレーム番号。
/// 基準値 = 直近5分の1秒値の下位10%。しきい値 = 基準値 + 感度。
final class Detector {
    static let framesPerSec = 10
    static let calibFrames = 60 * framesPerSec
    static let baselineSeconds = 300
    static let baselinePercentile = 0.10
    static let minAboveFrames = 2 * framesPerSec
    static let gapFrames = 5 * framesPerSec
    static let algoVersion = 2

    static func offset(for sensitivity: String) -> Double {
        switch sensitivity {
        case "low": return 14
        case "high": return 7
        default: return 10
        }
    }

    struct Event {
        let startFrame: Int
        let endFrame: Int
        let peakDb: Double
        let peakFrame: Int
        let thrDb: Double
    }

    struct Result {
        var second: Double?
        var opened: (frame: Int, thrDb: Double)?   // このフレームでイベントが始まった
        var closed: Event?                         // 成立したイベント
        var discarded = false                      // 始まったイベントが不成立で終わった
    }

    private let offset: Double
    private(set) var frame = 0
    private(set) var inEvent = false
    private var secMax = -Double.infinity
    private var secCount = 0
    private var buf: [Double] = []
    private var baseline = Double.nan

    private var evStart = 0, lastAbove = 0, peakFrame = 0, above = 0
    private var peakDb = 0.0, evThr = 0.0

    init(offsetDb: Double) { offset = offsetDb }

    func processFrame(_ db: Double) -> Result {
        var r = Result()
        let f = frame
        frame += 1

        if f >= Detector.calibFrames && !baseline.isNaN {
            let thr = baseline + offset
            if !inEvent {
                if db > thr {
                    inEvent = true
                    evStart = f; lastAbove = f; above = 1
                    peakDb = db; peakFrame = f; evThr = thr
                    r.opened = (frame: f, thrDb: thr)
                }
            } else {
                // しきい値はイベント中も更新する（持続音なら基準値が追従してイベントが終わる）
                if db > thr {
                    above += 1
                    lastAbove = f
                    if db > peakDb { peakDb = db; peakFrame = f }
                }
                if f - lastAbove >= Detector.gapFrames {
                    r.closed = close(endFrame: lastAbove + 1)
                    r.discarded = r.closed == nil
                }
            }
        }

        if db > secMax { secMax = db }
        secCount += 1
        if secCount == Detector.framesPerSec {
            r.second = secMax
            buf.append(secMax)
            if buf.count > Detector.baselineSeconds { buf.removeFirst() }
            let s = buf.sorted()
            baseline = s[min(s.count - 1, Int(Double(s.count) * Detector.baselinePercentile))]
            secMax = -Double.infinity
            secCount = 0
        }
        return r
    }

    /// 記録終了時に、進行中のイベントを閉じる。成立しなければ nil
    func finish() -> Event? {
        guard inEvent else { return nil }
        return close(endFrame: min(lastAbove + 1, frame))
    }

    private func close(endFrame: Int) -> Event? {
        inEvent = false
        guard above >= Detector.minAboveFrames else { return nil }
        return Event(startFrame: evStart, endFrame: endFrame, peakDb: peakDb, peakFrame: peakFrame, thrDb: evThr)
    }
}
