import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './tailwind.css';
import './styles.css';
import { ToastHost } from './Toast';
import { ConfirmHost } from './ConfirmDataLoss';
import { watchForSignOutElsewhere } from './owner-local-state';
import { applyThemePreference } from './theme';
import { applyDocumentLanguage, loadStrings } from './i18n';
import { installOperationalErrorCapture, reportRenderFailure } from './operational-errors';
import { meetBuild, meetVersion } from 'virtual:meet-version';

// Before anything else can fail.
installOperationalErrorCapture({ version: meetVersion, build: meetBuild });

applyThemePreference();
applyDocumentLanguage();
// The strings before the app: modules build their label tables at import
// time, so App is imported only once the page's table is in place.
await loadStrings();
const { App } = await import('./App');
// A sign-out in one tab is a sign-out in all of them.
watchForSignOutElsewhere();
// Back from Add a workspace: its code loads only then.
if (new URLSearchParams(window.location.search).has('added_from')) {
  void import('./workspace-arrival').then(({ announceArrival }) => announceArrival());
}

createRoot(document.getElementById('root')!, {
  // Replaces React's default report, so log it as React would have.
  onCaughtError: (error) => {
    console.error(error);
    reportRenderFailure(error);
  },
  onUncaughtError: (error) => {
    console.error(error);
    reportRenderFailure(error);
  },
}).render(
  <StrictMode>
    <App />
    <ToastHost />
    <ConfirmHost />
  </StrictMode>,
);
