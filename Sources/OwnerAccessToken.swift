import Foundation

/// What a client reads out of its own owner access token: the expiry, so it
/// renews before the Worker refuses it. The Worker owns the lifetime; a client
/// that assumed 8h would renew at the wrong moment the day that changes.
/// Nothing else in the token is read on a device, and nothing is verified
/// here: the signature is the Worker's business.
enum OwnerAccessToken {
    private struct Claims: Decodable {
        /// Unix seconds, as JWTs count them.
        let exp: Double
    }

    /// `exp` out of the JWT payload, or nil when the token cannot be read.
    static func expiry(of accessToken: String) -> Date? {
        let parts = accessToken.split(separator: ".")
        guard parts.count == 3 else { return nil }
        var payload = String(parts[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while payload.count % 4 != 0 { payload.append("=") }
        guard let data = Data(base64Encoded: payload),
              let claims = try? JSONDecoder().decode(Claims.self, from: data) else { return nil }
        return Date(timeIntervalSince1970: claims.exp)
    }

    /// Under an hour left, or unreadable: renew now.
    static func expiresSoon(_ accessToken: String, now: Date = Date()) -> Bool {
        guard let expiry = expiry(of: accessToken) else { return true }
        return expiry.timeIntervalSince(now) < 3_600
    }
}
