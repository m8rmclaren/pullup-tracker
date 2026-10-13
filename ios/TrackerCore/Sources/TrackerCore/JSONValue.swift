import Foundation

/// Any JSON value. Validation works on these rather than on decoded types, because what it
/// rejects (a string where a number belongs, a fractional count) never decodes.
public enum JSONValue: Hashable, Sendable, Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let bool = try? container.decode(Bool.self) {
            self = .bool(bool)
        } else if let number = try? container.decode(Double.self) {
            self = .number(number)
        } else if let string = try? container.decode(String.self) {
            self = .string(string)
        } else if let array = try? container.decode([JSONValue].self) {
            self = .array(array)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let bool): try container.encode(bool)
        case .number(let number): try container.encode(number)
        case .string(let string): try container.encode(string)
        case .array(let array): try container.encode(array)
        case .object(let object): try container.encode(object)
        }
    }

    public subscript(key: String) -> JSONValue? {
        if case .object(let object) = self { return object[key] }
        return nil
    }

    public init<T: Encodable>(encoding value: T) throws {
        self = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
    }

    public func decoded<T: Decodable>(as type: T.Type = T.self) throws -> T {
        try JSONDecoder().decode(type, from: JSONEncoder().encode(self))
    }
}

/// JavaScript's largest exactly representable integer. Clocks and counts past it can't round-trip through the server.
let maxSafeInteger: Double = 9_007_199_254_740_991

extension JSONValue {
    /// The value as an integer, if it is a number with no fractional part in JavaScript's safe range.
    var safeInteger: Int64? {
        guard case .number(let number) = self, number.rounded() == number, abs(number) <= maxSafeInteger else { return nil }
        return Int64(number)
    }

    var stringValue: String? {
        if case .string(let string) = self { return string }
        return nil
    }
}
