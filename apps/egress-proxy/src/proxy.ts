import { connect, isIP, type Socket } from 'node:net';
import { createServer, type IncomingMessage, type Server } from 'node:http';

/**
 * Egress proxy for agent containers (§9). The containers sit on an internal-only Docker
 * network; this proxy is their only route out. It accepts only HTTPS tunnels (CONNECT) to
 * port 443 of allowlisted host names. Plain HTTP, other ports and IP literals are refused.
 * Every decision is logged as one JSON line (no request contents: they are encrypted anyway).
 */

/** Exact hosts and suffixes ('.example.com' matches subdomains). */
export const DEFAULT_ALLOWLIST = [
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'api.anthropic.com',
  'api.openai.com',
  'registry.npmjs.org',
  'binaries.prisma.sh',
] as const;

export function parseAllowlist(value: string | undefined): string[] {
  const list = (value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.length > 0 ? list : [...DEFAULT_ALLOWLIST];
}

export type Decision =
  { allow: true; host: string; port: number } | { allow: false; reason: string };

export function decide(
  method: string | undefined,
  target: string | undefined,
  allowlist: readonly string[],
): Decision {
  if (method !== 'CONNECT')
    return { allow: false, reason: 'only HTTPS tunnels (CONNECT) are allowed' };
  const match = /^([^:\s]+):(\d{1,5})$/.exec(target ?? '');
  if (!match) return { allow: false, reason: 'malformed CONNECT target' };
  const host = match[1]!.toLowerCase().replace(/\.$/, '');
  const port = Number(match[2]);
  if (port !== 443) return { allow: false, reason: `port ${port} is not allowed` };
  if (isIP(host) !== 0) return { allow: false, reason: 'IP addresses are not allowed' };
  const allowed = allowlist.some((entry) =>
    entry.startsWith('.') ? host.endsWith(entry) && host.length > entry.length : host === entry,
  );
  return allowed
    ? { allow: true, host, port }
    : { allow: false, reason: `${host} is not on the allowlist` };
}

export interface ProxyOptions {
  allowlist: readonly string[];
  log?: (entry: Record<string, unknown>) => void;
  /** Where allowed tunnels go; tests redirect them to a local server. */
  dial?: (host: string, port: number) => Socket;
}

export function createEgressProxy(options: ProxyOptions): Server {
  const log = options.log ?? ((e) => process.stdout.write(`${JSON.stringify(e)}\n`));
  const dial = options.dial ?? ((host, port) => connect({ host, port }));

  const server = createServer((req, res) => {
    const d = decide(req.method, req.url, options.allowlist);
    log({
      at: new Date().toISOString(),
      decision: 'deny',
      method: req.method,
      target: safeTarget(req),
      reason: d.allow ? 'unexpected' : d.reason,
      client: req.socket.remoteAddress,
    });
    res
      .writeHead(403, { 'content-type': 'text/plain', connection: 'close' })
      .end('Blocked by the EvolveSales egress proxy\n');
  });

  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    const d = decide(req.method, req.url, options.allowlist);
    const base = {
      at: new Date().toISOString(),
      method: 'CONNECT',
      target: safeTarget(req),
      client: req.socket.remoteAddress,
    };
    if (!d.allow) {
      log({ ...base, decision: 'deny', reason: d.reason });
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    log({ ...base, decision: 'allow' });
    const upstream = dial(d.host, d.port);
    upstream.setTimeout(10 * 60_000, () => upstream.destroy());
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    const close = () => {
      upstream.destroy();
      client.destroy();
    };
    upstream.on('error', (err) => {
      log({ ...base, decision: 'error', reason: err.message });
      if (client.writable) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      close();
    });
    client.on('error', close);
  });

  return server;
}

function safeTarget(req: IncomingMessage): string {
  // Only host:port (or the path without query) is logged.
  return (req.url ?? '').split('?')[0]!.slice(0, 300);
}

/** Started by deploy/compose.dev.yml: `EGRESS_PROXY_MAIN=1 node src/proxy.ts` (Node 22 strips types). */
if (process.env.EGRESS_PROXY_MAIN === '1') {
  const port = Number(process.env.PORT ?? 3128);
  const allowlist = parseAllowlist(process.env.EGRESS_ALLOWLIST);
  createEgressProxy({ allowlist }).listen(port, '0.0.0.0', () => {
    process.stdout.write(
      `${JSON.stringify({ at: new Date().toISOString(), listening: port, allowlist })}\n`,
    );
  });
}
