/**
 * Messages a route sent with `client_update_required`: this page
 * is older than the Worker that serves it. `ErrorNotice` offers Reload for
 * them, never Retry, because only a newer page can fix the call.
 */
const required = new Set<string>();

export function noteClientUpdateRequired(message: string): void {
  required.add(message.trim());
}

export function needsClientUpdate(message: string): boolean {
  return required.size > 0 && required.has(message.trim());
}
