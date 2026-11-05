import { useEffect, useState } from 'react';
import type { DeploymentInfo } from '@docs/contracts';
import { api } from './api';

/**
 * This deployment's name and admitted domains (`GET /api/deployment`). Read
 * once per page, before sign-in. A workspace deployment is not
 * Envisioning's, so nothing in the chrome names
 * Envisioning unless this says so. Null until it answers, or when it fails:
 * the chrome then shows "Docs" alone.
 */
let pending: Promise<DeploymentInfo | null> | null = null;

function load(): Promise<DeploymentInfo | null> {
  pending ??= api.deployment().catch(() => null);
  return pending;
}

export function useDeployment(): DeploymentInfo | null {
  const [info, setInfo] = useState<DeploymentInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    void load().then((value) => {
      if (cancelled) return;
      setInfo(value);
      if (value) document.title = `${value.name} Docs`;
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return info;
}
