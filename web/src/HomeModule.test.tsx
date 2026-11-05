import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HomeRowMark, HomeRowUnreadMark } from './HomeModule';

describe('Home row leading marks', () => {
  it('gives the unread dot the same 24px slot as glyph marks', () => {
    const { container } = render(
      <div>
        <HomeRowMark><span aria-hidden="true" /></HomeRowMark>
        <HomeRowUnreadMark />
      </div>,
    );
    const marks = Array.from(container.querySelectorAll('[data-home-mark]'));

    expect(marks).toHaveLength(2);
    expect(marks.every((mark) => mark.classList.contains('size-6'))).toBe(true);
    expect(marks[1].classList.contains('self-center')).toBe(true);
    expect(marks[1].querySelector('span')?.classList.contains('size-2')).toBe(true);
  });
});
