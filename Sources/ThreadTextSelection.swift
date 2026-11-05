import AppKit

/// Text selection that spans a whole transcript rather than one message.
///
/// A chat is read as a conversation and quoted as a conversation, so selection
/// has to cross rows: the AppKit default — a selectable `NSTextField` per
/// message — gives system-blue highlight inside a single label and stops at its
/// edge, which is exactly the two complaints this file answers. Each message
/// body is drawn by `ThreadSelectableTextView` (its own TextKit stack, so the
/// character under the pointer and the rectangles behind the selection are
/// both exact), and one `ThreadTextSelectionController` per pane owns the
/// anchor and focus across all of them.
@MainActor
final class ThreadTextSelectionController {
    /// The view selection is measured in — the transcript's document view.
    /// Drag events keep going to whichever text view took the mouse down, so
    /// every point is converted here before it is resolved back to a row.
    weak var container: NSView?

    private var anchorView: ThreadSelectableTextView?
    private var anchorIndex = 0
    private var focusView: ThreadSelectableTextView?
    private var focusIndex = 0
    /// Fixed for the duration of a drag: the transcript does not change shape
    /// mid-gesture, and walking the tree on every mouse-moved event would.
    private var orderedDuringDrag: [ThreadSelectableTextView]?

    var hasSelection: Bool {
        guard let anchorView, let focusView else { return false }
        return anchorView !== focusView || anchorIndex != focusIndex
    }

    // MARK: - Gestures

    func begin(in view: ThreadSelectableTextView, at point: NSPoint, clickCount: Int) {
        orderedDuringDrag = orderedViews()
        switch clickCount {
        case 2:
            let word = view.wordRange(at: view.characterIndex(at: point, rounding: false))
            anchorView = view
            focusView = view
            anchorIndex = word.location
            focusIndex = word.location + word.length
        case 3...:
            anchorView = view
            focusView = view
            anchorIndex = 0
            focusIndex = view.textLength
        default:
            let index = view.characterIndex(at: point)
            anchorView = view
            focusView = view
            anchorIndex = index
            focusIndex = index
        }
        apply()
    }

    /// Extend to a point given in `container` coordinates. Past the last row,
    /// or in the gap between two, the nearest row's near edge is used — the
    /// same forgiveness every other text view on the Mac gives a fast drag.
    func extend(toContainerPoint point: NSPoint) {
        guard let container, let target = resolve(point, in: container) else { return }
        focusView = target.view
        focusIndex = target.index
        apply()
    }

    func endDrag() {
        orderedDuringDrag = nil
    }

    func clear() {
        for view in orderedViews() { view.selectedRange = nil }
        anchorView = nil
        focusView = nil
        orderedDuringDrag = nil
    }

    func selectAll() {
        let views = orderedViews()
        guard let first = views.first, let last = views.last else { return }
        orderedDuringDrag = views
        anchorView = first
        anchorIndex = 0
        focusView = last
        focusIndex = last.textLength
        apply()
        orderedDuringDrag = nil
    }

    // MARK: - Result

    /// The selection as text, rows joined by newlines. Only rows that actually
    /// contributed characters appear, so a drag that grazes the top of a
    /// message does not paste a blank line for it.
    func selectedText() -> String {
        orderedViews()
            .compactMap { view -> String? in
                guard let range = view.selectedRange, range.length > 0 else { return nil }
                return view.substring(range)
            }
            .joined(separator: "\n")
    }

    @discardableResult
    func copyToPasteboard() -> Bool {
        let text = selectedText()
        guard !text.isEmpty else { return false }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        return true
    }

    // MARK: - Plumbing

    private func orderedViews() -> [ThreadSelectableTextView] {
        if let orderedDuringDrag { return orderedDuringDrag }
        guard let container else { return [] }
        var found: [ThreadSelectableTextView] = []
        collect(from: container, into: &found)
        return found
    }

    /// Depth-first over the subview tree, which is document order: the stack
    /// adds rows top to bottom and each row builds its column the same way.
    private func collect(from view: NSView, into found: inout [ThreadSelectableTextView]) {
        for subview in view.subviews {
            if let text = subview as? ThreadSelectableTextView {
                found.append(text)
            } else {
                collect(from: subview, into: &found)
            }
        }
    }

    private func resolve(
        _ point: NSPoint,
        in container: NSView
    ) -> (view: ThreadSelectableTextView, index: Int)? {
        let views = orderedViews()
        guard !views.isEmpty else { return nil }
        var nearest: (view: ThreadSelectableTextView, frame: NSRect, distance: CGFloat)?
        for view in views {
            let frame = view.convert(view.bounds, to: container)
            if point.y >= frame.minY, point.y <= frame.maxY {
                return (view, view.characterIndex(at: container.convert(point, to: view)))
            }
            let distance = min(abs(point.y - frame.minY), abs(point.y - frame.maxY))
            if nearest == nil || distance < nearest!.distance {
                nearest = (view, frame, distance)
            }
        }
        guard let nearest else { return nil }
        // "Before" is up the transcript, which is smaller y in a flipped
        // container and larger y in an unflipped one.
        let isBefore = container.isFlipped
            ? point.y < nearest.frame.minY
            : point.y > nearest.frame.maxY
        return (nearest.view, isBefore ? 0 : nearest.view.textLength)
    }

    private func apply() {
        guard let anchorView, let focusView else { return }
        let views = orderedViews()
        guard
            let anchorPosition = views.firstIndex(where: { $0 === anchorView }),
            let focusPosition = views.firstIndex(where: { $0 === focusView })
        else { return }

        let forward = anchorPosition < focusPosition
            || (anchorPosition == focusPosition && anchorIndex <= focusIndex)
        let low = forward ? (anchorPosition, anchorIndex) : (focusPosition, focusIndex)
        let high = forward ? (focusPosition, focusIndex) : (anchorPosition, anchorIndex)

        for (position, view) in views.enumerated() {
            if position < low.0 || position > high.0 {
                view.selectedRange = nil
            } else if low.0 == high.0 {
                view.selectedRange = NSRange(location: low.1, length: high.1 - low.1)
            } else if position == low.0 {
                view.selectedRange = NSRange(location: low.1, length: view.textLength - low.1)
            } else if position == high.0 {
                view.selectedRange = NSRange(location: 0, length: high.1)
            } else {
                view.selectedRange = NSRange(location: 0, length: view.textLength)
            }
        }
    }
}

/// One run of transcript text, drawn by TextKit so the pane can select it.
///
/// A wrapping `NSTextField` cannot answer "which character is under this
/// point" or "where would the highlight go" without a parallel layout that
/// disagrees with the one the cell actually used. Owning the layout manager
/// removes the disagreement, and it is what makes the selection colour ours
/// rather than the system's blue.
@MainActor
final class ThreadSelectableTextView: NSView {
    private let storage = NSTextStorage()
    private let layoutManager = NSLayoutManager()
    private let container = NSTextContainer()

    weak var selectionController: ThreadTextSelectionController?

    var selectedRange: NSRange? {
        didSet {
            guard selectedRange != oldValue else { return }
            applySelectionInk()
            needsDisplay = true
        }
    }

    var textLength: Int { storage.length }

    /// How wide this run may get before it wraps, or `nil` for "as wide as the
    /// view is given".
    ///
    /// A bubble has to hug its words, and a view with no intrinsic width can
    /// only fill whatever Auto Layout hands it — which is how every bubble
    /// ends up the same width regardless of what it says. With a maximum set,
    /// the view reports the narrower of the text's own ideal width and this,
    /// and hugs it. Event rows and anything else that wants a column leave it
    /// nil and are unchanged.
    var maximumWidth: CGFloat? {
        didSet {
            guard maximumWidth != oldValue else { return }
            setContentHuggingPriority(maximumWidth == nil ? .defaultLow : .required, for: .horizontal)
            invalidateIntrinsicContentSize()
        }
    }

    /// What the row says with its formatting taken off — the accessibility line
    /// and any other reader that wants words rather than Markdown.
    var plainText: String { storage.string }

    /// True while the pointer went down and moved: a drag selects, a click on a
    /// link opens it, and without this every selection ending on a link would
    /// also open a browser.
    private var dragged = false

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }

    init(text: String, font: NSFont, color: NSColor) {
        super.init(frame: .zero)
        prepare()
        setText(text, font: font, color: color)
    }

    /// The one message bodies use: `ThreadMarkdownAppKit` has already turned
    /// the Markdown into runs, links included.
    init(attributed: NSAttributedString) {
        super.init(frame: .zero)
        prepare()
        setAttributed(attributed)
    }

    private func prepare() {
        container.lineFragmentPadding = 0
        container.widthTracksTextView = false
        layoutManager.addTextContainer(container)
        storage.addLayoutManager(layoutManager)
        setContentCompressionResistancePriority(.required, for: .vertical)
        setContentHuggingPriority(.required, for: .vertical)
        // **A bubble is not allowed to set a floor under its column.** A
        // pasted URL is one unbreakable token, so `idealWidth()` can be wider
        // than the whole transcript. At the default 750 that beats the split
        // view's own priorities, and the middle column then refuses to give
        // width back to the inspector — the clipped inspector in issue #22.
        // Too long for the column now means clipped, not wider.
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setText(_ text: String, font: NSFont, color: NSColor) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byWordWrapping
        storage.setAttributedString(NSAttributedString(
            string: text,
            attributes: [
                .font: font,
                .foregroundColor: color,
                .paragraphStyle: paragraph,
            ]
        ))
        selectedRange = nil
        invalidateIntrinsicContentSize()
        needsDisplay = true
    }

    /// Where a link lives once it is in this view. `NSLayoutManager` paints
    /// every `.link` run in the system's blue whatever colour the run carries
    /// — `linkTextAttributes` is an `NSTextView` setting, and there is no text
    /// view here. So the URL moves to a key AppKit does not recognise: the run
    /// keeps the accent it was given, and `link(at:)` and the cursor rects
    /// read this key instead.
    static let linkAttribute = NSAttributedString.Key("meet.link")

    func setAttributed(_ string: NSAttributedString) {
        let relinked = NSMutableAttributedString(attributedString: string)
        relinked.enumerateAttribute(.link, in: NSRange(location: 0, length: relinked.length)) { value, range, _ in
            guard let value else { return }
            relinked.removeAttribute(.link, range: range)
            relinked.addAttribute(Self.linkAttribute, value: value, range: range)
        }
        storage.setAttributedString(relinked)
        selectedRange = nil
        invalidateIntrinsicContentSize()
        needsDisplay = true
        window?.invalidateCursorRects(for: self)
    }

    func substring(_ range: NSRange) -> String {
        let clamped = NSRange(
            location: min(range.location, storage.length),
            length: min(range.length, max(0, storage.length - min(range.location, storage.length)))
        )
        return (storage.string as NSString).substring(with: clamped)
    }

    /// Caret index for a point: the nearest insertion point, so a drag that
    /// ends past the middle of a glyph includes it. `rounding: false` gives the
    /// character actually under the pointer, which is what word selection wants.
    func characterIndex(at point: NSPoint, rounding: Bool = true) -> Int {
        guard storage.length > 0 else { return 0 }
        ensureLayout()
        var fraction: CGFloat = 0
        let index = layoutManager.characterIndex(
            for: point,
            in: container,
            fractionOfDistanceBetweenInsertionPoints: &fraction
        )
        guard rounding else { return min(index, max(0, storage.length - 1)) }
        return min(storage.length, fraction > 0.5 ? index + 1 : index)
    }

    func wordRange(at index: Int) -> NSRange {
        guard storage.length > 0 else { return NSRange(location: 0, length: 0) }
        return storage.doubleClick(at: min(index, storage.length - 1))
    }

    // MARK: - Layout

    override func layout() {
        super.layout()
        // A hugging run already sized its own container in `intrinsicContentSize`.
        if maximumWidth == nil, container.size.width != bounds.width {
            container.size = NSSize(width: bounds.width, height: .greatestFiniteMagnitude)
            invalidateIntrinsicContentSize()
            // The link rectangles moved with the reflow.
            window?.invalidateCursorRects(for: self)
        }
    }

    override var intrinsicContentSize: NSSize {
        if let maximumWidth {
            guard storage.length > 0 else { return NSSize(width: 0, height: 17) }
            let width = min(idealWidth(), max(1, maximumWidth))
            container.size = NSSize(width: width, height: .greatestFiniteMagnitude)
            layoutManager.ensureLayout(for: container)
            return NSSize(width: ceil(width), height: ceil(layoutManager.usedRect(for: container).height))
        }
        guard bounds.width > 0, storage.length > 0 else {
            return NSSize(width: NSView.noIntrinsicMetric, height: bounds.width > 0 ? 0 : 17)
        }
        ensureLayout()
        return NSSize(
            width: NSView.noIntrinsicMetric,
            height: ceil(layoutManager.usedRect(for: container).height)
        )
    }

    /// The width this text would take if nothing wrapped it — the longest line,
    /// since a message keeps the newlines somebody typed.
    private func idealWidth() -> CGFloat {
        container.size = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        layoutManager.ensureLayout(for: container)
        return ceil(layoutManager.usedRect(for: container).width)
    }

    /// Aligning a timestamp to the first line of a message needs a baseline,
    /// and a plain `NSView` reports none.
    override var firstBaselineOffsetFromTop: CGFloat {
        guard storage.length > 0 else { return 0 }
        ensureLayout()
        let fragment = layoutManager.lineFragmentRect(forGlyphAt: 0, effectiveRange: nil)
        return fragment.minY + layoutManager.location(forGlyphAt: 0).y
    }

    override func draw(_ dirtyRect: NSRect) {
        ensureLayout()
        let glyphs = layoutManager.glyphRange(for: container)
        // Inline code carries a background attribute, and nothing else draws it.
        layoutManager.drawBackground(forGlyphRange: glyphs, at: .zero)
        if let selectedRange, selectedRange.length > 0 {
            let selectedGlyphs = layoutManager.glyphRange(
                forCharacterRange: selectedRange,
                actualCharacterRange: nil
            )
            StarlingsColors.accent.setFill()
            layoutManager.enumerateEnclosingRects(
                forGlyphRange: selectedGlyphs,
                withinSelectedGlyphRange: selectedGlyphs,
                in: container
            ) { rect, _ in
                NSBezierPath(roundedRect: rect.insetBy(dx: 0, dy: -0.5), xRadius: 2, yRadius: 2).fill()
            }
        }
        layoutManager.drawGlyphs(forGlyphRange: glyphs, at: .zero)
    }

    private func ensureLayout() {
        if maximumWidth == nil, container.size.width != bounds.width, bounds.width > 0 {
            container.size = NSSize(width: bounds.width, height: .greatestFiniteMagnitude)
        }
        layoutManager.ensureLayout(for: container)
    }

    /// Black ink on the lime block. Temporary attributes rather than a second
    /// draw pass, so the selected run keeps its own font and wrapping.
    private func applySelectionInk() {
        let full = NSRange(location: 0, length: storage.length)
        layoutManager.removeTemporaryAttribute(.foregroundColor, forCharacterRange: full)
        guard let selectedRange, selectedRange.length > 0 else { return }
        layoutManager.addTemporaryAttributes(
            [.foregroundColor: StarlingsColors.accentInk],
            forCharacterRange: selectedRange
        )
    }

    // MARK: - Mouse

    // hover: drives text selection, not a control
    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        dragged = false
        let point = convert(event.locationInWindow, from: nil)
        selectionController?.begin(in: self, at: point, clickCount: event.clickCount)
    }

    override func mouseDragged(with event: NSEvent) {
        guard let controller = selectionController, let container = controller.container else { return }
        dragged = true
        autoscroll(with: event)
        let point = container.convert(event.locationInWindow, from: nil)
        controller.extend(toContainerPoint: point)
    }

    override func mouseUp(with event: NSEvent) {
        selectionController?.endDrag()
        guard !dragged, event.clickCount == 1 else { return }
        guard let url = link(at: convert(event.locationInWindow, from: nil)) else { return }
        // A click that opens something is not a selection, and leaving the
        // caret behind on the link looks like the click did two things.
        selectionController?.clear()
        NSWorkspace.shared.open(url)
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .iBeam)
        // A hand only over the linked runs: an i-beam everywhere else is what
        // says the rest of the message is text you can quote.
        for rect in linkRects() { addCursorRect(rect, cursor: .pointingHand) }
    }

    /// The URL under a point, or nil. The glyph's own rectangle has to contain
    /// the point — `characterIndex` answers with the nearest character however
    /// far away it is, which would make the whitespace after a link clickable.
    private func link(at point: NSPoint) -> URL? {
        guard storage.length > 0 else { return nil }
        ensureLayout()
        let index = characterIndex(at: point, rounding: false)
        guard index < storage.length else { return nil }
        guard let url = storage.attribute(Self.linkAttribute, at: index, effectiveRange: nil) as? URL else { return nil }
        let glyphs = layoutManager.glyphRange(forCharacterRange: NSRange(location: index, length: 1), actualCharacterRange: nil)
        guard layoutManager.boundingRect(forGlyphRange: glyphs, in: container).contains(point) else { return nil }
        return url
    }

    private func linkRects() -> [NSRect] {
        guard storage.length > 0, bounds.width > 0 else { return [] }
        ensureLayout()
        var rects: [NSRect] = []
        storage.enumerateAttribute(Self.linkAttribute, in: NSRange(location: 0, length: storage.length)) { value, range, _ in
            guard value != nil else { return }
            let glyphs = layoutManager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
            layoutManager.enumerateEnclosingRects(
                forGlyphRange: glyphs,
                withinSelectedGlyphRange: glyphs,
                in: container
            ) { rect, _ in rects.append(rect) }
        }
        return rects
    }

    // MARK: - Responder actions

    /// The Edit menu's `copy:` and `selectAll:` land here once a drag has made
    /// this row first responder; the controller answers for the whole
    /// transcript, so ⌘C copies every row the selection touched.
    @objc func copy(_ sender: Any?) {
        selectionController?.copyToPasteboard()
    }

    override func selectAll(_ sender: Any?) {
        selectionController?.selectAll()
    }
}

extension ThreadSelectableTextView: NSMenuItemValidation {
    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        switch menuItem.action {
        case #selector(copy(_:)):
            return selectionController?.hasSelection ?? false
        case #selector(selectAll(_:)):
            return true
        default:
            return true
        }
    }
}
