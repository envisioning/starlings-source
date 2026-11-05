import SwiftUI

/// A title-shaped `TextField(…, axis: .vertical)`: it wraps once the text
/// outgrows the row's width, but it is one line of *content* — Return
/// submits instead of breaking the line, and a pasted newline is folded
/// into a space.
struct StarlingsSingleLineField: ViewModifier {
    @Binding var text: String
    var onSubmit: (() -> Void)?

    func body(content: Content) -> some View {
        content
            .submitLabel(.done)
            .onChange(of: text) { _, value in
                guard value.contains(where: \.isNewline) else { return }
                // A vertical-axis TextField never fires onSubmit: Return
                // arrives as a "\n" typed at the end. That is a submit; a
                // newline anywhere else is a paste and folds to a space.
                if let onSubmit, value.last?.isNewline == true,
                   !value.dropLast().contains(where: \.isNewline) {
                    text = String(value.dropLast())
                    onSubmit()
                    return
                }
                text = value.split(whereSeparator: \.isNewline).joined(separator: " ")
            }
    }
}

extension View {
    func meetSingleLine(_ text: Binding<String>, onSubmit: (() -> Void)? = nil) -> some View {
        modifier(StarlingsSingleLineField(text: text, onSubmit: onSubmit))
    }
}
