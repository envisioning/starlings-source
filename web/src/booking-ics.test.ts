import { describe, expect, it } from 'vitest';
import { buildBookingIcs } from './booking-ics';

const booking = {
  title: 'Intro',
  startsAt: '2026-10-12T14:00:00Z',
  endsAt: '2026-10-12T14:30:00Z',
};

describe('the booking calendar file (meet#863)', () => {
  it('keeps Envisioning’s PRODID and names its own host', () => {
    const ics = buildBookingIcs({ ...booking, joinUrl: 'https://envisioning.starlings.example/room/mz', workspaceName: 'Envisioning' })!;
    expect(ics).toContain('PRODID:-//Envisioning//Meet//EN\r\n');
    expect(ics).toMatch(/UID:\S+@envisioning\.starlings\.example\r\n/u);
  });

  it('names another workspace and its host, never Envisioning', () => {
    const ics = buildBookingIcs({ ...booking, joinUrl: 'https://hq.starlings.example/room/ada', workspaceName: 'HQ' })!;
    expect(ics).toContain('PRODID:-//Starlings//HQ//EN\r\n');
    expect(ics).toMatch(/UID:\S+@hq\.starlings\.example\r\n/u);
    expect(ics).not.toContain('nvisioning');
  });

  it('drops a slash or a line break from the name', () => {
    const ics = buildBookingIcs({ ...booking, joinUrl: 'https://a.starlings.example/room/x', workspaceName: 'A/B\nC' })!;
    expect(ics).toContain('PRODID:-//Starlings//ABC//EN\r\n');
  });
});
