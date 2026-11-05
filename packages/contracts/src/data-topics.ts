/**
 * The LiveKit data topics a meeting speaks on. Zod-free, so the guest meeting
 * bundle can import them; `index.ts` holds the message shapes. The generator
 * writes them into `ContractConstants` for the Swift apps.
 */

/** Ephemeral topic a verified owner publishes captions on. */
export const CAPTION_DATA_TOPIC = 'captions.v1' as const;

/**
 * Host moderation. Unlike captions this one is published by the control plane
 * rather than by a participant: the authority to moderate lives with the room's
 * verified owner, and the Worker is the only place that can prove who that is.
 */
export const MODERATION_DATA_TOPIC = 'moderation.v1' as const;

/** Server-only host coordination messages. */
export const HOST_DATA_TOPIC = 'host.v1' as const;

/**
 * Deprecated: Macs on 5.8.x call the host "the chair" and listen on this
 * topic for `chair_identity`. The Worker sends both until removes this.
 */
export const LEGACY_CHAIR_DATA_TOPIC = 'chair.v1' as const;
