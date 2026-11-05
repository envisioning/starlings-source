import { TASK_SUGGESTION_STOPWORDS } from '@starlings/contracts/task-suggestion-values';
import type { TaskCandidate } from './contracts';

/**
 * The eval harness for task suggestions (`docs/TASK_SUGGESTIONS.md`,
 * decision 4): fixtures in, precision and recall out.
 *
 * Everything here is pure so it can be unit-tested without a model. The
 * model call itself lives in `scripts/eval-suggestions.ts`, which hands the
 * same prompt and parser the route uses (`task-candidates.ts`) a REST twin
 * of the Workers AI binding.
 *
 * A fixture is one meeting: its finalized segments, speakers already
 * reduced to roles, and the commitments a person would have written down.
 * Real fixtures stay outside git (they are transcripts); one synthetic
 * fixture ships in `fixtures/task-suggestions/` so CI exercises the shape.
 */

export interface FixtureSegment {
  speaker: string;
  starts_at_ms: number;
  ends_at_ms: number;
  text: string;
}

export interface ExpectedCommitment {
  title: string;
  /** Verbatim span of one segment. */
  quote: string;
  speaker: string;
  starts_at_ms: number;
  responsible: 'team' | 'client' | 'unassigned';
  /**
   * A commitment a careful person might or might not write down. Finding it
   * is a hit; missing it is not a miss. Recall is measured on the rest.
   */
  optional?: boolean;
}

export interface SuggestionFixture {
  id: string;
  meeting_kind?: string;
  speakers: string[];
  segments: FixtureSegment[];
  expected: ExpectedCommitment[];
  notes?: string;
}

/** A candidate the model returned, anchored to where in the meeting it came from. */
export interface Prediction extends TaskCandidate {
  /** Start of the segment the quote was found in; null when it matched none. */
  starts_at_ms: number | null;
  /** Which extraction produced it — the meeting pass, or the n-th live chunk. */
  pass: number;
}

// --- Text helpers (mirrors of TaskSuggestionHeuristics in Sources/TaskSuggestion.swift) ---

/** Lowercase, diacritic-folded, punctuation-as-space, single-spaced. */
export function normalized(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

function elided(text: string): string {
  return normalized(text.replace(/['’]/gu, ''));
}

export function tokens(text: string): string[] {
  const n = normalized(text);
  return n.length === 0 ? [] : n.split(' ');
}

/**
 * The anti-hallucination check, as the host applies it: the quote must be in
 * the window, forgiving casing, punctuation, a closed-up contraction, or one
 * dropped filler word in a longer span.
 */
export function containsQuote(quote: string, window: string, coverage = 0.9): boolean {
  const needle = normalized(quote);
  if (needle.length < 6) return false;
  const haystack = normalized(window);
  if (haystack.includes(needle)) return true;
  if (elided(window).includes(elided(quote))) return true;
  const needleTokens = needle.split(' ');
  if (needleTokens.length < 3) return false;
  const haystackTokens = new Set(haystack.split(' '));
  const present = needleTokens.filter((token) => haystackTokens.has(token)).length;
  return present / needleTokens.length >= coverage;
}

const STOPWORDS: ReadonlySet<string> = new Set(TASK_SUGGESTION_STOPWORDS);

/** Order-independent signature of a title, stopwords removed. */
export function dedupeKey(title: string): string {
  const all = tokens(title);
  const meaningful = all.filter((token) => !STOPWORDS.has(token) && token.length > 1);
  return [...new Set(meaningful.length > 0 ? meaningful : all)].sort().join(' ');
}

function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let overlap = 0;
  for (const token of setA) if (setB.has(token)) overlap += 1;
  return overlap / (setA.size + setB.size - overlap);
}

export function isDuplicateKey(key: string, existing: string[], threshold = 0.6): boolean {
  const candidate = key.split(' ').filter(Boolean);
  if (candidate.length === 0) return false;
  return existing.some((other) => {
    const known = other.split(' ').filter(Boolean);
    if (known.length === 0) return false;
    return jaccard(known, candidate) >= threshold;
  });
}

// --- Excerpts and the live gate ---

function stamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Same shape the Mac sends: clock, speaker, text — one line per utterance. */
export function excerpt(segments: FixtureSegment[]): string {
  return segments.map((segment) => `[${stamp(segment.starts_at_ms)}] ${segment.speaker}: ${segment.text}`).join('\n');
}

export interface LiveGateConfiguration {
  windowMs: number;
  chunkMs: number;
  debounceMs: number;
  quietFlushMs: number;
}

/** `TaskSuggestionEngine.Configuration` defaults, in milliseconds. */
export const DEFAULT_LIVE_GATE: LiveGateConfiguration = {
  windowMs: 300_000,
  chunkMs: 120_000,
  debounceMs: 45_000,
  quietFlushMs: 45_000,
};

/**
 * Replay the host's chunk gate over a finished transcript: which windows the
 * live pass would have read, in order. Speech accumulates per utterance; at
 * `chunkMs` the trailing `windowMs` is read; a `quietFlushMs` gap reads
 * whatever accumulated. Time is the transcript's clock, not wall time, so the
 * debounce is measured between utterances; speech still pending when the
 * transcript ends is not read, as on the Mac. The visible-row cap is UI and
 * is not simulated.
 */
export function liveWindows(
  segments: FixtureSegment[],
  configuration: LiveGateConfiguration = DEFAULT_LIVE_GATE,
): FixtureSegment[][] {
  const windows: FixtureSegment[][] = [];
  let pending = 0;
  let lastExtractionAt: number | null = null;
  const trailing = (upTo: number) => segments.filter(
    (segment) => segment.ends_at_ms <= upTo && segment.ends_at_ms >= upTo - configuration.windowMs,
  );
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    pending += Math.max(0, segment.ends_at_ms - segment.starts_at_ms);
    const now = segment.ends_at_ms;
    const debounced = lastExtractionAt !== null && now - lastExtractionAt < configuration.debounceMs;
    if (pending >= configuration.chunkMs && !debounced) {
      windows.push(trailing(now));
      pending = 0;
      lastExtractionAt = now;
      continue;
    }
    // The end of the transcript is the end of the meeting, not a silence:
    // what the live pass never got to is the meeting pass's to find.
    const next = segments[index + 1];
    const gap = next ? next.starts_at_ms - now : 0;
    if (pending > 0 && gap >= configuration.quietFlushMs) {
      windows.push(trailing(now));
      pending = 0;
      lastExtractionAt = now;
    }
  }
  return windows;
}

// --- Verification, as the host does it ---

export interface VerifiedPass {
  kept: Prediction[];
  droppedByQuote: TaskCandidate[];
  droppedBelowConfidence: TaskCandidate[];
  droppedAsDuplicate: TaskCandidate[];
}

/** Which segment a quote came out of — the one containing it, else the best token overlap. */
export function anchorSegment(quote: string, segments: FixtureSegment[]): FixtureSegment | null {
  const needle = normalized(quote);
  if (needle.length === 0) return null;
  const direct = segments.find((segment) => {
    const haystack = normalized(segment.text);
    return haystack.includes(needle) || needle.includes(haystack);
  });
  if (direct) return direct;
  const needleTokens = new Set(needle.split(' '));
  let best: { segment: FixtureSegment; score: number } | null = null;
  for (const segment of segments) {
    const segmentTokens = tokens(segment.text);
    if (segmentTokens.length === 0) continue;
    let overlap = 0;
    for (const token of segmentTokens) if (needleTokens.has(token)) overlap += 1;
    const score = overlap / needleTokens.size;
    if (score >= 0.4 && (!best || score > best.score)) best = { segment, score };
  }
  return best?.segment ?? null;
}

/**
 * Apply the host's checks to one extraction: confidence floor, quote in the
 * window, and the three-way dedupe against what is already known.
 */
export function verifyPass(
  candidates: TaskCandidate[],
  window: FixtureSegment[],
  knownKeys: string[],
  pass: number,
  minimumConfidence = 0.4,
): VerifiedPass {
  const windowText = window.map((segment) => segment.text).join(' ');
  const result: VerifiedPass = { kept: [], droppedByQuote: [], droppedBelowConfidence: [], droppedAsDuplicate: [] };
  const seen = [...knownKeys];
  for (const candidate of candidates) {
    if (candidate.confidence < minimumConfidence) {
      result.droppedBelowConfidence.push(candidate);
      continue;
    }
    if (!containsQuote(candidate.quote, windowText)) {
      result.droppedByQuote.push(candidate);
      continue;
    }
    const key = dedupeKey(candidate.title);
    if (key.length === 0 || isDuplicateKey(key, seen)) {
      result.droppedAsDuplicate.push(candidate);
      continue;
    }
    seen.push(key);
    result.kept.push({
      ...candidate,
      starts_at_ms: anchorSegment(candidate.quote, window)?.starts_at_ms ?? null,
      pass,
    });
  }
  return result;
}

// --- Matching and scoring ---

export interface Match {
  expected: ExpectedCommitment;
  prediction: Prediction;
}

export interface Score {
  fixtureId: string;
  predictions: number;
  /** Predictions matching an expected commitment, optional ones included. */
  hits: number;
  /** A second prediction for an expected commitment already matched. */
  duplicates: number;
  /** Predictions matching nothing a person would have written down. */
  falsePositives: number;
  required: number;
  requiredFound: number;
  optionalFound: number;
  precision: number;
  recall: number;
  matches: Match[];
  missed: ExpectedCommitment[];
  unmatched: Prediction[];
}

/** How alike two candidates are: quote overlap first, then place-and-title. */
function similarity(prediction: Prediction, expected: ExpectedCommitment): number {
  const quoteScore = jaccard(tokens(prediction.quote), tokens(expected.quote));
  const normalizedPrediction = normalized(prediction.quote);
  const normalizedExpected = normalized(expected.quote);
  const contained = normalizedPrediction.length >= 6 && normalizedExpected.length >= 6
    && (normalizedPrediction.includes(normalizedExpected) || normalizedExpected.includes(normalizedPrediction));
  if (contained || quoteScore >= 0.5) return 1 + quoteScore;
  if (prediction.starts_at_ms !== null && Math.abs(prediction.starts_at_ms - expected.starts_at_ms) <= 45_000) {
    const titleScore = jaccard(dedupeKey(prediction.title).split(' '), dedupeKey(expected.title).split(' '));
    if (titleScore >= 0.2) return titleScore;
  }
  return 0;
}

/**
 * Greedy one-to-one matching, best similarity first. A prediction is a hit
 * when it quotes the same span as an expected commitment, or lands within
 * 45 s of it with a title that shares words. Anything else is a false
 * positive; a second hit on the same expectation is a duplicate.
 */
export function score(fixtureId: string, predictions: Prediction[], expected: ExpectedCommitment[]): Score {
  const pairs: Array<{ p: number; e: number; s: number }> = [];
  predictions.forEach((prediction, p) => {
    expected.forEach((commitment, e) => {
      const s = similarity(prediction, commitment);
      if (s > 0) pairs.push({ p, e, s });
    });
  });
  pairs.sort((a, b) => b.s - a.s);
  const matchedPrediction = new Set<number>();
  const matchedExpected = new Set<number>();
  const matches: Match[] = [];
  let duplicates = 0;
  for (const pair of pairs) {
    if (matchedPrediction.has(pair.p)) continue;
    if (matchedExpected.has(pair.e)) {
      matchedPrediction.add(pair.p);
      duplicates += 1;
      continue;
    }
    matchedPrediction.add(pair.p);
    matchedExpected.add(pair.e);
    matches.push({ expected: expected[pair.e]!, prediction: predictions[pair.p]! });
  }
  const required = expected.filter((commitment) => !commitment.optional);
  const requiredFound = matches.filter((match) => !match.expected.optional).length;
  const optionalFound = matches.length - requiredFound;
  const unmatched = predictions.filter((_, index) => !matchedPrediction.has(index));
  const scored = predictions.length - duplicates;
  return {
    fixtureId,
    predictions: predictions.length,
    hits: matches.length,
    duplicates,
    falsePositives: unmatched.length,
    required: required.length,
    requiredFound,
    optionalFound,
    precision: scored === 0 ? 1 : matches.length / scored,
    recall: required.length === 0 ? 1 : requiredFound / required.length,
    matches,
    missed: expected.filter((commitment, index) => !commitment.optional && !matchedExpected.has(index)),
    unmatched,
  };
}

/** Pooled across fixtures — every prediction and every required commitment counts once. */
export function overall(scores: Score[]): { precision: number; recall: number; f1: number } {
  const hits = scores.reduce((sum, s) => sum + s.hits, 0);
  const scored = scores.reduce((sum, s) => sum + s.predictions - s.duplicates, 0);
  const required = scores.reduce((sum, s) => sum + s.required, 0);
  const requiredFound = scores.reduce((sum, s) => sum + s.requiredFound, 0);
  const precision = scored === 0 ? 1 : hits / scored;
  const recall = required === 0 ? 1 : requiredFound / required;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}
