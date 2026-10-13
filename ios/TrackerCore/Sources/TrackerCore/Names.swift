import Foundation

// Matching what someone typed or said ("push ups", "red rocks") to an exercise or variation they
// can see. A port of names.ts, held to it by test/fixtures/compose/names.json. Keys are compared
// as UTF-16, as JavaScript does, so lengths and typo allowances agree.

public protocol NamedItem {
    var id: String { get }
    var name: String { get }
}

public struct NamedRef: NamedItem, Codable, Hashable, Sendable {
    public var id: String
    public var name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

/// Lowercase words without accents or punctuation, each with a plural "s" dropped: "Push-Ups!" → ["push", "up"].
public func nameWords(_ name: String) -> [String] {
    let unaccented = String(String.UnicodeScalarView(name.decomposedStringWithCompatibilityMapping.unicodeScalars.filter { !isMark($0) })).lowercased()
    var words: [String] = []
    var word = String.UnicodeScalarView()
    for scalar in unaccented.unicodeScalars {
        if isLetterOrNumber(scalar) {
            word.append(scalar)
        } else if !word.isEmpty {
            words.append(singular(String(word)))
            word = String.UnicodeScalarView()
        }
    }
    if !word.isEmpty { words.append(singular(String(word))) }
    return words
}

private func isMark(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.properties.generalCategory {
    case .nonspacingMark, .spacingMark, .enclosingMark: true
    default: false
    }
}

private func isLetterOrNumber(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.properties.generalCategory {
    case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter, .decimalNumber, .letterNumber, .otherNumber: true
    default: false
    }
}

private func singular(_ word: String) -> String {
    guard word.utf16.count >= 3, word.hasSuffix("s"), !word.hasSuffix("ss") else { return word }
    return String(String.UnicodeScalarView(word.unicodeScalars.dropLast()))
}

/// One key per name, so "pull-ups", "Pull ups" and "pullup" collide.
public func nameKey(_ name: String) -> String {
    nameWords(name).joined()
}

public func editDistance(_ a: String, _ b: String) -> Int {
    editDistance(Array(a.utf16), Array(b.utf16))
}

private func editDistance(_ a: [UInt16], _ b: [UInt16]) -> Int {
    if a == b { return 0 }
    var previous = Array(0...b.count)
    for i in a.indices {
        var current = [i + 1]
        for j in b.indices {
            current.append(min(previous[j + 1] + 1, current[j] + 1, previous[j] + (a[i] == b[j] ? 0 : 1)))
        }
        previous = current
    }
    return previous[b.count]
}

/// Typos allowed for a key this long: none under 5 characters, then one per 5, at most 3.
public func typoAllowance(keyLength: Int) -> Int {
    min(3, keyLength / 5)
}

/// The one item a name means, or nil: an exact key match, else the only item whose words include
/// every word of the name ("red rocks" → "Red Rocks stairs"), else the only item within the typo
/// allowance at the smallest distance. Anything ambiguous is no match, so a guess never lands a
/// set on the wrong exercise.
public func matchName<Item: NamedItem>(_ name: String, in items: [Item]) -> Item? {
    let key = nameKey(name)
    guard !key.isEmpty else { return nil }
    let exact = items.filter { nameKey($0.name) == key }
    if !exact.isEmpty { return unique(exact) }

    let words = nameWords(name)
    let containing = items.filter { item in
        let itemWords = nameWords(item.name)
        return words.allSatisfy(itemWords.contains)
    }
    if !containing.isEmpty { return unique(containing) }

    let allowance = typoAllowance(keyLength: key.utf16.count)
    var best: [Item] = []
    var bestDistance = Int.max
    for item in items {
        let distance = editDistance(key, nameKey(item.name))
        if distance > allowance { continue }
        if distance < bestDistance {
            best = [item]
            bestDistance = distance
        } else if distance == bestDistance {
            best.append(item)
        }
    }
    return unique(best)
}

/// Several items sharing one id (an exercise listed twice) still count as one.
private func unique<Item: NamedItem>(_ items: [Item]) -> Item? {
    Set(items.map(\.id)).count == 1 ? items.first : nil
}

/// Items for a search box, best first: exact, then names starting with the query, then names
/// containing every word of it, then near misses. An empty query returns nothing.
public func searchNames<Item: NamedItem>(_ query: String, in items: [Item]) -> [Item] {
    let key = Array(nameKey(query).utf16)
    guard !key.isEmpty else { return [] }
    let words = nameWords(query).map { Array($0.utf16) }
    var scored: [(item: Item, score: Int, index: Int)] = []
    for (index, item) in items.enumerated() {
        let itemKey = Array(nameKey(item.name).utf16)
        let itemWords = nameWords(item.name).map { Array($0.utf16) }
        let score: Int? =
            if itemKey == key { 0 }
            else if itemKey.starts(with: key) { 1 }
            else if words.allSatisfy({ word in itemWords.contains { $0.starts(with: word) } }) { 2 }
            else if contains(itemKey, key) { 3 }
            else if editDistance(key, Array(itemKey.prefix(key.count))) <= typoAllowance(keyLength: key.count) { 4 }
            else { nil }
        if let score { scored.append((item, score, index)) }
    }
    return scored.sorted { a, b in
        if a.score != b.score { return a.score < b.score }
        let nameOrder = a.item.name.compare(b.item.name, locale: Locale(identifier: "en"))
        if nameOrder != .orderedSame { return nameOrder == .orderedAscending }
        return a.index < b.index
    }.map(\.item)
}

private func contains(_ haystack: [UInt16], _ needle: [UInt16]) -> Bool {
    guard needle.count <= haystack.count else { return false }
    return (0...(haystack.count - needle.count)).contains { haystack[$0..<($0 + needle.count)].elementsEqual(needle) }
}
