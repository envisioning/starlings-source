import { describe, expect, it } from 'vitest';
import { shellFallbackHtml } from '../agent-surface';

describe('the no-JavaScript app shell', () => {
  it('points from MCP pairing to its how-tos', () => {
    const html = shellFallbackHtml();
    expect(html).toContain('href="/connect"');
    expect(html).toContain('href="/help/howto/connect-claude"');
    expect(html).toContain('href="/help/howto/connect-an-agent-over-mcp"');
    expect(html).toContain('an MCP client opens it to pair with Starlings');
  });
});
