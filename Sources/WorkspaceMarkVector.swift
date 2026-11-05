import CoreGraphics
import Foundation

/// A workspace's uploaded SVG mark as one outline (MZ, 2026-10-05: "treat
/// vector SVG as monochrome data, just outline"). The apps draw it in the
/// ink of where it sits, never in the file's own colours, the same rule the
/// web's CSS mask follows. No image decoding: iOS cannot decode SVG data, and
/// a mark is vector data anyway.
///
/// Reads the shapes a mark is made of: `path`, `rect`, `circle`, `ellipse`,
/// `polygon`, `polyline` and `line`, with `transform` on them and on their
/// groups, inside the root `viewBox`. A shape with `fill="none"` and a stroke
/// counts as its stroke. Anything under `defs`, `clipPath`, `mask`, `pattern`,
/// `symbol`, `style`, `title` or `metadata` is not drawn. Text, images and
/// gradients carry no outline here.
enum WorkspaceMarkVector {
    /// The outline in the file's own coordinates, and the box it is drawn in.
    /// Unchecked: a `CGPath` is immutable once built, so sharing it is safe.
    struct Outline: @unchecked Sendable {
        let path: CGPath
        let viewBox: CGRect
        let evenOdd: Bool
    }

    /// True for bytes that look like an SVG document rather than a raster image.
    static func isSVG(_ data: Data) -> Bool {
        let head = String(decoding: data.prefix(512), as: UTF8.self).lowercased()
        return head.contains("<svg")
    }

    static func outline(from data: Data) -> Outline? {
        let reader = Reader()
        let parser = XMLParser(data: data)
        parser.shouldResolveExternalEntities = false
        parser.delegate = reader
        guard parser.parse(), let viewBox = reader.viewBox, !reader.path.isEmpty else { return nil }
        return Outline(path: reader.path, viewBox: viewBox, evenOdd: reader.evenOdd)
    }

    /// `outline` scaled to fit `rect`, centred, aspect kept.
    static func path(_ outline: Outline, in rect: CGRect) -> CGPath {
        let box = outline.viewBox
        let scale = min(rect.width / box.width, rect.height / box.height)
        let tx = rect.midX - (box.midX * scale)
        let ty = rect.midY - (box.midY * scale)
        var transform = CGAffineTransform(a: scale, b: 0, c: 0, d: scale, tx: tx, ty: ty)
        return outline.path.copy(using: &transform) ?? outline.path
    }

    private final class Reader: NSObject, XMLParserDelegate {
        let path = CGMutablePath()
        var viewBox: CGRect?
        var evenOdd = false
        /// The transform in force at each open element, root first.
        private var transforms: [CGAffineTransform] = [.identity]
        /// Open elements whose content is not drawn.
        private var hiddenDepth = 0

        private static let hidden: Set<String> = ["defs", "clippath", "mask", "pattern", "symbol", "style", "title", "metadata", "lineargradient", "radialgradient"]

        func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String] = [:]) {
            let element = name.lowercased()
            let inherited = transforms.last ?? .identity
            let own = attributes["transform"].map(Self.transform) ?? .identity
            let current = own.concatenating(inherited)
            transforms.append(current)
            if hiddenDepth > 0 || Self.hidden.contains(element) {
                hiddenDepth += 1
                return
            }
            if element == "svg", viewBox == nil {
                viewBox = Self.viewBox(attributes)
                return
            }
            guard let shape = Self.shape(element, attributes) else { return }
            if attributes["fill-rule"] == "evenodd" || attributes["clip-rule"] == "evenodd" { evenOdd = true }
            let filled = (attributes["fill"] ?? "").lowercased() != "none"
            var transform = current
            if filled {
                path.addPath(shape, transform: transform)
            } else if let width = attributes["stroke-width"].flatMap(Self.number) ?? (attributes["stroke"] != nil ? 1 : nil),
                      let stroke = shape.copy(using: &transform)?.copy(strokingWithWidth: width, lineCap: .round, lineJoin: .round, miterLimit: 4) {
                path.addPath(stroke)
            }
        }

        func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) {
            if hiddenDepth > 0 { hiddenDepth -= 1 }
            if transforms.count > 1 { transforms.removeLast() }
        }

        private static func viewBox(_ attributes: [String: String]) -> CGRect? {
            if let raw = attributes["viewBox"] {
                let values = numbers(raw)
                if values.count == 4, values[2] > 0, values[3] > 0 {
                    return CGRect(x: values[0], y: values[1], width: values[2], height: values[3])
                }
            }
            if let width = attributes["width"].flatMap(number), let height = attributes["height"].flatMap(number), width > 0, height > 0 {
                return CGRect(x: 0, y: 0, width: width, height: height)
            }
            return nil
        }

        private static func shape(_ element: String, _ a: [String: String]) -> CGPath? {
            func value(_ key: String) -> CGFloat { a[key].flatMap(number) ?? 0 }
            switch element {
            case "path":
                guard let d = a["d"] else { return nil }
                var parser = SVGPathParser(d)
                return parser.parse()
            case "rect":
                let rect = CGRect(x: value("x"), y: value("y"), width: value("width"), height: value("height"))
                guard rect.width > 0, rect.height > 0 else { return nil }
                let rx = min(a["rx"].flatMap(number) ?? a["ry"].flatMap(number) ?? 0, rect.width / 2)
                let ry = min(a["ry"].flatMap(number) ?? rx, rect.height / 2)
                return CGPath(roundedRect: rect, cornerWidth: rx, cornerHeight: ry, transform: nil)
            case "circle":
                let r = value("r")
                guard r > 0 else { return nil }
                return CGPath(ellipseIn: CGRect(x: value("cx") - r, y: value("cy") - r, width: 2 * r, height: 2 * r), transform: nil)
            case "ellipse":
                let rx = value("rx"), ry = value("ry")
                guard rx > 0, ry > 0 else { return nil }
                return CGPath(ellipseIn: CGRect(x: value("cx") - rx, y: value("cy") - ry, width: 2 * rx, height: 2 * ry), transform: nil)
            case "polygon", "polyline":
                let values = numbers(a["points"] ?? "")
                guard values.count >= 4 else { return nil }
                let path = CGMutablePath()
                path.move(to: CGPoint(x: values[0], y: values[1]))
                var i = 2
                while i + 1 < values.count {
                    path.addLine(to: CGPoint(x: values[i], y: values[i + 1]))
                    i += 2
                }
                if element == "polygon" { path.closeSubpath() }
                return path
            case "line":
                let path = CGMutablePath()
                path.move(to: CGPoint(x: value("x1"), y: value("y1")))
                path.addLine(to: CGPoint(x: value("x2"), y: value("y2")))
                return path
            default:
                return nil
            }
        }

        /// `translate`, `scale`, `rotate`, `skewX`, `skewY` and `matrix`, in order.
        private static func transform(_ raw: String) -> CGAffineTransform {
            var result = CGAffineTransform.identity
            let pattern = /([a-zA-Z]+)\s*\(([^)]*)\)/
            for match in raw.matches(of: pattern) {
                let v = numbers(String(match.2))
                let step: CGAffineTransform
                switch match.1.lowercased() {
                case "translate": step = CGAffineTransform(translationX: v.first ?? 0, y: v.count > 1 ? v[1] : 0)
                case "scale": step = CGAffineTransform(scaleX: v.first ?? 1, y: v.count > 1 ? v[1] : (v.first ?? 1))
                case "rotate":
                    let angle = (v.first ?? 0) * .pi / 180
                    if v.count >= 3 {
                        step = CGAffineTransform(translationX: v[1], y: v[2]).rotated(by: angle).translatedBy(x: -v[1], y: -v[2])
                    } else {
                        step = CGAffineTransform(rotationAngle: angle)
                    }
                case "skewx": step = CGAffineTransform(a: 1, b: 0, c: tan((v.first ?? 0) * .pi / 180), d: 1, tx: 0, ty: 0)
                case "skewy": step = CGAffineTransform(a: 1, b: tan((v.first ?? 0) * .pi / 180), c: 0, d: 1, tx: 0, ty: 0)
                case "matrix" where v.count == 6: step = CGAffineTransform(a: v[0], b: v[1], c: v[2], d: v[3], tx: v[4], ty: v[5])
                default: step = .identity
                }
                // SVG applies the list left to right onto the shape: the last one first.
                result = step.concatenating(result)
            }
            return result
        }

        private static func number(_ raw: String) -> CGFloat? {
            let trimmed = raw.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "px", with: "")
            return Double(trimmed).map { CGFloat($0) }
        }

        private static func numbers(_ raw: String) -> [CGFloat] {
            raw.split(whereSeparator: { $0 == " " || $0 == "," || $0 == "\n" || $0 == "\t" })
                .compactMap { Double($0).map { CGFloat($0) } }
        }
    }
}
