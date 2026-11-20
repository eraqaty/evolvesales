import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { vi } from 'vitest';
import { routes } from '../App';
import { createQueryClient, Providers } from '../providers';

interface MockResult {
  status?: number;
  body?: unknown;
  /** Respond as Server-Sent Events, one `data:` line per item. */
  sse?: unknown[];
}

type Handler = (url: URL, init: RequestInit | undefined) => MockResult | undefined;

/**
 * Installs a fake `fetch` that routes by "METHOD /path" and returns JSON.
 * Unmatched requests return 404 so tests fail loudly instead of hanging.
 */
/** The URL string of a fetch() argument. */
export function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/** The JSON body of a fetch() call made by our api client (always a string). */
export function jsonBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('expected a JSON string body');
  return JSON.parse(init.body) as Record<string, unknown>;
}

export function mockApi(handlers: Record<string, Handler | MockResult>) {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(urlOf(input), 'http://localhost');
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    const handler = handlers[key];
    const result = typeof handler === 'function' ? handler(url, init) : handler;
    if (!result) {
      return new Response(JSON.stringify({ message: `unmocked ${key}` }), { status: 404 });
    }
    const status = result.status ?? 200;
    if (result.sse) {
      const text = result.sse.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
      return new Response(text, { status, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return new Response(status === 204 ? null : JSON.stringify(result.body ?? {}), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export const salesSession = {
  accessToken: 'test-token',
  expiresIn: 900,
  user: { id: 'u-sales', email: 'sales@test', displayName: 'Sara Sales', roles: ['SALES_USER'] },
};

export function renderRoute(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(
    <Providers queryClient={createQueryClient()} testEnv>
      <RouterProvider router={router} />
    </Providers>,
  );
}
