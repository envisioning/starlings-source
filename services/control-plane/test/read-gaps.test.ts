// meet#1022: a cap hit and a failed read are two different things.
import { describe, expect, it } from 'vitest';
import { ControlError } from '../src/errors';
import { readFailureOf, settleReadGaps } from '../src/read-gaps';

describe('read gaps', () => {
  it('names the cause a client can say', () => {
    expect(readFailureOf('Envisioning Core', new ControlError('Core is busy', 429, 'rate_limited'))).toEqual({ subject: 'Envisioning Core', cause: 'rate_limited', status: 429 });
    expect(readFailureOf('A', new ControlError('no', 403))).toEqual({ subject: 'A', cause: 'auth', status: 403 });
    const timeout = new Error('The operation timed out.');
    timeout.name = 'TimeoutError';
    expect(readFailureOf('B', timeout)).toEqual({ subject: 'B', cause: 'timeout' });
    expect(readFailureOf('C', new ControlError('bad', 502))).toEqual({ subject: 'C', cause: 'upstream', status: 502 });
  });

  it('keeps one failure per subject, and a failed subject is never also truncated', () => {
    const settled = settleReadGaps({
      truncated: ['Meet', 'Meet', 'Core'],
      failed: [{ subject: 'Core', cause: 'rate_limited', status: 429 }, { subject: 'Core', cause: 'upstream' }],
    });
    expect(settled).toEqual({ partial: ['Core'], truncated: ['Meet'], failed: [{ subject: 'Core', cause: 'rate_limited', status: 429 }] });
  });
});
