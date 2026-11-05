import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { capabilityById } from '@starlings/contracts/capabilities';
import { PUBLIC_PAGES } from '../../agent-surface';
import { registryMarkdown } from './page-markdown';
import { USE_CASES, DEMO_PROJECTS, DEMO_NOTICE, INITIAL_DEMO, answerDemo, draftRows, questionProjection, sourceRecords, useCaseHref } from './use-cases';
import { UseCaseSim } from './sim/UseCaseSim';

// The drawn window is inert; visitors operate only the controls outside it.
vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
afterEach(cleanup);

describe('use-case examples', () => {
  it('has a discovered HTML and Markdown route for each job, grounded in built capabilities', () => {
    for (const job of USE_CASES) {
      expect(PUBLIC_PAGES.find((page) => page.path === useCaseHref(job))?.props).toEqual({ slug: job.slug });
      for (const id of job.capabilities) {
        const row = capabilityById(id)!;
        expect(['have', 'partial']).toContain(row.intent);
        expect(Object.values(row.surfaces ?? {})).toContain('works');
      }
      const markdown = registryMarkdown(useCaseHref(job), 'https://site.example')!;
      expect(markdown).toContain(DEMO_NOTICE);
      expect(markdown).toContain(job.prompt);
      expect(markdown).toContain(job.review);
      for (const project of DEMO_PROJECTS) {
        for (const source of sourceRecords(project)) expect(markdown).toContain(source.body);
        for (const row of draftRows(job, project)) expect(markdown).toContain(row.text);
      }
    }
  });

  it('derives drafts from the selected project and cites records that exist', () => {
    for (const job of USE_CASES.filter((entry) => entry.slug !== 'agent-needs-an-answer')) {
      const first = draftRows(job, DEMO_PROJECTS[0]);
      const second = draftRows(job, DEMO_PROJECTS[1]);
      expect(second).not.toEqual(first);
      for (const row of first) if (row.source) expect(sourceRecords(DEMO_PROJECTS[0]).some((source) => source.id === row.source)).toBe(true);
      expect(second.map((row) => row.text).join(' ')).not.toContain(DEMO_PROJECTS[0].goal);
    }
  });

  it('keeps one winning human answer, rather than reopening a resolved request', () => {
    const answered = answerDemo(INITIAL_DEMO, 1);
    expect(questionProjection(answered)).toEqual({ pending: false, answer: 'Managers' });
    expect(answerDemo(answered, 0)).toBe(answered);
    expect(answerDemo(INITIAL_DEMO, 9)).toBe(INITIAL_DEMO);
  });

  it('resolves both sample views and resets on a different project', () => {
    render(<UseCaseSim job={USE_CASES[5]} />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Managers' }));
    expect(screen.getByText('Answered · Managers')).toBeTruthy();
    expect(screen.getByText('No pending questions')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Staff' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Sample project'), { target: { value: DEMO_PROJECTS[1].id } });
    expect(screen.queryByText('Answered · Managers')).toBeNull();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Draft' }));
    expect(screen.getByRole('button', { name: 'Staff' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getAllByText(DEMO_PROJECTS[1].owner)).toHaveLength(2);
  });
});
