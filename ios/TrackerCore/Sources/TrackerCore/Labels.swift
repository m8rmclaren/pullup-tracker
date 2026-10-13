import Foundation

// How sets read, as the PWA's labels.ts writes them.

/// "45s", "2m", "1m 30s".
public func formatHoldSeconds(_ holdSeconds: Int) -> String {
    if holdSeconds < 60 { return "\(holdSeconds)s" }
    let minutes = holdSeconds / 60
    let seconds = holdSeconds % 60
    return seconds > 0 ? "\(minutes)m \(seconds)s" : "\(minutes)m"
}

/// A count in its unit: "6" for reps, "3 laps", "1 lap".
public func formatCount(_ count: Int, unit: String?) -> String {
    guard let unit, unit != Catalog.ringUnit else { return String(count) }
    return "\(count) \(count == 1 ? unit : "\(unit)s")"
}

extension Entry {
    /// "6", "3 laps", or "45s" for a hold.
    public func formattedAmount(unitOf: UnitLookup) -> String {
        if let holdSeconds { return formatHoldSeconds(holdSeconds) }
        return formatCount(reps ?? 0, unit: unitOf(resolvedExerciseId))
    }
}

public enum Links {
    /// The code in a device link (`…/#device=<code>`), or a bare code pasted on its own; nil if it is neither.
    public static func deviceCode(in text: String) -> String? {
        code(in: text, fragmentKey: "device")
    }

    /// The code in a friend or challenge link (`…/#join=<code>`), or a bare code.
    public static func joinCode(in text: String) -> String? {
        code(in: text, fragmentKey: "join")
    }

    private static func code(in text: String, fragmentKey: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let marker = "#\(fragmentKey)="
        let candidate = trimmed.range(of: marker).map { String(trimmed[$0.upperBound...]) } ?? trimmed
        let isCode = (16...256).contains(candidate.utf8.count) && candidate.utf8.allSatisfy { byte in
            switch byte {
            case UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "a")...UInt8(ascii: "z"), UInt8(ascii: "0")...UInt8(ascii: "9"), UInt8(ascii: "_"), UInt8(ascii: "-"): true
            default: false
            }
        }
        return isCode ? candidate : nil
    }
}
