import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './tailwind-site.css';
import '@shared/styles.css';
import '@shared/gathering-dots.css';

/*
 * The home page's one script mounts its showcases: the Calls tour, then the
 * proposal use case's board. The rest
 * of the home page is HomePage.tsx, rendered to static HTML at build time. house.css is not imported here: the home
 * page links it after this bundle's stylesheet, so the house tokens and
 * element rules win, as they do on the React pages (prerender.mjs).
 */

/** Load a tour only as it nears the viewport. */
function mountNear(id: string, load: () => Promise<ReactNode>) {
  const node = document.getElementById(id);
  if (!node) return;
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    void load().then((tree) => createRoot(node).render(tree));
  }, { rootMargin: '300px' });
  observer.observe(node);
}

mountNear('sim-calls', () => import('./CallsShowcase').then(({ CallsShowcase }) => <CallsShowcase />));
mountNear('sim-proposal', () => import('./sim/ProposalSim').then(({ ProposalSim }) => <ProposalSim />));
