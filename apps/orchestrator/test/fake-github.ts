import { generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRepo {
  id: number;
  fullName: string;
  defaultBranch: string;
  headSha: string;
  files: Record<string, string>;
  private?: boolean;
}

export interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
}

/** A tiny GitHub REST stand-in for the endpoints GitHubAppService uses. */
export class FakeGitHub {
  readonly requests: RecordedRequest[] = [];
  readonly privateKeyPem: string;
  installations: Array<{ id: number; repos: FakeRepo[] }> = [];
  private server: Server | null = null;
  private tokenSeq = 0;
  baseUrl = '';

  constructor() {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => void this.handle(req, res));
    this.server = server;
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise((r) => this.server?.close(r));
  }

  reset(): void {
    this.requests.length = 0;
  }

  tokenRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/access_tokens'));
  }

  private repo(owner: string, name: string): FakeRepo | undefined {
    return this.installations
      .flatMap((i) => i.repos)
      .find((r) => r.fullName === `${owner}/${name}`);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const body: unknown = raw ? JSON.parse(raw) : null;
    this.requests.push({
      method: req.method ?? '',
      path: url.pathname,
      authorization: req.headers.authorization,
      body,
    });
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
    };
    const auth = req.headers.authorization ?? '';
    const p = url.pathname;

    if (p === '/app/installations' && req.method === 'GET') {
      if (!auth.startsWith('bearer ') && !auth.startsWith('Bearer '))
        return send(401, { message: 'JWT required' });
      return send(
        200,
        this.installations.map((i) => ({ id: i.id })),
      );
    }
    let m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(p);
    if (m && req.method === 'POST') {
      if (!/^bearer /i.test(auth)) return send(401, { message: 'JWT required' });
      const installation = this.installations.find((i) => i.id === Number(m?.[1]));
      if (!installation) return send(404, { message: 'Not Found' });
      return send(201, {
        token: `ghs_fake${String(++this.tokenSeq).padStart(28, '0')}`,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        _installation: installation.id,
      });
    }
    if (p === '/installation/repositories' && req.method === 'GET') {
      const repos = this.installations.flatMap((i) => i.repos);
      return send(200, {
        total_count: repos.length,
        repositories: repos.map((r) => ({
          id: r.id,
          full_name: r.fullName,
          default_branch: r.defaultBranch,
          private: r.private ?? false,
        })),
      });
    }
    if (!/^token |^bearer /i.test(auth)) return send(401, { message: 'Requires authentication' });

    m = /^\/repos\/([^/]+)\/([^/]+)\/branches\/(.+)$/.exec(p);
    if (m) {
      const repo = this.repo(m[1]!, m[2]!);
      if (!repo || repo.defaultBranch !== decodeURIComponent(m[3]!))
        return send(404, { message: 'Branch not found' });
      return send(200, { name: repo.defaultBranch, commit: { sha: repo.headSha } });
    }
    m = /^\/repos\/([^/]+)\/([^/]+)\/git\/trees\/([0-9a-f]{40})$/.exec(p);
    if (m) {
      const repo = this.repo(m[1]!, m[2]!);
      if (!repo || repo.headSha !== m[3]) return send(404, { message: 'Not Found' });
      return send(200, {
        sha: repo.headSha,
        truncated: false,
        tree: Object.keys(repo.files).map((path) => ({ path, type: 'blob' })),
      });
    }
    m = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(p);
    if (m) {
      const repo = this.repo(m[1]!, m[2]!);
      const path = decodeURIComponent(m[3]!);
      const text = repo?.files[path];
      if (!repo || text === undefined || url.searchParams.get('ref') !== repo.headSha) {
        return send(404, { message: 'Not Found' });
      }
      return send(200, {
        type: 'file',
        path,
        size: Buffer.byteLength(text),
        encoding: 'base64',
        content: Buffer.from(text).toString('base64'),
      });
    }
    return send(404, { message: `fake GitHub has no route for ${req.method} ${p}` });
  }
}
