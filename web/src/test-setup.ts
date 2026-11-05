/*
 * Runs before every web test file (vitest.config.ts).
 *
 * 1. Any `console.error` fails the test. React reports the class of bug that
 *    took the meeting view down in f4aa4d4f ("The result of getSnapshot
 *    should be cached") as a console line, and nobody reads console lines in
 *    CI. A thrown error is red.
 * 2. jsdom has no media devices and no ResizeObserver; livekit-client and the
 *    stage layout ask for both at render time.
 */
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    throw new Error(`console.error during test: ${args.map(String).join(' ')}`);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// jsdom lays nothing out, so it has no scrollTo; LiveKit's Chat scrolls its
// message list on mount.
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
Object.defineProperty(globalThis, 'ResizeObserver', { value: ResizeObserverStub, configurable: true });

// jsdom never sets `isSecureContext`; components-core refuses to enumerate
// devices without it. The origin is localhost, which a browser would trust.
Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });

if (!navigator.mediaDevices) {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      enumerateDevices: async () => [] as MediaDeviceInfo[],
      getUserMedia: async () => { throw new Error('No media in tests.'); },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
}

if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
