import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchablePicker } from './SearchablePicker';
import type { SearchablePickerOption } from './searchable-picker';

const OPTIONS: SearchablePickerOption[] = [
  { id: 'project:star', title: 'Zeta Labs', context: 'Project', isStarred: true },
  { id: 'project:a', title: 'Acme Rollout', context: 'Project' },
  { id: 'lead:b', title: 'Bolt Café', context: 'Lead', subtitle: 'Berlin' },
  { id: 'partner:c', title: 'Cobalt', context: 'Partner' },
];

function Harness({ initial = '', onChange = () => {}, options = OPTIONS, onSearch }: {
  initial?: string;
  onChange?: (value: string) => void;
  options?: SearchablePickerOption[];
  onSearch?: (query: string) => Promise<SearchablePickerOption[]>;
}) {
  const [value, setValue] = useState(initial);
  return (
    <SearchablePicker
      label="File under"
      placeholder="Choose a project"
      options={options}
      value={value}
      onChange={(next) => { setValue(next); onChange(next); }}
      emptyMessage="No destinations match that search."
      onSearch={onSearch}
    />
  );
}

function trigger(): HTMLElement {
  return screen.getByRole('combobox', { name: /^File under,/ });
}

function open(): HTMLElement {
  fireEvent.click(trigger());
  return searchField();
}

function searchField(): HTMLInputElement {
  // cmdk labels its input from the Command's own (empty) label, so it is found by its slot.
  const field = document.querySelector<HTMLInputElement>('[data-slot="command-input"]');
  if (!field) throw new Error('The search field is not open.');
  return field;
}

function optionTitles(): string[] {
  return screen.queryAllByRole('option').map((option) => option.textContent ?? '');
}

describe('SearchablePicker', () => {
  beforeEach(() => {
    // cmdk scrolls the highlighted row into view; jsdom lays nothing out.
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
  });

  afterEach(() => {
    delete (HTMLElement.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView;
  });

  it('lists the options in the order given, starred first, with their type', () => {
    render(<Harness />);
    open();
    expect(optionTitles()).toEqual([
      'Project · Zeta Labs',
      'Project · Acme Rollout',
      'Lead · Bolt Café',
      'Partner · Cobalt',
    ]);
    expect(screen.getAllByLabelText('Starred')).toHaveLength(1);
  });

  it('filters locally on title, type and subtitle, folding case and accents', () => {
    render(<Harness />);
    const search = open();
    fireEvent.change(search, { target: { value: 'cafe' } });
    expect(optionTitles()).toEqual(['Lead · Bolt Café']);
    fireEvent.change(search, { target: { value: 'PARTNER' } });
    expect(optionTitles()).toEqual(['Partner · Cobalt']);
    fireEvent.change(search, { target: { value: 'berlin' } });
    expect(optionTitles()).toEqual(['Lead · Bolt Café']);
  });

  it('shows the no-results message when nothing matches', () => {
    render(<Harness />);
    const search = open();
    fireEvent.change(search, { target: { value: 'nothing like this' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No destinations match that search.')).toBeTruthy();
  });

  it('selects with a click, closes, and names the choice on the trigger', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    open();
    fireEvent.click(screen.getByRole('option', { name: /Cobalt/ }));
    expect(onChange).toHaveBeenCalledWith('partner:c');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger().getAttribute('aria-label')).toBe('File under, Partner · Cobalt');
  });

  it('moves with the arrow keys and selects with Enter', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const search = open();
    const first = screen.getAllByRole('option')[0];
    expect(first.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    const second = screen.getAllByRole('option')[1];
    expect(second.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('project:a');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('closes on Escape without changing the choice, and gives focus back to the trigger', async () => {
    const onChange = vi.fn();
    render(<Harness initial="lead:b" onChange={onChange} />);
    const search = open();
    await waitFor(() => expect(document.activeElement).toBe(search));
    fireEvent.change(search, { target: { value: 'zeta' } });
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger().getAttribute('aria-label')).toBe('File under, Lead · Bolt Café');
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
    // The next open starts from the full list, not the abandoned query.
    open();
    expect(searchField().value).toBe('');
    expect(optionTitles()).toHaveLength(4);
  });

  it('keeps the selected id while a filter hides it', () => {
    render(<Harness initial="project:a" />);
    const search = open();
    expect(screen.getByRole('option', { name: /Acme Rollout/ }).querySelector('svg.lucide-check')).not.toBeNull();
    fireEvent.change(search, { target: { value: 'cobalt' } });
    expect(optionTitles()).toEqual(['Partner · Cobalt']);
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(trigger().getAttribute('aria-label')).toBe('File under, Project · Acme Rollout');
  });

  it('asks the server for a query past the local list and offers its results', async () => {
    vi.useFakeTimers();
    try {
      const onSearch = vi.fn(async () => [{ id: 'project:far', title: 'Faraway', context: 'Project' }]);
      const onChange = vi.fn();
      render(<Harness onChange={onChange} onSearch={onSearch} />);
      const search = open();
      fireEvent.change(search, { target: { value: 'far' } });
      expect(screen.getByText('Searching…')).toBeTruthy();
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(onSearch).toHaveBeenCalledWith('far');
      expect(optionTitles()).toEqual(['Project · Faraway']);
      fireEvent.click(screen.getByRole('option', { name: /Faraway/ }));
      expect(onChange).toHaveBeenCalledWith('project:far');
    } finally {
      vi.useRealTimers();
    }
  });
});
