import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export interface Config {
  origin: string;
  token?: string;
  /** Local mirror root for pull/push. */
  root?: string;
}

const DIR = path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'envisioning-docs');
const FILE = path.join(DIR, 'config.json');

// The origin the API is actually served from. Not `docs.org.example` —
// that is a Gandi 302, and a redirected POST arrives as a GET with no body,
// so every write would fail in a confusing way.
const DEFAULTS: Config = { origin: 'https://docs.workers.org.example' };

export async function loadConfig(): Promise<Config> {
  let stored: Partial<Config> = {};
  try {
    stored = JSON.parse(await readFile(FILE, 'utf8')) as Partial<Config>;
  } catch {
    stored = {};
  }
  // Env wins over the file, so CI and agents can run without writing config.
  return {
    ...DEFAULTS,
    ...stored,
    ...(process.env.DOCS_ORIGIN ? { origin: process.env.DOCS_ORIGIN } : {}),
    ...(process.env.DOCS_TOKEN ? { token: process.env.DOCS_TOKEN } : {}),
  };
}

export async function saveConfig(config: Config): Promise<void> {
  await mkdir(DIR, { recursive: true });
  // 0600: the file holds a token that can rewrite the company's knowledge.
  await writeFile(FILE, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function configPath(): string {
  return FILE;
}
