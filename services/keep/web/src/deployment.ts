import { useEffect, useState } from 'react';
import type { DeploymentInfo } from '@keep/contracts';
import { api } from './api';

/**
 * This deployment's name and admitted domains (`GET /api/deployment`). Read
 * once per page, before sign-in. A workspace deployment is not
 * Envisioning's, so nothing in the chrome names
 * Envisioning unless this says so. Null until it answers, or when it fails:
 * the chrome then shows "Keep" alone. The same arrangement as Docs'.
 */
let pending: Promise<DeploymentInfo | null> | null = null;
let known: DeploymentInfo | null = null;

function load(): Promise<DeploymentInfo | null> {
  pending ??= api.deployment().then((value) => (known = value)).catch(() => null);
  return pending;
}

/**
 * The product's full name, for the passkey prompt: "HQ Keep", "Envisioning
 * Keep". Synchronous on purpose: WebAuthn must start inside the person's
 * click, and Safari drops that window across an awaited fetch. The name is
 * asked for when this module loads, long before anyone enrols.
 */
export function productName(): string {
  return known ? `${known.name} Keep` : 'Keep';
}

void load();

export function useDeployment(): DeploymentInfo | null {
  const [info, setInfo] = useState<DeploymentInfo | null>(known);
  useEffect(() => {
    let cancelled = false;
    void load().then((value) => {
      if (cancelled) return;
      setInfo(value);
      if (value) document.title = `${value.name} Keep`;
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return info;
}
