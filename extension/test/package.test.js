import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { meetEventsBatchSchema } from '../../packages/contracts/src/extension-events.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFileSync(`${root}/${path}`, 'utf8');
beforeAll(() => execFileSync(process.execPath, ['build.mjs'], { cwd: root }));

describe('installable extension', () => {
  it('packages all manifest entries, locales and module dependencies', () => {
    const manifest = JSON.parse(read('dist/manifest.json'));
    for (const path of [manifest.background.service_worker, manifest.options_ui.page, ...manifest.content_scripts.flatMap((entry) => entry.js), '_locales/en/messages.json', '_locales/pt_BR/messages.json', 'src/batching.js', 'src/options.js']) {
      expect(read(`dist/${path}`).length, path).toBeGreaterThan(0);
    }
    expect(() => new Script(read('dist/src/content.js'))).not.toThrow();
  });

  it('runs the real classic content bundle through a Portuguese call start, missing roster and end', () => {
    const dom = new JSDOM('<title>Meet - Revisão</title><button aria-label="Sair da chamada"></button><div data-participant-id="a" data-self-name="Ana"><i aria-label="Ana está falando"></i></div>', {
      url: 'https://meet.google.com/abc-defg-hij', runScripts: 'outside-only',
    });
    let tick;
    const sendMessage = vi.fn();
    dom.window.chrome = { runtime: { sendMessage } };
    dom.window.setInterval = (callback) => { tick = callback; return 1; };
    dom.window.eval(read('dist/src/content.js'));
    tick();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const started = sendMessage.mock.calls[0][0];
    expect(started.lifecycle.kind).toBe('call-started');
    expect(started.title).toBe('Revisão');
    expect(started.roster).toEqual([{ name: 'Ana', speaking: true }]);
    expect(meetEventsBatchSchema.parse({ ...started, schemaVersion: 2, capturedAtMs: started.lifecycle.atMs }).meetingCode).toBe('abc-defg-hij');
    tick();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    dom.window.document.querySelector('[data-participant-id]').remove();
    tick();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    dom.window.document.querySelector('button').remove();
    tick();
    const ended = sendMessage.mock.calls[1][0];
    expect(ended.lifecycle.kind).toBe('call-ended');
    expect(ended.roster).toEqual(started.roster);
    dom.window.close();
  });
});
