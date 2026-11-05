// Reading a shared secret (packages/contracts/src/shared-secrets.ts). The
// Secrets Store binding `SHARED_<NAME>` wins; a Worker secret `<NAME>` is the
// fallback, so a Worker that binds nothing (Envisioning today) reads exactly
// what it read before. Never logs a value.
import { sharedSecretBinding, type SharedSecretName } from '@starlings/contracts/shared-secrets';

interface SecretsStoreBinding {
  get(): Promise<string>;
}

function isStoreBinding(value: unknown): value is SecretsStoreBinding {
  return Boolean(value) && typeof (value as { get?: unknown }).get === 'function';
}

/** The value, or undefined when neither the binding nor the Worker secret holds one. */
export async function sharedSecret(env: object, name: SharedSecretName): Promise<string | undefined> {
  const bag = env as Record<string, unknown>;
  const binding = bag[sharedSecretBinding(name)];
  if (isStoreBinding(binding)) {
    try {
      const value = (await binding.get())?.trim();
      if (value) return value;
    } catch {
      // A missing store secret reads as unset; the fallback below decides.
      console.error(JSON.stringify({ level: 'error', message: 'shared_secret.unreadable', name }));
    }
  }
  const plain = bag[name];
  return typeof plain === 'string' && plain.trim() ? plain.trim() : undefined;
}

/**
 * True when a binding or a Worker secret could hold the value. For sync
 * checks (a CSP header, a configured flag); the read that uses the value
 * goes through `sharedSecret` and treats an empty store secret as unset.
 */
export function hasSharedSecret(env: object, name: SharedSecretName): boolean {
  const bag = env as Record<string, unknown>;
  if (isStoreBinding(bag[sharedSecretBinding(name)])) return true;
  const plain = bag[name];
  return typeof plain === 'string' && Boolean(plain.trim());
}

/** `{ clientSecret }` when the secret is set, `{}` otherwise; for option objects that take it as optional. */
export async function optionalSecret(env: object, name: SharedSecretName): Promise<{ clientSecret?: string }> {
  const value = await sharedSecret(env, name);
  return value ? { clientSecret: value } : {};
}
