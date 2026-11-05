import { AGENT_PRODUCTS, type AgentProductID } from '@starlings/contracts/agent-products';

/**
 * Every agent product has a page at /integrations/<id>. This is each page's
 * meta description, keyed by product id, so a product added to
 * `@starlings/contracts/agent-products` fails the typecheck until it has one. Plain
 * strings and no `t()`: `web/agent-surface.ts` reads this list while Vite
 * loads its config, before any alias resolves. The page's own words are in
 * `agent-pages.ts`, keyed by the same id.
 */
const DESCRIPTIONS: Record<AgentProductID, string> = {
  'eve': 'Run your own agents on Vercel Eve and put them in your Starlings team list, with signed handoffs and replies in the thread.',
  'claude': 'Use Claude with your team’s projects in Starlings: calls, tasks, decisions and documents in one place, over MCP, acting as you.',
  'grok-bot': 'Bring Grok Bot to your team in Starlings: its routines and browser work, filed on the project your people already use.',
  'openclaw': 'Bring OpenClaw to your team in Starlings: its background jobs and hands-on tasks, filed on the project your people already use.',
  'hermes': 'Bring Hermes to your team in Starlings: an agent that learns your team’s way from the calls, tasks and decisions on each project.',
  'openai-dots': 'Connect OpenAI Dots to Starlings: an always-on assistant that works from your team’s projects and files its work there.',
  'meta-muse': 'Connect Meta Muse to Starlings: the documents, PDFs and pages it makes go to the project for your team to review.',
  'instinct': 'Instinct and Starlings: a personal assistant’s follow-ups, filed on the project they are about.',
  'manus': 'Connect Manus to Starlings: hand it a task on a card, and its research and deliverables come back to the card.',
  'gemini-enterprise': 'Connect Gemini Enterprise to Starlings: company-wide research and workflows, filed on the project that asked.',
  'copilot-studio': 'Connect Microsoft Copilot Studio agents to Starlings: workflows and answers that work from your team’s projects.',
};

/** Every agent page, in the product list's order. */
export const AGENT_PAGE_LIST = AGENT_PRODUCTS.map((product) => ({ id: product.id, description: DESCRIPTIONS[product.id] }));

export type AgentPageID = AgentProductID;
