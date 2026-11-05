import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TentpoleMini, TentpoleShowcase } from './TentpoleShowcase';
import { TENTPOLES } from './features';
import { FeaturesPage } from './FeaturesPage';
import { registryMarkdown } from './page-markdown';

vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} }); window.history.replaceState(null, '', '/'); });

/** The caption's hidden copies only reserve its height (SimCaption). */
const VISIBLE_ONLY = '[aria-hidden="true"], script, style';

describe('tentpole presentation', () => {
  it('links to the capability library instead of holding it', () => {
    render(<FeaturesPage />);
    expect(document.getElementById('all-capabilities')).toBeNull();
    expect(screen.getByRole('link', { name: /Explore all capabilities/u }).getAttribute('href')).toBe('/workspace/capabilities');
  });

  it('sends an old feature permalink on /workspace to the library page', () => {
    const replace = vi.fn();
    vi.stubGlobal('location', { ...window.location, hash: '#feature-docs', replace });
    render(<FeaturesPage />);
    expect(replace).toHaveBeenCalledWith('/workspace/capabilities#feature-docs');
    vi.unstubAllGlobals();
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  });

  it('keeps an opened question pending and resolves chat and Inbox together on a human answer', () => {
    const entry = TENTPOLES[0];
    render(<TentpoleMini entry={entry} />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Opened' }));
    expect(screen.getAllByText('Which audience should the proposal address?')).toHaveLength(2);
    expect(screen.getByText('Opened · still waiting for your answer')).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Answered' }));
    expect(screen.getByText('Answered: client team')).toBeTruthy();
    expect(screen.getByText('No pending questions')).toBeTruthy();
    expect(screen.getByText(entry.captions[2], { ignore: VISIBLE_ONLY })).toBeTruthy();
  });

  it('waits for explicit playback with reduced motion and never auto-answers', () => {
    vi.useFakeTimers();
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true, addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList);
    vi.stubGlobal('IntersectionObserver', class {
      constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
      observe() { this.callback([{ isIntersecting: true }]); }
      disconnect() {}
    });
    render(<TentpoleMini entry={TENTPOLES[0]} />);
    act(() => vi.advanceTimersByTime(10000));
    expect(screen.queryByText('Opened · still waiting for your answer')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Play from the start' }));
    act(() => vi.advanceTimersByTime(3200));
    expect(screen.getByText('Opened · still waiting for your answer')).toBeTruthy();
    // The tour stops at Opened: it never answers for the visitor.
    act(() => vi.advanceTimersByTime(20000));
    expect(screen.queryByText('No pending questions')).toBeNull();
  });

  it('draws each idea on its own surface, in its own tone', () => {
    render(<TentpoleShowcase />);
    const surfaces = { attention: 'Inbox', memory: 'Proposal draft', record: 'Transcript', agents: 'To do' } as const;
    for (const entry of TENTPOLES) {
      const article = document.getElementById(`tentpole-${entry.id}`)!;
      expect(article.style.getPropertyValue('--tone')).toBe(`var(--tent-${entry.id})`);
      expect(within(article).getAllByText(surfaces[entry.id]).length).toBeGreaterThan(0);
    }
  });

  it('gives each distinctive idea an independently steered scene and the same account in the feature twin', () => {
    render(<TentpoleShowcase />);
    const markdown = registryMarkdown('/workspace', 'https://site.example')!;
    for (const entry of TENTPOLES) {
      const article = document.getElementById(`tentpole-${entry.id}`)!;
      fireEvent.mouseDown(within(article).getByRole('tab', { name: entry.steps[2] }));
      expect(within(article).getByText(entry.captions[2], { ignore: VISIBLE_ONLY })).toBeTruthy();
      expect(within(article).getByRole('link').getAttribute('href')).toContain(`#feature-${entry.feature}`);
      expect(markdown).toContain(entry.title);
      expect(markdown).toContain(entry.headline);
      expect(markdown).toContain(entry.summary);
      expect(markdown).toContain(entry.captions[2]);
      expect(markdown).toContain(entry.scope);
    }
  });
});
