import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// findBy*/waitFor default to 1 s, which is too tight on a loaded CI machine.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
});

// Mantine relies on browser APIs that jsdom does not implement.
const noop = (): void => {};
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: noop,
      removeEventListener: noop,
      addListener: noop,
      removeListener: noop,
      dispatchEvent: () => false,
    }) as MediaQueryList,
});

// Mantine's autosize Textarea listens for web-font loading.
Object.defineProperty(document, 'fonts', {
  configurable: true,
  value: { addEventListener: noop, removeEventListener: noop, ready: Promise.resolve() },
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ResizeObserverStub;
