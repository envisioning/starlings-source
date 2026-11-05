import { SERVED_WEB_ORIGIN } from '@starlings/contracts/deployment';

/**
 * `robots.txt` for one workspace's origin. The Worker answers it
 * per request from `WEB_ORIGIN`; the prerendered asset uses the build's.
 */
export function robotsTxt(origin: string): string {
  const base = origin.replace(/\/+$/u, '');
  return [
    'User-agent: *',
    'Disallow: /room/',
    'Disallow: /book/',
    'Disallow: /api/',
    'Allow: /',
    '',
    `Sitemap: ${base}/sitemap.xml`,
    `# For language models: ${base}/llms.txt is the index, ${base}/llms-full.txt is every help page in one file.`,
    '# /changelog and every /help page answer Accept: text/markdown with their source, also at <path>.md.',
    '',
  ].join('\n');
}

/** The build's own robots.txt, the prerendered asset. */
export const ROBOTS_TXT = robotsTxt(SERVED_WEB_ORIGIN);
