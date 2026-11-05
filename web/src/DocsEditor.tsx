import { useEffect, useRef } from 'react';
import { Annotation, EditorSelection, EditorState, StateEffect, StateField, type Text } from '@codemirror/state';
import { Decoration, EditorView, keymap, placeholder as placeholderText, WidgetType, type Command, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { tags } from '@lezer/highlight';

/**
 * The Docs body editor on the web (docs/DOCS.md, "Docs on the web"): one
 * pane, the markdown as stored, styled as it is typed. Headings take the
 * reader's sizes, bold and italic read as such, code is monospaced, links
 * and quotes look like links and quotes, and the markup itself stays in the
 * text, muted (iA Writer's model). A textarea cannot style its text, hence
 * CodeMirror. `DocsPage` loads this chunk on the first Edit, so reading a
 * document never fetches it.
 *
 * The font, size and line height are the reader's (`DOCS_READER` and `.md`
 * in styles.css), so Edit and Done move nothing but the markup. Every colour
 * is an app token, so light and dark follow the page.
 *
 * Keys: ⌘B bold, ⌘I italic, ⌘K link (a URL pasted over a selection links it
 * too), Tab and ⇧Tab indent, Enter continues a list or a quote. `[[` offers
 * document titles. An image pasted or dropped uploads while a placeholder
 * holds its place, then lands as `![caption](docs-image:<id>)`.
 */

/** Marks a change the page made (Take theirs, an adopted write) so it is not echoed back as typing. */
const fromPage = Annotation.define<boolean>();

const markupStyle = HighlightStyle.define([
  // Markdown `#` renders as the reader's h2, one step under the title's h1 (document-markdown.tsx).
  { tag: tags.heading1, fontSize: '1.4em', fontWeight: '600', letterSpacing: '-0.01em' },
  { tag: tags.heading2, fontSize: '1.2em', fontWeight: '600', letterSpacing: '-0.01em' },
  { tag: tags.heading3, fontSize: '1.05em', fontWeight: '600' },
  { tag: [tags.heading4, tags.heading5], fontWeight: '600' },
  { tag: tags.heading6, fontSize: '0.85em', fontWeight: '600', color: 'var(--ui-muted-foreground)', letterSpacing: '0.04em', textTransform: 'uppercase' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: '0.875em' },
  { tag: [tags.link, tags.url], color: 'var(--md-link, var(--ui-foreground))', textDecoration: 'underline', textUnderlineOffset: '0.2em' },
  { tag: tags.quote, color: 'var(--ui-muted-foreground)', fontStyle: 'italic' },
  // `#`, `**`, `_`, backticks, `>`, list bullets, brackets: in the text, out of the way.
  { tag: [tags.processingInstruction, tags.labelName, tags.contentSeparator], color: 'var(--ui-muted-foreground)', opacity: '0.75' },
]);

const editorTheme = EditorView.theme({
  '&': { color: 'var(--ui-foreground)', backgroundColor: 'transparent', fontSize: '15px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.6', overflow: 'visible' },
  '.cm-content': { padding: '0', caretColor: 'var(--focus)', minHeight: 'min(60vh, 640px)' },
  '.cm-line': { padding: '0' },
  '.cm-placeholder': { color: 'var(--ui-muted-foreground)' },
  '.cm-docs-upload': { color: 'var(--ui-muted-foreground)', fontStyle: 'italic' },
  '.cm-tooltip': {
    border: '1px solid var(--ui-border)',
    borderRadius: '8px',
    backgroundColor: 'var(--ui-popover)',
    color: 'var(--ui-popover-foreground)',
    boxShadow: '0 8px 24px rgb(0 0 0 / 20%)',
    overflow: 'hidden',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'inherit', fontSize: '13px', maxHeight: '16em' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '4px 10px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--ui-accent)', color: 'var(--ui-accent-foreground)' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '600' },
});

// ---- formatting --------------------------------------------------------------

/** Wrap each selection in `marker`, or take it off when it is already there. */
function toggleMarker(marker: string): Command {
  return (view) => {
    const { state } = view;
    view.dispatch(state.changeByRange((range) => {
      const before = state.sliceDoc(range.from - marker.length, range.from);
      const after = state.sliceDoc(range.to, range.to + marker.length);
      if (before === marker && after === marker) {
        return {
          changes: [{ from: range.from - marker.length, to: range.from }, { from: range.to, to: range.to + marker.length }],
          range: EditorSelection.range(range.from - marker.length, range.to - marker.length),
        };
      }
      return {
        changes: [{ from: range.from, insert: marker }, { from: range.to, insert: marker }],
        range: EditorSelection.range(range.from + marker.length, range.to + marker.length),
      };
    }), { userEvent: 'input.format' });
    return true;
  };
}

const URL_ONLY = /^https?:\/\/\S+$/iu;

/** ⌘K: the selection becomes a link's words with the cursor where the address goes; a selected URL becomes the address. */
const insertLink: Command = (view) => {
  const { state } = view;
  view.dispatch(state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    if (URL_ONLY.test(text)) {
      return { changes: { from: range.from, to: range.to, insert: `[](${text})` }, range: EditorSelection.cursor(range.from + 1) };
    }
    const insert = `[${text}]()`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.empty ? range.from + 1 : range.from + insert.length - 1),
    };
  }), { userEvent: 'input.format' });
  return true;
};

const formatKeymap = keymap.of([
  { key: 'Mod-b', run: toggleMarker('**') },
  { key: 'Mod-i', run: toggleMarker('_') },
  { key: 'Mod-k', run: insertLink },
]);

// ---- image uploads -----------------------------------------------------------

interface Upload { id: number; pos: number; label: string }

const startUpload = StateEffect.define<Upload>({ map: (upload, mapping) => ({ ...upload, pos: mapping.mapPos(upload.pos) }) });
const endUpload = StateEffect.define<number>();

class UploadWidget extends WidgetType {
  constructor(readonly label: string) { super(); }
  override eq(other: UploadWidget): boolean { return other.label === this.label; }
  override toDOM(): HTMLElement {
    const mark = document.createElement('span');
    mark.className = 'cm-docs-upload';
    mark.setAttribute('role', 'status');
    mark.textContent = this.label;
    return mark;
  }
}

/** Placeholders for images on their way up: drawn in the text, never part of it. */
const uploadMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    let next = marks.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(startUpload)) {
        next = next.update({ add: [Decoration.widget({ widget: new UploadWidget(effect.value.label), side: 1, upload: effect.value.id }).range(effect.value.pos)] });
      } else if (effect.is(endUpload)) {
        next = next.update({ filter: (_from, _to, mark) => mark.spec.upload !== effect.value });
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function uploadPosition(view: EditorView, id: number): number | null {
  let at: number | null = null;
  view.state.field(uploadMarks).between(0, view.state.doc.length, (from, _to, mark) => {
    if (mark.spec.upload !== id) return undefined;
    at = from;
    return false;
  });
  return at;
}

/** `text` as a block of its own at `pos`: a blank line either side unless the line is already empty there. */
function asBlock(doc: Text, pos: number, text: string): string {
  const line = doc.lineAt(pos);
  return `${pos > line.from ? '\n\n' : ''}${text}${pos < line.to ? '\n\n' : ''}`;
}

let nextUpload = 0;

// ---- wikilink completion -----------------------------------------------------

function wikilinkCompletion(titles: () => Promise<readonly string[]>) {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const typed = context.matchBefore(/\[\[[^\]|\n]*$/u);
    if (!typed) return null;
    let list: readonly string[];
    try {
      list = await titles();
    } catch {
      return null;
    }
    return {
      from: typed.from + 2,
      validFor: /^[^\]|\n]*$/u,
      options: list.map((title) => ({
        label: title,
        apply: (view: EditorView, _completion: unknown, from: number, to: number) => {
          const closed = view.state.sliceDoc(to, to + 2) === ']]';
          const insert = closed ? title : `${title}]]`;
          view.dispatch({
            changes: { from, to, insert },
            selection: { anchor: from + insert.length + (closed ? 2 : 0) },
            userEvent: 'input.complete',
          });
        },
      })),
    };
  };
}

// ---- the editor --------------------------------------------------------------

/** What the page can ask of the editor once it is drawn. */
export interface DocsEditorHandle {
  /** Put the cursor at the start of a 1-based line and bring it into view (the outline). */
  showLine: (line: number) => void;
}

export interface DocsEditorImages {
  /** Send one image; the answer is the markdown that shows it. */
  upload: (file: File) => Promise<string>;
  /** The placeholder's words while `name` uploads. */
  uploading: (name: string) => string;
  onError: (message: string) => void;
}

export interface DocsEditorProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  autoFocus?: boolean;
  /** The editor is drawn: the page puts its scroll position back and keeps the handle. */
  onReady?: (handle: DocsEditorHandle) => void;
  /** Document titles for `[[`, read on the first one. */
  titles?: () => Promise<readonly string[]>;
  images?: DocsEditorImages;
}

export default function DocsEditor({ value, onChange, label, placeholder, autoFocus = false, onReady, titles, images }: DocsEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const titlesRef = useRef(titles);
  titlesRef.current = titles;

  // One editor for the mount; the value prop only seeds it here.
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;

    function upload(view: EditorView, files: File[], pos: number) {
      const handler = imagesRef.current;
      if (!handler) return;
      for (const file of files) {
        const id = ++nextUpload;
        view.dispatch({ effects: startUpload.of({ id, pos, label: handler.uploading(file.name || 'image') }) });
        handler.upload(file).then(
          (text) => {
            if (view.dom.isConnected === false) return;
            const at = uploadPosition(view, id);
            if (at === null) return;
            view.dispatch({ changes: { from: at, insert: asBlock(view.state.doc, at, text) }, effects: endUpload.of(id), userEvent: 'input.paste' });
          },
          (cause: unknown) => {
            if (view.dom.isConnected === false) return;
            view.dispatch({ effects: endUpload.of(id) });
            handler.onError(cause instanceof Error ? cause.message : String(cause));
          },
        );
      }
    }

    const imageFiles = (list: FileList | null | undefined) => Array.from(list ?? []).filter((file) => file.type.startsWith('image/'));

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          markdown({ base: markdownLanguage }),
          indentUnit.of('  '),
          EditorState.tabSize.of(2),
          EditorView.lineWrapping,
          syntaxHighlighting(markupStyle),
          editorTheme,
          uploadMarks,
          autocompletion({
            override: [wikilinkCompletion(() => titlesRef.current?.() ?? Promise.resolve([]))],
            icons: false,
          }),
          // Before the defaults: ⌘I there selects the syntax parent.
          formatKeymap,
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          ...(placeholder ? [placeholderText(placeholder)] : []),
          EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'true', autocapitalize: 'sentences', autocorrect: 'on' }),
          EditorView.domEventHandlers({
            paste(event, editor) {
              const files = imageFiles(event.clipboardData?.files);
              if (files.length > 0 && imagesRef.current) {
                event.preventDefault();
                upload(editor, files, editor.state.selection.main.head);
                return true;
              }
              // A URL pasted over words links them.
              const pasted = event.clipboardData?.getData('text/plain').trim() ?? '';
              const range = editor.state.selection.main;
              if (!URL_ONLY.test(pasted) || range.empty || editor.state.selection.ranges.length > 1) return false;
              const words = editor.state.sliceDoc(range.from, range.to);
              if (words.includes('\n') || URL_ONLY.test(words)) return false;
              event.preventDefault();
              const insert = `[${words}](${pasted})`;
              editor.dispatch({ changes: { from: range.from, to: range.to, insert }, selection: { anchor: range.from + insert.length }, userEvent: 'input.paste' });
              return true;
            },
            drop(event, editor) {
              const files = imageFiles(event.dataTransfer?.files);
              if (files.length === 0 || !imagesRef.current) return false;
              event.preventDefault();
              const pos = editor.posAtCoords({ x: event.clientX, y: event.clientY }) ?? editor.state.selection.main.head;
              upload(editor, files, pos);
              return true;
            },
          }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            if (update.transactions.some((transaction) => transaction.annotation(fromPage))) return;
            changeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    if (autoFocus) view.focus();
    onReady?.({
      showLine: (line) => {
        const target = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines))).from;
        view.dispatch({ selection: { anchor: target }, effects: EditorView.scrollIntoView(target, { y: 'start', yMargin: 88 }) });
        view.focus();
      },
    });
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Text the page replaced (Take theirs, a write from elsewhere it adopted): the editor follows.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value }, annotations: fromPage.of(true) });
  }, [value]);

  return <div ref={host} className="docs-editor" />;
}
