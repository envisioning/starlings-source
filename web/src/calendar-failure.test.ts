import { describe, expect, it, vi } from 'vitest';
import { ControlRequestError } from './config';
import { calendarFailureDetail, classifyCalendarFailure, withTransientRetry } from './calendar-failure';

const err = (status: number, code?: string, requestId?: string) =>
  new ControlRequestError('x', status, code as never, requestId);

describe('classifyCalendarFailure', () => {
  it('reads a Google refusal as Google, not as a Meet sign-in', () => {
    expect(classifyCalendarFailure(err(401, 'calendar_failed'))).toBe('other');
    expect(classifyCalendarFailure(err(403, 'calendar_expired'))).toBe('google_expired');
    expect(classifyCalendarFailure(err(401, 'calendar_expired'))).toBe('google_expired');
  });
  it('reads a refused Meet session as sign in', () => {
    expect(classifyCalendarFailure(err(401, 'owner_auth_required'))).toBe('sign_in');
    expect(classifyCalendarFailure(err(401))).toBe('sign_in');
  });
  it('treats no answer, 5xx and rate limits as transient', () => {
    expect(classifyCalendarFailure(new TypeError('Load failed'))).toBe('transient');
    expect(classifyCalendarFailure(err(502, 'calendar_failed'))).toBe('transient');
    expect(classifyCalendarFailure(err(429, 'rate_limited'))).toBe('transient');
  });
  it('knows a calendar that was never connected', () => {
    expect(classifyCalendarFailure(err(409, 'calendar_not_connected'))).toBe('not_connected');
  });
});

describe('calendarFailureDetail', () => {
  it('carries cause, code, status and request id', () => {
    expect(calendarFailureDetail(err(502, 'calendar_failed', 'req-1'), 'Google events didn’t refresh'))
      .toBe('Google events didn’t refresh · cause: transient · code: calendar_failed · status: 502 · request: req-1');
  });
});

describe('withTransientRetry', () => {
  it('retries a transient failure quietly and returns the second answer', async () => {
    const op = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce('ok');
    await expect(withTransientRetry(op, { delays: [0, 0] })).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(2);
  });
  it('gives up after the delays are spent', async () => {
    const op = vi.fn().mockRejectedValue(new TypeError('offline'));
    await expect(withTransientRetry(op, { delays: [0, 0] })).rejects.toThrow('offline');
    expect(op).toHaveBeenCalledTimes(3);
  });
  it('does not retry a refusal', async () => {
    const op = vi.fn().mockRejectedValue(err(401, 'owner_auth_required'));
    await expect(withTransientRetry(op, { delays: [0, 0] })).rejects.toBeInstanceOf(ControlRequestError);
    expect(op).toHaveBeenCalledTimes(1);
  });
});
