/// The one glyph rule for a meeting across the widgets: a call is a camera,
/// an in-person meeting is a pin. Both the Live Activity and the Home widget
/// read it, so the two never disagree.
enum StarlingsGlyphMark {
    static func meeting(isVideo: Bool) -> String {
        isVideo ? "video.fill" : "mappin.and.ellipse"
    }
}
