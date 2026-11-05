import { createElement, type ComponentType } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import './tailwind-site.css';
import '@shared/styles.css';
import '../house.css';
// In the head of every page, not in the page's own chunk: the wordmark in the
// prerendered header then animates from first paint (gathering-dots.css).
import '@shared/gathering-dots.css';

// The site is English. Set it before anything
// imports @shared/i18n, which reads it once, at load.
(globalThis as { MEET_PAGE_LANGUAGE?: string }).MEET_PAGE_LANGUAGE = 'en';

type Page = { load: () => Promise<ComponentType<never>>; props?: Record<string, unknown> };

const pages: Partial<Record<string, () => Promise<ComponentType<never>>>> = {
  '/why': async () => (await import('./WhyPage')).WhyPage,
  '/workspace': async () => (await import('./FeaturesPage')).FeaturesPage,
  '/workspace/capabilities': async () => (await import('./CapabilitiesPage')).CapabilitiesPage,
  '/workspace/status': async () => (await import('./FeatureStatusPage')).FeatureStatusPage,
  '/assessment': async () => (await import('./AssessmentPage')).AssessmentPage,
  '/pricing': async () => (await import('./PricingPage')).PricingPage,
  '/changelog': async () => (await import('./ChangelogPage')).ChangelogPage,
  '/privacy': async () => (await import('./PrivacyPage')).PrivacyPage,
  '/terms': async () => (await import('./PrivacyPage')).TermsPage,
  '/interest': async () => (await import('./InterestPage')).InterestPage,
  // Client-only, like /start: the token is in the address fragment.
  '/interest/confirm': async () => (await import('./InterestConfirmPage')).InterestConfirmPage,
  '/sign-in': async () => (await import('./SignInPage')).SignInPage,
  // Client-only: the page reads its token from the address fragment (prerender.mjs writes an empty, noindex shell).
  '/start': async () => (await import('./StartPage')).StartPage,
  '/agents': async () => (await import('./StandardPages')).AgentsPage,
  '/spec': async () => (await import('./StandardPages')).SpecPage,
  '/security': async () => (await import('./SecurityPage')).SecurityPage,
  '/integrations': async () => (await import('./IntegrationsPage')).IntegrationsPage,
  '/download': async () => (await import('./DownloadPage')).DownloadPage,
  '/faq': async () => (await import('./CompanyPages')).FaqPage,
  '/about': async () => (await import('./CompanyPages')).AboutPage,
  '/customers/envisioning': async () => (await import('./CompanyPages')).CustomerPage,
};

function pageFor(pathname: string): Page | null {
  if (pathname === '/field-notes' || pathname.startsWith('/field-notes/')) return { load: async () => (await import('./FieldNotesPage')).FieldNotesPage, props: { slug: pathname.slice('/field-notes/'.length) || null } };
  if (pathname === '/use-cases' || pathname.startsWith('/use-cases/')) return { load: async () => (await import('./UseCasesPage')).UseCasesPage, props: { slug: pathname.slice(11) || null } };
  if (pathname === '/help' || pathname.startsWith('/help/')) return { load: async () => (await import('./HelpPage')).HelpPage, props: { slug: pathname.slice(6) || null } };
  if (pathname === '/skills' || pathname.startsWith('/skills/')) return { load: async () => (await import('./StandardPages')).SkillsPage, props: { name: pathname.slice(8) || null } };
  if (pathname === '/for' || pathname.startsWith('/for/')) return { load: async () => (await import('./SolutionPages')).TeamPage, props: { slug: pathname.slice(5) || null } };
  if (pathname.startsWith('/integrations/')) return { load: async () => (await import('./AgentPage')).AgentPage, props: { slug: pathname.slice(14) } };
  if (pathname === '/compare' || pathname.startsWith('/compare/')) return { load: async () => (await import('./SolutionPages')).ComparePage, props: { slug: pathname.slice(9) || null } };
  const load = pages[pathname];
  return load ? { load } : null;
}

// The prerender (../prerender.mjs) writes each page's HTML into #root. The
// page's code loads first and then hydrates that HTML in place, so the reader
// never sees it replaced by a loading state. A page with no prerendered HTML
// renders fresh.
const page = pageFor(window.location.pathname.replace(/(.)\/$/, '$1'));
if (page) {
  // The page's modules load after this: some
  // build their labels at import (pricing.ts).
  const { applyDocumentLanguage } = await import('@shared/i18n');
  applyDocumentLanguage();
  const Page = await page.load();
  const root = document.getElementById('root')!;
  const element = createElement(Page, page.props as never);
  if (root.hasChildNodes()) hydrateRoot(root, element);
  else createRoot(root).render(element);
}
