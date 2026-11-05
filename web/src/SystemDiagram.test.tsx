import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { TOPOLOGY_NODES, topologyGraph } from '@starlings/contracts/topology';
import { SystemDiagram } from './SystemDiagram';

describe('system diagram', () => {
  it('draws the overview and names its boxes', () => {
    const { container } = render(<SystemDiagram />);
    const overview = topologyGraph('overview');
    expect(container.querySelectorAll('[data-topology="box"]').length).toBe(overview.nodes.length);
    expect(container.querySelectorAll('[data-topology="line"]').length).toBe(overview.edges.length);
    expect(screen.getAllByText(/LiveKit Cloud/u).length).toBeGreaterThan(0);
  });

  it('draws every node on the full one', () => {
    const { container } = render(<SystemDiagram detail="full" />);
    expect(container.querySelectorAll('[data-topology="box"]').length).toBe(TOPOLOGY_NODES.length);
    expect(container.querySelector('svg')?.getAttribute('role')).toBe('group');
  });

  it('writes a box out in full when it is picked, and lets go of it', () => {
    // The drawing clips a sentence to the room it has; the reader does not,
    // which is the whole point of picking one.
    const store = TOPOLOGY_NODES.find((node) => node.id === 'store')!;
    const { container } = render(<SystemDiagram />);
    expect(container.querySelector('[data-topology="reader"]')).toBeNull();

    fireEvent.click(container.querySelector('[data-node="store"]')!);
    const reader = container.querySelector('[data-topology="reader"]') as HTMLElement;
    expect(within(reader).getByText(store.holds)).toBeTruthy();
    // Where it keeps it, and the lines that touch it, in full.
    expect(within(reader).getByText(/Stored in/u)).toBeTruthy();
    expect(within(reader).getByText(/the ledger, the files, the jobs/u)).toBeTruthy();
    // And it opens on the thing it belongs to, not under the drawing.
    expect(reader.style.left.endsWith('%')).toBe(true);

    fireEvent.click(container.querySelector('[data-node="store"]')!);
    expect(container.querySelector('[data-topology="reader"]')).toBeNull();
  });

  it('hangs what a collapsed box stands for under it', () => {
    // Which connectors there are is answered on the drawing, without opening
    // anything.
    const { container } = render(<SystemDiagram />);
    const chips = [...container.querySelectorAll('[data-topology="chip"]')].map((chip) => chip.textContent);
    expect(chips).toContain('Granola');
    expect(chips).toContain('Slack');
    expect(chips).toContain('Beeper');

    // And a chip is pickable in its own right.
    fireEvent.click(container.querySelector('[data-node="granola"]')!);
    const reader = container.querySelector('[data-topology="reader"]') as HTMLElement;
    expect(reader.textContent).toContain('Notes from calls Starlings did not host');
  });
});
