import { describe, expect, it } from 'vitest';
import { plainPreview } from './markdown-parse';

describe('plainPreview', () => {
  it('drops marks and collapses lines', () => {
    expect(plainPreview('Building **Biomolecule Watermarking** now — the `general` technique\n\n- see [notes](https://example.com)  here'))
      .toBe('Building Biomolecule Watermarking now — the general technique • see notes here');
  });
  it('keeps a literal asterisk', () => {
    expect(plainPreview('2 * 3 = 6')).toBe('2 * 3 = 6');
  });
});
