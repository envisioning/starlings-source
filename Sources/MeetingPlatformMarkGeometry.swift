import CoreGraphics

/// The external meeting-platform marks used by the web calendar are SVG paths.
/// Keep their path data here too, rather than approximating them with text or
/// opaque system-like tiles on the native clients. The small parser is only run
/// for these fixed, bundled paths and lets AppKit and SwiftUI share the exact
/// same geometry without shipping an SVG parser or raster asset.
enum MeetingPlatformMarkGeometry {
    static func color(hex: String) -> CGColor? {
        let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard digits.count == 6, let value = UInt32(digits, radix: 16) else { return nil }
        let red = CGFloat((value >> 16) & 0xff) / 255
        let green = CGFloat((value >> 8) & 0xff) / 255
        let blue = CGFloat(value & 0xff) / 255
        return CGColor(colorSpace: CGColorSpaceCreateDeviceRGB(), components: [red, green, blue, 1])
    }

    static func agentAvatarPath(_ data: String, in rect: CGRect) -> CGPath? {
        scaledPath(data, viewBox: CGRect(x: -120, y: -120, width: 240, height: 240), in: rect)
    }

    static func path(for platform: CalendarMeetingPlatform, in rect: CGRect) -> CGPath? {
        switch platform {
        case .zoom:
            return scaledPath(zoom, viewBox: CGRect(x: 0, y: 0, width: 16, height: 16), in: rect)
        case .teams:
            return scaledPath(teams, viewBox: CGRect(x: 0, y: 0, width: 24, height: 24), in: rect)
        case .googleMeet:
            return scaledPath(googleG, viewBox: CGRect(x: 0, y: 0, width: 24, height: 24), in: rect)
        case .starlings, .none:
            return nil
        default:
            return scaledPath(video, viewBox: CGRect(x: 0, y: 0, width: 16, height: 16), in: rect)
        }
    }

    private static func scaledPath(
        _ data: String,
        viewBox: CGRect,
        in rect: CGRect
    ) -> CGPath? {
        var parser = SVGPathParser(data)
        guard let source = parser.parse() else { return nil }
        var transform = CGAffineTransform(
            a: rect.width / viewBox.width,
            b: 0,
            c: 0,
            d: rect.height / viewBox.height,
            tx: rect.minX - viewBox.minX * rect.width / viewBox.width,
            ty: rect.minY - viewBox.minY * rect.height / viewBox.height
        )
        return source.copy(using: &transform)
    }

    // Keep these in lockstep with MeetingPlatformIcon in web/src/action-icons.tsx.
    private static let video = "M1.5 4h8.5v8H1.5Z M11 6.2 14.5 4.4v7.2L11 9.8Z"
    private static let zoom = "M2.3 3.2h11.4v1.45L4.55 11.35h9.15v1.45H2.3v-1.45l9.15-6.7H2.3Z"

    private static let teams = "M3 3h18v4.25h-6.75V21h-4.5V7.25H3Z"

    private static let googleG = "M12.48 10.92v3.72h5.48c-.24 1.2-1.39 3.52-5.48 3.52-3.3 0-5.99-2.73-5.99-6.1s2.69-6.1 5.99-6.1c1.88 0 3.14.8 3.86 1.49l2.64-2.52C17.2 3.58 15.08 2.5 12.48 2.5 7.24 2.5 3 6.78 3 12s4.24 9.5 9.48 9.5c5.68 0 9.44-3.76 9.44-9.06 0-.61-.07-1.07-.16-1.52h-9.28Z"
}

/// Small SVG path reader: the fixed provider paths above, and the paths of a
/// workspace's uploaded mark (`WorkspaceMarkVector`). Every path command,
/// arcs included, with repeated command groups and the compact number and
/// flag syntax SVG permits.
struct SVGPathParser {
    private let bytes: [UInt8]
    private var index = 0
    private var current = CGPoint.zero
    private var subpathStart = CGPoint.zero
    private var lastCubicControl: CGPoint?
    private var lastQuadraticControl: CGPoint?
    private var path = CGMutablePath()

    init(_ data: String) {
        bytes = Array(data.utf8)
    }

    mutating func parse() -> CGPath? {
        var command: UInt8?

        while true {
            skipSeparators()
            guard index < bytes.count else { return path }

            if isCommand(bytes[index]) {
                command = bytes[index]
                index += 1
                if command == 90 || command == 122 { // Z / z
                    path.closeSubpath()
                    current = subpathStart
                    resetControls()
                    command = nil
                    continue
                }
            }

            guard let active = command else { return nil }
            let relative = active >= 97
            let normalized = active >= 97 ? active - 32 : active
            switch normalized {
            case 77: // M / m
                guard let x = number(), let y = number() else { return nil }
                let point = resolved(x, y, relative: relative)
                path.move(to: point)
                current = point
                subpathStart = point
                resetControls()
                command = relative ? 108 : 76 // subsequent pairs are l / L
            case 76: // L / l
                guard let x = number(), let y = number() else { return nil }
                let point = resolved(x, y, relative: relative)
                path.addLine(to: point)
                current = point
                resetControls()
            case 72: // H / h
                guard let x = number() else { return nil }
                let point = CGPoint(
                    x: relative ? current.x + x : x,
                    y: current.y
                )
                path.addLine(to: point)
                current = point
                resetControls()
            case 86: // V / v
                guard let y = number() else { return nil }
                let point = CGPoint(
                    x: current.x,
                    y: relative ? current.y + y : y
                )
                path.addLine(to: point)
                current = point
                resetControls()
            case 67: // C / c
                guard let x1 = number(), let y1 = number(),
                      let x2 = number(), let y2 = number(),
                      let x = number(), let y = number()
                else { return nil }
                let control1 = resolved(x1, y1, relative: relative)
                let control2 = resolved(x2, y2, relative: relative)
                let point = resolved(x, y, relative: relative)
                path.addCurve(to: point, control1: control1, control2: control2)
                current = point
                lastCubicControl = control2
                lastQuadraticControl = nil
            case 83: // S / s
                guard let x2 = number(), let y2 = number(),
                      let x = number(), let y = number()
                else { return nil }
                let control1 = lastCubicControl.map {
                    CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y)
                } ?? current
                let control2 = resolved(x2, y2, relative: relative)
                let point = resolved(x, y, relative: relative)
                path.addCurve(to: point, control1: control1, control2: control2)
                current = point
                lastCubicControl = control2
                lastQuadraticControl = nil
            case 81: // Q / q
                guard let cx = number(), let cy = number(),
                      let x = number(), let y = number()
                else { return nil }
                let control = resolved(cx, cy, relative: relative)
                let point = resolved(x, y, relative: relative)
                path.addQuadCurve(to: point, control: control)
                current = point
                lastQuadraticControl = control
                lastCubicControl = nil
            case 84: // T / t
                guard let x = number(), let y = number() else { return nil }
                let control = lastQuadraticControl.map {
                    CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y)
                } ?? current
                let point = resolved(x, y, relative: relative)
                path.addQuadCurve(to: point, control: control)
                current = point
                lastQuadraticControl = control
                lastCubicControl = nil
            case 65: // A / a
                guard let rx = number(), let ry = number(), let rotation = number(),
                      let large = flag(), let sweep = flag(),
                      let x = number(), let y = number()
                else { return nil }
                let point = resolved(x, y, relative: relative)
                addArc(to: point, rx: abs(rx), ry: abs(ry), rotation: rotation * .pi / 180, large: large, sweep: sweep)
                current = point
                resetControls()
            default:
                return nil
            }
        }
    }

    /// The SVG endpoint arc as a centre arc (SVG 1.1 appendix F.6), drawn on
    /// a unit circle scaled and rotated into the ellipse.
    private mutating func addArc(to end: CGPoint, rx: CGFloat, ry: CGFloat, rotation: CGFloat, large: Bool, sweep: Bool) {
        let start = current
        guard rx > 0, ry > 0, start != end else {
            path.addLine(to: end)
            return
        }
        let cosPhi = cos(rotation), sinPhi = sin(rotation)
        let dx = (start.x - end.x) / 2, dy = (start.y - end.y) / 2
        let x1 = cosPhi * dx + sinPhi * dy
        let y1 = -sinPhi * dx + cosPhi * dy
        var rx = rx, ry = ry
        let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
        if lambda > 1 {
            rx *= lambda.squareRoot()
            ry *= lambda.squareRoot()
        }
        let numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
        let denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1
        var factor = denominator == 0 ? 0 : (max(0, numerator) / denominator).squareRoot()
        if large == sweep { factor = -factor }
        let cx1 = factor * rx * y1 / ry
        let cy1 = -factor * ry * x1 / rx
        let center = CGPoint(
            x: cosPhi * cx1 - sinPhi * cy1 + (start.x + end.x) / 2,
            y: sinPhi * cx1 + cosPhi * cy1 + (start.y + end.y) / 2
        )
        func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
            atan2(ux * vy - uy * vx, ux * vx + uy * vy)
        }
        let theta = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
        var delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
        if !sweep && delta > 0 { delta -= 2 * .pi }
        if sweep && delta < 0 { delta += 2 * .pi }
        let transform = CGAffineTransform(translationX: center.x, y: center.y)
            .rotated(by: rotation)
            .scaledBy(x: rx, y: ry)
        path.addRelativeArc(center: .zero, radius: 1, startAngle: theta, delta: delta, transform: transform)
    }

    /// An arc flag: a single 0 or 1, which SVG lets run into the next number.
    private mutating func flag() -> Bool? {
        skipSeparators()
        guard index < bytes.count, bytes[index] == 48 || bytes[index] == 49 else { return nil }
        defer { index += 1 }
        return bytes[index] == 49
    }

    private mutating func resetControls() {
        lastCubicControl = nil
        lastQuadraticControl = nil
    }

    private func resolved(_ x: CGFloat, _ y: CGFloat, relative: Bool) -> CGPoint {
        relative
            ? CGPoint(x: current.x + x, y: current.y + y)
            : CGPoint(x: x, y: y)
    }

    private mutating func skipSeparators() {
        while index < bytes.count {
            switch bytes[index] {
            case 9, 10, 13, 32, 44: index += 1
            default: return
            }
        }
    }

    private func isCommand(_ byte: UInt8) -> Bool {
        let normalized = byte >= 97 ? byte - 32 : byte
        switch normalized {
        case 77, 76, 72, 86, 67, 83, 81, 84, 65, 90: return true
        default: return false
        }
    }

    private mutating func number() -> CGFloat? {
        skipSeparators()
        let start = index
        if index < bytes.count, bytes[index] == 45 || bytes[index] == 43 { index += 1 }

        var hasDigits = false
        while index < bytes.count, bytes[index] >= 48, bytes[index] <= 57 {
            hasDigits = true
            index += 1
        }
        if index < bytes.count, bytes[index] == 46 {
            index += 1
            while index < bytes.count, bytes[index] >= 48, bytes[index] <= 57 {
                hasDigits = true
                index += 1
            }
        }
        guard hasDigits else {
            index = start
            return nil
        }

        if index < bytes.count, bytes[index] == 101 || bytes[index] == 69 {
            let exponentStart = index
            index += 1
            if index < bytes.count, bytes[index] == 45 || bytes[index] == 43 { index += 1 }
            let digitStart = index
            while index < bytes.count, bytes[index] >= 48, bytes[index] <= 57 { index += 1 }
            if digitStart == index { index = exponentStart }
        }

        return Double(String(decoding: bytes[start..<index], as: UTF8.self)).map { CGFloat($0) }
    }
}
