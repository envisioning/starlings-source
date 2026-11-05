import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectedMeeting } from './MeetingExperience';
import { DEFAULT_BACKGROUND_EFFECT } from './background-effects';
import type { ConnectionDetails, LocalUserChoices } from './meeting-types';

/*
 * The meeting is a lazy chunk, and `tsc` plus `pnpm build:web` both passed
 * while every admitted guest saw "This meeting view stopped" (f4aa4d4f).
 * Nothing rendered a component before deploy. This does: the whole admitted
 * tree mounts on a Room that never connects, and any render-time throw, or
 * any `console.error` (src/test-setup.ts), fails here.
 */

// `LiveKitRoom` connects on mount. There is no server here, so the Room it
// builds never opens a socket and the tree renders against a Room that stays
// disconnected. `connect` is an instance field on livekit-client's Room, not
// a prototype method, so the substitution is a subclass rather than a spy.
vi.mock('livekit-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('livekit-client')>();
  class DisconnectedRoom extends actual.Room {
    override connect = async () => {};
    override disconnect = async () => {};
  }
  return { ...actual, Room: DisconnectedRoom };
});

const connection: ConnectionDetails = {
  server_url: 'wss://livekit.test',
  participant_token: 'test-token',
  participant_token_expires_at: Math.floor(Date.now() / 1000) + 3600,
  artifact_token: 'artifact-token',
  meeting_id: 'meeting-1',
  livekit_room: 'mz',
  started_at: Date.now(),
};

const mediaChoices: LocalUserChoices = {
  username: 'Ana',
  audioEnabled: false,
  videoEnabled: false,
  audioDeviceId: '',
  videoDeviceId: '',
  backgroundEffect: DEFAULT_BACKGROUND_EFFECT,
};

describe('ConnectedMeeting', () => {
  it('renders the admitted meeting view without throwing', async () => {
    await act(async () => {
      render(
        <ConnectedMeeting
          roomSlug="mz"
          connection={connection}
          mediaChoices={mediaChoices}
          onDisconnected={() => {}}
          onLeave={() => {}}
          onOwnerLeft={() => {}}
        />,
      );
    });
    // The bar under the stage is the last thing the tree mounts; its
    // presence means MeetingSettings, the guards and the workspace all rendered.
    expect(screen.getByRole('button', { name: /Microphone/ })).toBeTruthy();
    expect(screen.getByText('Waiting for someone to join')).toBeTruthy();
  });
});
