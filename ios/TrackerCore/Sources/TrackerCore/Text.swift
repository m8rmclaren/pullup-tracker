// String rules that must agree with the TypeScript side byte for byte. JavaScript compares
// strings by UTF-16 code unit and measures them in code points, so tie-breaks and length
// limits use those here too, not Swift's Character semantics.

/// `a < b` as JavaScript compares strings.
func utf16Precedes(_ a: String, _ b: String) -> Bool {
    a.utf16.lexicographicallyPrecedes(b.utf16)
}

/// JavaScript's `[...value].length`.
func codePointCount(_ value: String) -> Int {
    value.unicodeScalars.count
}

func isControlOrFormat(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.properties.generalCategory {
    case .control, .format: true
    default: false
    }
}

/// What JavaScript's `\s` and `trim` match once controls and formats are gone.
func isJavaScriptSpace(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.properties.generalCategory {
    case .spaceSeparator, .lineSeparator, .paragraphSeparator: true
    default: scalar.value >= 0x09 && scalar.value <= 0x0D
    }
}

func isJavaScriptTrimmed(_ value: String) -> Bool {
    guard let first = value.unicodeScalars.first, let last = value.unicodeScalars.last else { return true }
    let isTrimSpace = { (scalar: Unicode.Scalar) in isJavaScriptSpace(scalar) || scalar == "\u{FEFF}" }
    return !isTrimSpace(first) && !isTrimSpace(last)
}

/// Printable, already trimmed, and 1 to `maxLength` characters. The server stores names at face value, so this is the whole check.
public func isCleanText(_ value: String, maxLength: Int) -> Bool {
    !value.isEmpty && isJavaScriptTrimmed(value) && !value.unicodeScalars.contains(where: isControlOrFormat) && codePointCount(value) <= maxLength
}

public let maxNameLength = 24

/// Trims and collapses whitespace; nil if nothing printable is left or it is too long.
public func cleanName(_ input: String, maxLength: Int = maxNameLength) -> String? {
    var scalars = String.UnicodeScalarView()
    var isPendingSpace = false
    for scalar in input.unicodeScalars where !isControlOrFormat(scalar) {
        if isJavaScriptSpace(scalar) {
            isPendingSpace = true
            continue
        }
        if isPendingSpace && !scalars.isEmpty { scalars.append(" ") }
        isPendingSpace = false
        scalars.append(scalar)
    }
    let cleaned = String(scalars)
    return !cleaned.isEmpty && codePointCount(cleaned) <= maxLength ? cleaned : nil
}
