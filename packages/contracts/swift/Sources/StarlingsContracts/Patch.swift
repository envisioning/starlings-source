// The one hand-written type in this module. Wire.swift is generated; this is
// what its request bodies use for a field a write may leave alone, clear or
// set — what `.nullable().optional()` means on a zod input schema.

/// A field on a write with three states, where an Optional has two.
///
/// `.omit` leaves the key out, so the Worker keeps what it has. `.null` sends
/// `null`, which clears it. `.value` sets it. A plain `T?` cannot say the
/// first two apart, and synthesized Codable drops every nil, which is why the
/// hand-written request structs this replaces each carried their own encoder.
public enum Patch<Value: Codable & Hashable & Sendable>: Hashable, Sendable {
  case omit
  case null
  case value(Value)

  /// Send what is there, or clear it: the whole-editor write, where an empty
  /// field means the stored value goes too.
  public init(_ value: Value?) {
    self = value.map(Patch.value) ?? .null
  }

  /// Send what is there, or say nothing: the partial write, where an empty
  /// field is one the caller is not talking about.
  public static func ifSome(_ value: Value?) -> Patch<Value> {
    value.map(Patch.value) ?? .omit
  }

  /// The value when one is set; nil for both `.omit` and `.null`.
  public var value: Value? {
    if case .value(let value) = self { return value }
    return nil
  }
}

extension KeyedDecodingContainer {
  /// Absent key: `.omit`. Explicit null: `.null`. Otherwise the value.
  public func decodePatch<T: Codable & Hashable & Sendable>(_ type: T.Type, forKey key: Key) throws -> Patch<T> {
    guard contains(key) else { return .omit }
    if try decodeNil(forKey: key) { return .null }
    return .value(try decode(T.self, forKey: key))
  }
}

extension KeyedEncodingContainer {
  public mutating func encodePatch<T: Codable & Hashable & Sendable>(_ patch: Patch<T>, forKey key: Key) throws {
    switch patch {
    case .omit: break
    case .null: try encodeNil(forKey: key)
    case .value(let value): try encode(value, forKey: key)
    }
  }
}
