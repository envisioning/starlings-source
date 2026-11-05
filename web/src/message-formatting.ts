/**
 * Edits the Markdown source in a message composer. The browser selection uses
 * UTF-16 offsets, as do textarea selection APIs; this mirrors
 * ThreadMarkdownEditing in Swift so the same action produces the same text
 * on all three clients.
 */
export type MessageFormatAction =
  | 'bold'
  | 'italic'
  | 'strikethrough'
  | 'inlineCode'
  | 'link'
  | 'bulletedList'
  | 'numberedList'
  | 'quote'
  | 'codeBlock';

export interface MessageFormatEdit {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

export function formatMessage(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  action: MessageFormatAction,
): MessageFormatEdit {
  const start = clamp(selectionStart, 0, text.length);
  const end = clamp(selectionEnd, start, text.length);
  const selected = text.slice(start, end);

  switch (action) {
    case 'bold': return wrap(text, start, end, '**', '**', 'bold text');
    case 'italic': return wrap(text, start, end, '*', '*', 'italic text');
    case 'strikethrough': return wrap(text, start, end, '~~', '~~', 'strikethrough');
    case 'inlineCode': return wrap(text, start, end, String.fromCharCode(96), String.fromCharCode(96), 'code');
    case 'link': {
      const label = selected || 'link text';
      const replacement = '[' + label + '](https://example.com)';
      const targetStart = start + ('[' + label + '](').length;
      return {
        text: text.slice(0, start) + replacement + text.slice(end),
        selectionStart: targetStart,
        selectionEnd: targetStart + 'https://example.com'.length,
      };
    }
    case 'bulletedList': return listLines(text, start, end, false);
    case 'numberedList': return listLines(text, start, end, true);
    case 'quote': return prefixLines(text, start, end, '> ');
    case 'codeBlock': {
      const content = selected || 'code';
      const fence = String.fromCharCode(96).repeat(3);
      const replacement = fence + '\n' + content + '\n' + fence;
      return {
        text: text.slice(0, start) + replacement + text.slice(end),
        selectionStart: start + 4,
        selectionEnd: start + 4 + content.length,
      };
    }
  }
}

function wrap(
  text: string,
  start: number,
  end: number,
  prefix: string,
  suffix: string,
  placeholder: string,
): MessageFormatEdit {
  const selected = text.slice(start, end);
  if (selected && start >= prefix.length && end + suffix.length <= text.length
      && text.slice(start - prefix.length, start) === prefix
      && text.slice(end, end + suffix.length) === suffix) {
    return {
      text: text.slice(0, start - prefix.length) + selected + text.slice(end + suffix.length),
      selectionStart: start - prefix.length,
      selectionEnd: end - prefix.length,
    };
  }
  const content = selected || placeholder;
  return {
    text: text.slice(0, start) + prefix + content + suffix + text.slice(end),
    selectionStart: start + prefix.length,
    selectionEnd: start + prefix.length + content.length,
  };
}

function prefixLines(text: string, selectionStart: number, selectionEnd: number, marker: string): MessageFormatEdit {
  const start = lineStart(text, selectionStart);
  const last = selectionEnd > selectionStart ? selectionEnd - 1 : selectionStart;
  let end = last;
  while (end < text.length && text[end] !== '\n') end += 1;
  if (end < text.length) end += 1;
  const original = text.slice(start, end);
  const lines = original.split('\n');
  const emptyLine = selectionStart === selectionEnd && lines[0] === '';
  const nonempty = lines.map((line, index) => line ? index : -1).filter(index => index >= 0);
  const alreadyFormatted = nonempty.length > 0 && nonempty.every(index => lines[index]!.startsWith(marker));
  if (emptyLine) {
    lines[0] = marker;
  } else {
    for (const index of nonempty) {
      const line = lines[index]!;
      lines[index] = alreadyFormatted ? line.slice(marker.length) : marker + line;
    }
  }
  const replacement = lines.join('\n');
  const updated = text.slice(0, start) + replacement + text.slice(end);
  if (selectionStart === selectionEnd) {
    const caret = Math.max(start, selectionStart + (alreadyFormatted ? -marker.length : marker.length));
    return { text: updated, selectionStart: caret, selectionEnd: caret };
  }
  return { text: updated, selectionStart: start, selectionEnd: start + replacement.length };
}

function listLines(text: string, selectionStart: number, selectionEnd: number, numbered: boolean): MessageFormatEdit {
  const start = lineStart(text, selectionStart);
  const last = selectionEnd > selectionStart ? selectionEnd - 1 : selectionStart;
  let end = last;
  while (end < text.length && text[end] !== '\n') end += 1;
  if (end < text.length) end += 1;
  const original = text.slice(start, end);
  const lines = original.split('\n');
  const emptyLine = selectionStart === selectionEnd && lines[0] === '';
  const nonempty = lines.map((line, index) => line ? index : -1).filter(index => index >= 0);
  const alreadyFormatted = nonempty.length > 0 && nonempty.every(index => (
    numbered ? orderedPrefix(lines[index]!) : bulletPrefix(lines[index]!)
  ) !== '');
  const targetPrefix = numbered ? '1. ' : '- ';

  if (emptyLine) {
    lines[0] = targetPrefix;
  } else {
    let item = 0;
    for (const index of nonempty) {
      let content = lines[index]!;
      if (alreadyFormatted) {
        const prefix = numbered ? orderedPrefix(content) : bulletPrefix(content);
        if (prefix) content = content.slice(prefix.length);
      } else {
        const prefix = bulletPrefix(content) || orderedPrefix(content);
        if (prefix) content = content.slice(prefix.length);
        content = numbered ? `${++item}. ${content}` : `- ${content}`;
      }
      lines[index] = content;
    }
  }

  const replacement = lines.join('\n');
  const updated = text.slice(0, start) + replacement + text.slice(end);
  if (selectionStart !== selectionEnd) {
    return { text: updated, selectionStart: start, selectionEnd: start + replacement.length };
  }

  const relative = selectionStart - start;
  const caretLine = text.slice(start, selectionStart).split('\n').length - 1;
  const currentLine = original.split('\n')[caretLine] ?? '';
  const currentPrefix = bulletPrefix(currentLine) || orderedPrefix(currentLine);
  const caret = emptyLine ? selectionStart + targetPrefix.length
      : alreadyFormatted ? Math.max(start, selectionStart - currentPrefix.length)
        : relative <= currentPrefix.length ? start + targetPrefix.length
        : selectionStart + targetPrefix.length - currentPrefix.length;
  return { text: updated, selectionStart: caret, selectionEnd: caret };
}

function bulletPrefix(line: string): string {
  return /^[-*+] /u.exec(line)?.[0] ?? '';
}

function orderedPrefix(line: string): string {
  return /^\d+[.)] /u.exec(line)?.[0] ?? '';
}

function lineStart(text: string, offset: number): number {
  const newline = text.lastIndexOf('\n', Math.max(0, offset - 1));
  return newline < 0 ? 0 : newline + 1;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
