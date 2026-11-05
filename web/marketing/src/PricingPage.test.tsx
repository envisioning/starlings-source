import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { PricingPage } from './PricingPage';
import { PRICING_PLANS } from './pricing';
import { INTEREST_PLANS } from '@starlings/contracts/interest';

vi.mock('./SiteChrome', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</>, Arrow: () => null }));

describe('proposed workspace pricing', () => {
  it('shows the self-serve plans and no Business plan', () => {
    render(<PricingPage />);
    expect(screen.getByText('Proposed plans, not available to buy yet.')).toBeTruthy();
    const free = screen.getByRole('region', { name: 'Free' });
    const starter = screen.getByRole('region', { name: 'Starter' });
    const team = screen.getByRole('region', { name: 'Team' });
    const pro = screen.getByRole('region', { name: 'Pro' });
    expect(within(free).getByText('€0')).toBeTruthy();
    expect(within(free).getByText('1 active project')).toBeTruthy();
    expect(within(starter).getByText('€29')).toBeTruthy();
    expect(within(team).getByText('€59')).toBeTruthy();
    expect(within(pro).getByText('€119')).toBeTruthy();
    expect(within(pro).getByText('Scheduled agent work planned')).toBeTruthy();
    expect(screen.queryByText(/Business/)).toBeNull();
    for (const plan of ['Free', 'Starter', 'Team', 'Pro']) {
      const card = screen.getByRole('region', { name: plan });
      expect(within(card).getByRole('link', { name: `Request early access: ${plan}` }).getAttribute('href')).toBe(`/interest?plan=${plan.toLowerCase()}`);
    }
    // Every plan the site shows is one the interest contract accepts; the contract keeps Business for the backend.
    for (const plan of PRICING_PLANS) expect(INTEREST_PLANS.map((entry) => entry.id)).toContain(plan.id);
    expect(screen.queryByText('Most teams pick this')).toBeNull();
    expect(screen.getByText(/Pay per workspace, not per person/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /buy|subscribe|checkout/i })).toBeNull();
  });

  it('draws every limit from the registry, with each step about twice the last', () => {
    render(<PricingPage />);
    expect(screen.getByRole('row', { name: 'Teammates 2 10 20 50' })).toBeTruthy();
    expect(screen.getByRole('row', { name: 'Calls with built-in notes a month Your own agent 60 120 250' })).toBeTruthy();
    expect(screen.getByRole('row', { name: 'Permissions, action log and export Included Included Included Included' })).toBeTruthy();
    const prices = PRICING_PLANS.map((plan) => plan.monthlyEur).filter((price) => price > 0);
    for (let i = 1; i < prices.length; i++) {
      const step = prices[i] / prices[i - 1];
      expect(step).toBeGreaterThan(1.8);
      expect(step).toBeLessThan(2.3);
    }
    expect(screen.getByText(/A plan upgrade never expands someone’s access/)).toBeTruthy();
    expect(screen.getByText(/Free is a permanent plan, not a trial/)).toBeTruthy();
    expect(screen.getByText(/No plan charges per person or per agent/)).toBeTruthy();
  });
});
