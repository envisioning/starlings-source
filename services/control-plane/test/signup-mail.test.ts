import { describe, expect, it } from 'vitest';
import { setupStep } from '@starlings/contracts/setup-steps';
import { readyMail, readyMailSteps } from '../src/auth-worker/signup-mail';

describe('E3, the workspace is ready', () => {
  it('links the workspace and takes its first steps from the setup registry', () => {
    const mail = readyMail('Craft', 'craft.starlings.example', 'danny@thisiscraft.co');
    expect(mail.subject).toBe('Craft is ready');
    expect(mail.text).toContain('Your workspace is at https://craft.starlings.example\n');
    expect(mail.text).toContain('Sign in as danny@thisiscraft.co.');
    const steps = readyMailSteps('https://craft.starlings.example');
    expect(steps).toHaveLength(3);
    for (const [index, step] of steps.entries()) {
      expect(mail.text).toContain(`${index + 1}. ${step.title}: ${step.url}`);
    }
  });

  it('names the checklist titles word for word and skips the step signup settled', () => {
    const steps = readyMailSteps('https://craft.starlings.example');
    expect(steps.map((step) => step.title)).toEqual(['look', 'invite', 'project'].map((id) => setupStep(id)?.title));
    expect(steps[0]?.url).toBe('https://craft.starlings.example/admin/people');
    expect(steps[2]?.url).toBe('https://craft.starlings.example/work');
  });

  it('accepts a host that already carries a scheme', () => {
    expect(readyMail('Craft', 'https://craft.starlings.example/', 'a@b.co').text).toContain('Your workspace is at https://craft.starlings.example\n');
  });
});
