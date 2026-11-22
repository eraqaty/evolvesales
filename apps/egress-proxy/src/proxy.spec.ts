import { createServer, request, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEgressProxy, decide, DEFAULT_ALLOWLIST, parseAllowlist } from './proxy.js';

describe('egress decisions', () => {
  const list = [...DEFAULT_ALLOWLIST, '.example.org'];

  it('allows HTTPS tunnels to allowlisted hosts only', () => {
    expect(decide('CONNECT', 'api.anthropic.com:443', list)).toEqual({
      allow: true,
      host: 'api.anthropic.com',
      port: 443,
    });
    expect(decide('CONNECT', 'GITHUB.COM:443', list)).toMatchObject({
      allow: true,
      host: 'github.com',
    });
    expect(decide('CONNECT', 'a.example.org:443', list)).toMatchObject({ allow: true });
    expect(decide('CONNECT', 'evil.com:443', list)).toMatchObject({ allow: false });
    expect(decide('CONNECT', 'github.com.evil.com:443', list)).toMatchObject({ allow: false });
    expect(decide('CONNECT', 'example.org:443', list)).toMatchObject({ allow: false });
  });

  it('refuses plain HTTP, other ports and IP literals', () => {
    expect(decide('GET', 'http://github.com/', list)).toMatchObject({ allow: false });
    expect(decide('CONNECT', 'github.com:22', list)).toMatchObject({ allow: false });
    expect(decide('CONNECT', '140.82.121.4:443', list)).toMatchObject({ allow: false });
    expect(decide('CONNECT', '[::1]:443', list)).toMatchObject({ allow: false });
    expect(decide('CONNECT', 'github.com', list)).toMatchObject({ allow: false });
  });

  it('parses the allowlist, defaulting to the plan list', () => {
    expect(parseAllowlist(undefined)).toEqual([...DEFAULT_ALLOWLIST]);
    expect(parseAllowlist(' A.com, .b.org ,')).toEqual(['a.com', '.b.org']);
  });
});

describe('egress proxy server', () => {
  let upstream: Server;
  let proxy: Server;
  let proxyPort = 0;
  const logs: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    upstream = createServer((_req, res) => res.end('hello from upstream'));
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    proxy = createEgressProxy({
      allowlist: ['allowed.test'],
      log: (e) => logs.push(e),
      // Tunnels to allowed.test:443 land on the local plain-HTTP server.
      dial: () => connect({ host: '127.0.0.1', port: upstreamPort }),
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    proxyPort = (proxy.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((r) => proxy.close(r));
    await new Promise((r) => upstream.close(r));
  });

  const tunnel = (target: string) =>
    new Promise<{ status: number; socket: Socket }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: target });
      req.on('connect', (res, socket) => resolve({ status: res.statusCode ?? 0, socket }));
      req.on('error', reject);
      req.end();
    });

  it('tunnels to an allowed host', async () => {
    const { status, socket } = await tunnel('allowed.test:443');
    expect(status).toBe(200);
    const body = await new Promise<string>((resolve) => {
      let data = '';
      socket.on('data', (c: Buffer) => (data += c.toString()));
      socket.on('end', () => resolve(data));
      socket.write('GET / HTTP/1.1\r\nHost: allowed.test\r\nConnection: close\r\n\r\n');
    });
    expect(body).toContain('hello from upstream');
    expect(logs.some((l) => l.decision === 'allow' && l.target === 'allowed.test:443')).toBe(true);
  });

  it('blocks and logs everything else', async () => {
    const { status, socket } = await tunnel('blocked.test:443');
    socket.destroy();
    expect(status).toBe(403);
    expect(logs.some((l) => l.decision === 'deny' && l.target === 'blocked.test:443')).toBe(true);

    const plain = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: proxyPort, path: 'http://allowed.test/?token=secret' },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(plain).toBe(403);
    // Query strings are never logged.
    expect(JSON.stringify(logs)).not.toContain('secret');
  });
});
