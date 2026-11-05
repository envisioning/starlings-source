// The agent products Starlings names: the integrations page's research table
// (`web/marketing/src/AgentEcosystem.tsx`) and the interest form's "agents
// you use" list both read this one list, so a product added here shows on
// both. The id goes over the wire; the label is the product's own name.
import type { InterestOption } from './interest';

export const AGENT_PRODUCTS = [
  { id: 'eve', label: 'Vercel Eve' },
  { id: 'claude', label: 'Claude' },
  { id: 'grok-bot', label: 'Grok Bot' },
  { id: 'openclaw', label: 'OpenClaw' },
  { id: 'hermes', label: 'Hermes' },
  { id: 'openai-dots', label: 'OpenAI Dots' },
  { id: 'meta-muse', label: 'Meta Muse' },
  { id: 'instinct', label: 'Instinct' },
  { id: 'manus', label: 'Manus' },
  { id: 'gemini-enterprise', label: 'Gemini Enterprise' },
  { id: 'copilot-studio', label: 'Microsoft Copilot Studio' },
] as const satisfies readonly InterestOption[];
export type AgentProductID = (typeof AGENT_PRODUCTS)[number]['id'];
