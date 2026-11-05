// A meeting's title is a title, not the first heading of its summary
// (meet#156): every meeting used to be "**Summary**".
import { describe, expect, it } from 'vitest';
import { isSectionTitle, isTooShort, summarize, titleFromSummary, titledSummary } from '../src/artifacts';
import type { ArtifactMaterial } from '../src/room-coordinator';

const segment = {
  id: '199485db-f7aa-4766-b8b6-186661024c96',
  meeting_id: 'ec98d0e3-9428-44a5-84e0-a61c85909ad3',
  speaker_id: 'owner:rosa@example.com',
  speaker_name: 'Rosa Ortiz',
  language: 'en' as const,
  starts_at_ms: 0,
  ends_at_ms: 2_000,
  text: 'We agreed to ship the peer meeting MVP.',
  is_final: true,
};

function material(overrides: Partial<ArtifactMaterial> = {}): ArtifactMaterial {
  return {
    roomSlug: 'rosa',
    meetingId: segment.meeting_id,
    startedAt: Date.UTC(2026, 8, 15, 9),
    endedAt: Date.UTC(2026, 8, 15, 10),
    title: null,
    summary: null,
    transcript: [segment],
    ...overrides,
  };
}

describe('titledSummary', () => {
  it('never lets a section heading be the title', () => {
    const answer = '**Summary**\n\nWe agreed to ship.\n\n**Decisions**\n\n- Ship it.';
    const result = titledSummary(material(), answer);
    expect(result.title).toBe('Meeting notes — 2026-09-15');
    expect(result.summary).toBe(answer);
    expect(titledSummary(material(), '## Summary\n\ntext').title).toBe('Meeting notes — 2026-09-15');
    expect(titledSummary(material(), 'Resumo\n\ntexto').title).toBe('Meeting notes — 2026-09-15');
  });

  it('takes the Title: line the prompt asks for, out of the body', () => {
    const result = titledSummary(material(), 'Title: Radar update with Luciana\n\n## Summary\n\nWe agreed to ship.');
    expect(result.title).toBe('Radar update with Luciana');
    expect(result.summary).toBe('## Summary\n\nWe agreed to ship.');
    expect(titledSummary(material(), '**Title:** Q4 planning').title).toBe('Q4 planning');
    expect(titledSummary(material(), '# Title: "Kickoff"\n\ntext').title).toBe('Kickoff');
  });

  it('falls back to the first line with its markdown stripped', () => {
    expect(titledSummary(material(), '# **Pricing call with Acme**\n\n## Summary').title).toBe('Pricing call with Acme');
    expect(titledSummary(material(), '_Kickoff_\ntext').title).toBe('Kickoff');
  });

  it('keeps the title a meeting already has', () => {
    const result = titledSummary(material({ title: 'Booked: Acme intro' }), 'Title: Something else\n\n## Summary');
    expect(result.title).toBe('Booked: Acme intro');
    expect(result.summary).toBe('## Summary');
  });
});

describe('summarize', () => {
  it('asks the model for a Title line and uses it', async () => {
    let prompt = '';
    const result = await summarize(material(), {
      AI: {
        run: async (_model: string, input: { messages: Array<{ role: string; content: string }> }) => {
          prompt = input.messages[0]!.content;
          return { response: 'Title: Peer meeting MVP\n\n**Summary**\n\nWe agreed to ship the MVP.' };
        },
      },
      SUMMARY_MODE: 'ai',
      SUMMARY_MODEL: '@cf/meta/llama-test',
    } as unknown as Pick<Env, 'AI' | 'SUMMARY_MODE' | 'SUMMARY_MODEL'>);
    expect(prompt).toContain('Title:');
    expect(result.title).toBe('Peer meeting MVP');
    expect(result.summary.startsWith('**Summary**')).toBe(true);
    expect(result.model).toBe('@cf/meta/llama-test');
  });

  it('survives a model that ignores the instruction', async () => {
    const result = await summarize(material(), {
      AI: { run: async () => ({ response: '**Summary**\n\nWe agreed.' }) },
      SUMMARY_MODE: 'ai',
      SUMMARY_MODEL: '@cf/meta/llama-test',
    } as unknown as Pick<Env, 'AI' | 'SUMMARY_MODE' | 'SUMMARY_MODEL'>);
    expect(result.title).toBe('Meeting notes — 2026-09-15');
  });

  it('knows the titles the bug left behind, and finds a real one in the summary', async () => {
    expect(isSectionTitle('**Summary**')).toBe(true);
    expect(isSectionTitle('## Decisions')).toBe(true);
    expect(isSectionTitle('')).toBe(true);
    expect(isSectionTitle('Radar update with Luciana')).toBe(false);
    // The model talking to us is not a title either.
    expect(isSectionTitle("I can't fulfill that request.")).toBe(true);
    expect(isSectionTitle("I don't see any meeting details. Can you provide them?")).toBe(true);
    expect(isSectionTitle('Please provide the transcript')).toBe(true);
    expect(isSectionTitle('You\'re right, this is not a formal meeting summary. I made a mistake by asking you to summarize it.')).toBe(true);
    expect(isSectionTitle('You are correct that the conversation snippet you provided is in Portuguese.')).toBe(true);
    expect(isSectionTitle('Meeting Summary of Key Discussion Points')).toBe(true);
    expect(isSectionTitle('I-2037 kickoff')).toBe(false);
    expect(isSectionTitle('Pricing call with Acme')).toBe(false);
    expect(isSectionTitle('Termo de Referência I-2037')).toBe(false);
    expect(isSectionTitle('Meeting notes — 2026-09-15')).toBe(false);

    const withSummary = material({ summary: '**Summary**\n\nWe agreed to ship the peer meeting MVP.' });
    const ai = (response: string) => ({
      AI: { run: async () => ({ response }) },
      SUMMARY_MODE: 'ai',
      SUMMARY_MODEL: '@cf/meta/llama-test',
    } as unknown as Pick<Env, 'AI' | 'SUMMARY_MODE' | 'SUMMARY_MODEL'>);
    expect(await titleFromSummary(withSummary, ai('Title: "Peer meeting MVP"'))).toBe('Peer meeting MVP');
    expect(await titleFromSummary(withSummary, ai('**Summary**'))).toBe('Meeting notes — 2026-09-15');
    expect(await titleFromSummary(withSummary, ai("I can't fulfill that request."))).toBe('Meeting notes — 2026-09-15');
    expect(await titleFromSummary(material({ summary: null }), ai('x'))).toBe('Meeting notes — 2026-09-15');
  });

  it('calls a meeting that ended inside five minutes too short, and an open one never', () => {
    const start = Date.UTC(2026, 8, 15, 9);
    expect(isTooShort({ startedAt: start, endedAt: start + 30_000 })).toBe(true);
    expect(isTooShort({ startedAt: start, endedAt: start + 4 * 60_000 + 59_999 })).toBe(true);
    expect(isTooShort({ startedAt: start, endedAt: start + 5 * 60_000 })).toBe(false);
    expect(isTooShort({ startedAt: start, endedAt: null })).toBe(false);
  });
});
