import type { TaskCandidate } from './contracts';
import { estimateTokens, recordModelUsage, workersAIText } from './model-usage';

/**
 * Proposed tasks out of a chunk of live transcript.
 *
 * This is the "beefier model" half of task suggestions: Apple's on-device
 * model is small and reads a sentence at a time, this one reads a few minutes
 * of speech at once and is asked to think about the chunk rather than pattern
 * match on cue words. Everything about the request is stateless — the Worker
 * stores nothing, and the Mac re-verifies every quote against its own window
 * before a row can appear (`docs/TASK_SUGGESTIONS.md`).
 */

const MAX_EXCERPT_CHARS = 20_000;
const MAX_CANDIDATES = 8;
const MAX_KNOWN_TITLES = 50;

const INSTRUCTIONS = `You read a chunk of a live work meeting transcript and list the commitments people made — work somebody said they would do, or asked somebody else to do.

Read the whole excerpt before answering. A commitment is often assembled across several turns: someone offers, someone else accepts, a deadline lands two sentences later. Judge the conversation, not the wording of one line.

Rules:
- Only commitments that were actually spoken. Never infer, never invent, never add work that merely sounds sensible.
- Discussing a topic is not a commitment. "We should think about pricing" is not a task; "I'll send the pricing sheet on Friday" is.
- Consider a commitment settled only if nobody walked it back later in the excerpt.
- quote must be copied verbatim from the excerpt, without the speaker label or timestamp. Never paraphrase it.
- responsible is "team" if the speaker took the work on, "client" if they asked the other side for it, otherwise "unassigned". Never invent an owner or a due date.
- confidence is 0 to 100: how sure you are that this is a real commitment somebody made.
- Prefer few, correct tasks over many. An empty list is a normal and frequent answer.

Answer with a JSON array and nothing else. Each element:
{"title": string, "quote": string, "responsible": "team"|"client"|"unassigned", "confidence": number}`;

export function taskCandidatesEnabled(
  env: Pick<Env, 'AI' | 'TASK_SUGGEST_MODE'>,
): boolean {
  return String(env.TASK_SUGGEST_MODE) === 'ai' && Boolean(env.AI);
}

/**
 * Anything that answers a chat prompt: the Workers AI binding in the Worker,
 * or the REST twin of it in the eval harness (`scripts/eval-suggestions.ts`),
 * so the same prompt and parser are what get measured.
 */
export interface TaskCandidateModel {
  run(model: string, input: {
    messages: Array<{ role: 'system' | 'user'; content: string }>;
    max_tokens: number;
    temperature: number;
  }): Promise<unknown>;
}

export async function proposeTaskCandidates(
  env: Pick<Env, 'AI' | 'TASK_SUGGEST_MODE' | 'TASK_SUGGEST_MODEL'> & Partial<Pick<Env, 'USAGE'>>,
  input: { excerpt: string; knownTitles?: string[] },
): Promise<TaskCandidate[]> {
  if (!taskCandidatesEnabled(env)) return [];
  // The live transcript chunk route: each call is counted, with
  // tokens estimated from the characters sent and answered.
  const ai = env.AI as TaskCandidateModel;
  const metered: TaskCandidateModel = {
    async run(model, request) {
      const output = await ai.run(model, request);
      await recordModelUsage(env, {
        provider: 'workers-ai',
        model,
        purpose: 'task-candidates',
        input: estimateTokens(request.messages.map((message) => message.content).join('\n')),
        output: estimateTokens(workersAIText(output)),
      });
      return output;
    },
  };
  return extractTaskCandidates(metered, env.TASK_SUGGEST_MODEL, input);
}

/** The route without the switch: what runs once a model is in hand. */
export async function extractTaskCandidates(
  ai: TaskCandidateModel,
  model: string,
  input: {
    excerpt: string;
    knownTitles?: string[];
    /** The route's cap is a chunk; a whole meeting needs more. */
    maxExcerptChars?: number;
    maxCandidates?: number;
  },
): Promise<TaskCandidate[]> {
  const maxCandidates = input.maxCandidates ?? MAX_CANDIDATES;
  const excerpt = input.excerpt.slice(0, input.maxExcerptChars ?? MAX_EXCERPT_CHARS);
  if (excerpt.trim().length === 0) return [];

  const known = (input.knownTitles ?? [])
    .map((title) => title.trim())
    .filter((title) => title.length > 0)
    .slice(0, MAX_KNOWN_TITLES);
  const alreadyKnown = known.length > 0
    ? `\n\nThese are already tracked. Do not propose them again:\n${known.map((title) => `- ${title}`).join('\n')}`
    : '';

  const output = await ai.run(model, {
    messages: [
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: `Meeting excerpt:\n\n${excerpt}${alreadyKnown}` },
    ],
    // ~110 tokens per candidate, with headroom for a model that wraps its
    // answer in prose.
    max_tokens: Math.max(900, maxCandidates * 120),
    temperature: 0.1,
  });
  return parseTaskCandidates(readResponseText(output), maxCandidates);
}

/** Workers AI types the answer as a union — plain text, an object, or a stream. */
function readResponseText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (typeof output === 'object' && output !== null && 'response' in output) {
    const value = (output as { response?: unknown }).response;
    if (typeof value === 'string') return value;
  }
  return '';
}

/**
 * Defensive by design. A model that wraps its array in prose or a fenced code
 * block still gets read; anything that is not a well-formed candidate is
 * dropped rather than repaired, because the alternative is putting a guess in
 * front of the owner.
 */
export function parseTaskCandidates(raw: string, maxCandidates = MAX_CANDIDATES): TaskCandidate[] {
  const array = firstJSONArray(raw);
  if (!Array.isArray(array)) return [];
  const candidates: TaskCandidate[] = [];
  for (const entry of array) {
    const candidate = readCandidate(entry);
    if (candidate) candidates.push(candidate);
    if (candidates.length >= maxCandidates) break;
  }
  return candidates;
}

function firstJSONArray(raw: string): unknown {
  const text = raw.trim().replace(/^```(?:json)?/iu, '').replace(/```$/u, '').trim();
  if (text.length === 0) return null;
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function readCandidate(entry: unknown): TaskCandidate | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const record = entry as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const quote = typeof record.quote === 'string' ? record.quote.trim() : '';
  if (title.length === 0 || title.length > 200 || quote.length === 0) return null;

  const rawResponsible = typeof record.responsible === 'string' ? record.responsible.trim().toLowerCase() : '';
  const responsible = rawResponsible === 'team' || rawResponsible === 'client'
    ? rawResponsible
    : 'unassigned';

  // Models answer this as 0–100 or as 0–1 depending on the day; both mean the
  // same thing, and anything unreadable is treated as an ordinary maybe.
  const rawConfidence = typeof record.confidence === 'number'
    ? record.confidence
    : Number.parseFloat(String(record.confidence ?? ''));
  const scaled = Number.isFinite(rawConfidence)
    ? (rawConfidence > 1 ? rawConfidence / 100 : rawConfidence)
    : 0.5;

  return {
    title,
    quote,
    responsible,
    confidence: Math.min(1, Math.max(0, scaled)),
  };
}
