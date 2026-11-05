import { isValidEmailAddress } from '@starlings/contracts/email-values';
import type { ConnectionDetails } from '@starlings/contracts';
import type { LocalUserChoices as LiveKitLocalUserChoices } from '@livekit/components-react';
import type { BackgroundEffectChoice } from './background-effects';

// The wire shape is shared with the Worker; only web-local view types live here.
export type { ConnectionDetails };

export type JoinIdentity = {
  name: string;
  email: string;
};

/** Keep native button availability aligned with the shared wire contract. */
export function hasValidGuestIdentity(name: string, email: string): boolean {
  return Boolean(name.trim()) && isValidEmailAddress(email);
}

/** LiveKit device choices plus prejoin background effect (blur / block). */
export type LocalUserChoices = LiveKitLocalUserChoices & {
  backgroundEffect: BackgroundEffectChoice;
};

export type { BackgroundEffectChoice };
