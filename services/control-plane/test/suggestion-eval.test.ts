import { describe, expect, it } from 'vitest';
import {
  anchorSegment,
  containsQuote,
  dedupeKey,
  excerpt,
  liveWindows,
  overall,
  score,
  verifyPass,
  type FixtureSegment,
  type Prediction,
  type SuggestionFixture,
} from '../src/suggestion-eval';

import synthetic from '../../../fixtures/task-suggestions/synthetic-01.json';

const fixture = synthetic as SuggestionFixture;

function segment(text: string, startsAt: number, speaker = 'Owner', duration = 4000): FixtureSegment {
  return { speaker, starts_at_ms: startsAt, ends_at_ms: startsAt + duration, text };
}

function prediction(title: string, quote: string, startsAt: number | null, confidence = 0.9): Prediction {
  return { title, quote, responsible: 'team', confidence, starts_at_ms: startsAt, pass: 0 };
}

describe('the synthetic fixture', () => {
  it('has every expected quote verbatim in one segment, spoken by that speaker', () => {
    for (const commitment of fixture.expected) {
      const anchor = anchorSegment(commitment.quote, fixture.segments);
      expect(anchor, commitment.title).not.toBeNull();
      expect(anchor?.speaker).toBe(commitment.speaker);
      expect(anchor?.starts_at_ms).toBe(commitment.starts_at_ms);
    }
  });

  it('renders the excerpt the way the Mac does', () => {
    const lines = excerpt(fixture.segments.slice(0, 2)).split('\n');
    expect(lines[0]).toMatch(/^\[00:00\] Owner: /u);
    expect(lines[1]).toMatch(/^\[00:09\] Client 1: /u);
  });
});

describe('quote verification (mirror of TaskSuggestionHeuristics.containsQuote)', () => {
  it('forgives casing, punctuation, and a closed-up contraction', () => {
    const window = "Okay, I'll send the pricing deck on Friday.";
    expect(containsQuote('ill send the pricing deck on friday', window)).toBe(true);
    expect(containsQuote('I’ll send the pricing deck', window)).toBe(true);
  });

  it('drops an invented quote', () => {
    expect(containsQuote('I will prepare the contract by Monday', "I'll send the pricing deck on Friday.")).toBe(false);
  });

  it('does not match a fragment shorter than six characters', () => {
    expect(containsQuote('send', "I'll send the pricing deck on Friday.")).toBe(false);
  });
});

describe('the live gate replay', () => {
  it('reads nothing for a single utterance, however committal', () => {
    expect(liveWindows([segment("I'll send the deck on Friday.", 0)])).toEqual([]);
  });

  it('reads the trailing window once enough speech accumulated', () => {
    // Twelve 12 s utterances back to back: the chunk closes at 120 s.
    const segments = Array.from({ length: 12 }, (_, index) => segment(`line ${index}`, index * 12_000, 'Owner', 12_000));
    const windows = liveWindows(segments);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toHaveLength(10);
  });

  it('flushes a part-grown chunk after a quiet gap', () => {
    const segments = [
      segment('So you will send that over.', 0, 'Owner', 4000),
      segment('Yes.', 5000, 'Client 1', 1000),
      segment('Back to the agenda.', 90_000, 'Owner', 4000),
    ];
    const windows = liveWindows(segments);
    // The gap flushes the first two lines; the last line is still pending when
    // the transcript ends and stays unread, as on the Mac.
    expect(windows).toHaveLength(1);
    expect(windows[0]?.map((s) => s.text)).toEqual(['So you will send that over.', 'Yes.']);
  });

  it('replays the synthetic fixture as a couple of chunks', () => {
    const windows = liveWindows(fixture.segments);
    expect(windows.length).toBeGreaterThanOrEqual(1);
    expect(windows.length).toBeLessThanOrEqual(3);
  });
});

describe('verification of one pass', () => {
  it('drops low confidence, invented quotes, and duplicates; anchors the rest', () => {
    const window = fixture.segments;
    const verified = verifyPass([
      { title: 'Send the pricing deck', quote: "I'll send you the pricing deck on Friday", responsible: 'team', confidence: 0.9 },
      { title: 'Send pricing deck Friday', quote: "I'll send you the pricing deck on Friday", responsible: 'team', confidence: 0.8 },
      { title: 'Invented', quote: 'we agreed to ship the contract', responsible: 'team', confidence: 0.9 },
      { title: 'Maybe', quote: "I'll add the onboarding session to the deck", responsible: 'team', confidence: 0.2 },
    ], window, [], 0);
    expect(verified.kept.map((p) => p.title)).toEqual(['Send the pricing deck']);
    expect(verified.kept[0]?.starts_at_ms).toBe(16_000);
    expect(verified.droppedAsDuplicate.map((c) => c.title)).toEqual(['Send pricing deck Friday']);
    expect(verified.droppedByQuote.map((c) => c.title)).toEqual(['Invented']);
    expect(verified.droppedBelowConfidence.map((c) => c.title)).toEqual(['Maybe']);
  });

  it('dedupes against titles known from earlier passes', () => {
    const verified = verifyPass(
      [{ title: 'Send the pricing deck', quote: "I'll send you the pricing deck on Friday", responsible: 'team', confidence: 0.9 }],
      fixture.segments,
      [dedupeKey('Send pricing deck')],
      1,
    );
    expect(verified.kept).toEqual([]);
    expect(verified.droppedAsDuplicate).toHaveLength(1);
  });
});

describe('scoring', () => {
  it('matches on the quote, then on place and title', () => {
    const result = score('t', [
      prediction('Pricing deck', "I'll send you the pricing deck on Friday", 16_000),
      prediction('Introduce Marta from IT', 'introduce you to her by email', 46_000),
      prediction('Sample export', 'send the sample export tomorrow morning', 112_000),
      prediction('Training video', 'think about a training video', 53_000),
    ], fixture.expected);
    expect(result.hits).toBe(3);
    expect(result.falsePositives).toBe(1);
    expect(result.unmatched.map((p) => p.title)).toEqual(['Training video']);
    expect(result.requiredFound).toBe(3);
    expect(result.recall).toBe(1);
    expect(result.precision).toBeCloseTo(0.75);
  });

  it('counts a second prediction for the same commitment as a duplicate, not a hit', () => {
    const result = score('t', [
      prediction('Pricing deck', "I'll send you the pricing deck on Friday", 16_000),
      prediction('Send deck Friday', 'send you the pricing deck on Friday', 16_000),
    ], fixture.expected);
    expect(result.hits).toBe(1);
    expect(result.duplicates).toBe(1);
    expect(result.precision).toBe(1);
    expect(result.recall).toBeCloseTo(1 / 3);
    expect(result.missed.map((c) => c.title)).toHaveLength(2);
  });

  it('treats an optional commitment as a hit when found and not a miss when not', () => {
    const found = score('t', [
      prediction('Client reply by the 30th', 'come back to you by the 30th', 118_000),
    ], fixture.expected);
    expect(found.hits).toBe(1);
    expect(found.optionalFound).toBe(1);
    expect(found.precision).toBe(1);
    expect(found.recall).toBe(0);
    expect(found.missed).toHaveLength(3);
  });

  it('pools fixtures for the overall figure', () => {
    const a = score('a', [prediction('Pricing deck', "I'll send you the pricing deck on Friday", 16_000)], fixture.expected);
    const b = score('b', [], []);
    const total = overall([a, b]);
    expect(total.precision).toBe(1);
    expect(total.recall).toBeCloseTo(1 / 3);
    expect(total.f1).toBeCloseTo(0.5);
  });
});
