import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Dashboard } from './Dashboard';
// The token values first (packages/contracts/src/ops-theme.ts), then the sheet that reads them.
import 'virtual:ops-tokens.css';
import './ops.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Dashboard />
  </StrictMode>,
);
