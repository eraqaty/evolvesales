import { execFileSync } from 'node:child_process';
import path from 'node:path';
import Docker from 'dockerode';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DockerLauncher,
  dockerClient,
  JOB_LABEL,
  type LaunchSpec,
} from '../src/agent/docker-launcher.js';

/**
 * Runs real containers (§9 exit criterion: "container gone afterwards").
 * A stub runner (plain Node image + inline script) reports what it can see from inside.
 */
const NODE_IMAGE =
  'node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee';
const SOCKET_PROXY_IMAGE =
  'tecnativa/docker-socket-proxy@sha256:be1ac64f33bd82043beb504822a17ba6b71668ea1ad7cf51a9a01d27bb7ab047';
const RUNNER_IMAGE = 'evolvesales/agent-runner:local';
const AGENT_NETWORK = 'evolvesales-agent-net';
const SECRET = 'ghs_THISMUSTNEVERLEAKxxxxxxxxxxxxxxxx';

const STUB = String.raw`
let d = '';
const onData = (c) => {
  d += c;
  // Same rule as the real runner: skip lines until one is the job document.
  const lines = d.split(String.fromCharCode(10));
  d = lines.pop();
  const job = lines.find((l) => l.startsWith('{"mode"'));
  if (!job) return;
  process.stdin.off('data', onData);
  process.stdin.destroy();
  run(JSON.parse(job));
};
process.stdin.on('data', onData);
function run(j) {
  const fs = require('fs');
  const out = (e) => process.stdout.write(JSON.stringify(e) + '\n');
  const capEff = /CapEff:\s+(\w+)/.exec(fs.readFileSync('/proc/self/status', 'utf8'))[1];
  let rootWritable = true;
  try { fs.writeFileSync('/evil', 'x'); } catch { rootWritable = false; }
  let workspaceWritable = true;
  try { fs.writeFileSync('/workspace/ok', 'x'); } catch { workspaceWritable = false; }
  const envHasSecret = Object.values(process.env).some((v) => String(v).includes(j.secrets.githubToken));
  const facts = {
    uid: process.getuid(), capEff, rootWritable, workspaceWritable, envHasSecret,
    gotSecret: j.secrets.githubToken.length > 0,
    nets: Object.keys(require('os').networkInterfaces()),
    dockerSock: fs.existsSync('/var/run/docker.sock'),
  };
  out({ type: 'log', level: 'info', source: 'runner', message: JSON.stringify(facts) });
  if (j.mode === 'sleep') { setInterval(() => {}, 1000); return; }
  setTimeout(() => out({ type: 'result', ok: true, plan: { x: 1 }, model: 'stub', headSha: 'a'.repeat(40), numTurns: 1,
        usage: { inputTokens: 1, outputTokens: 2 }, costUsd: 0.01 }), 1500);
}`;

async function ensureImage(docker: Docker, ref: string): Promise<void> {
  try {
    await docker.getImage(ref).inspect();
  } catch {
    const stream = await docker.pull(ref);
    await new Promise((resolve, reject) =>
      docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve(null))),
    );
  }
}

async function imageExists(docker: Docker, ref: string): Promise<boolean> {
  return docker
    .getImage(ref)
    .inspect()
    .then(
      () => true,
      () => false,
    );
}

async function networkExists(docker: Docker, name: string): Promise<boolean> {
  return docker
    .getNetwork(name)
    .inspect()
    .then(
      () => true,
      () => false,
    );
}

function stubSpec(overrides: Partial<LaunchSpec> & { mode?: string } = {}): LaunchSpec {
  const { mode = 'normal', ...rest } = overrides;
  return {
    jobId: `test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    image: NODE_IMAGE,
    cmd: ['node', '-e', STUB],
    stdin: JSON.stringify({ mode, secrets: { githubToken: SECRET } }),
    timeoutMs: 60_000,
    network: null,
    env: { HTTPS_PROXY: 'http://egress-proxy:3128' },
    ...rest,
  };
}

async function leftovers(docker: Docker, jobId: string) {
  return docker.listContainers({ all: true, filters: { label: [`${JOB_LABEL}=${jobId}`] } });
}

function factsOf(lines: string[]): Record<string, unknown> {
  const line = lines.find((l) => l.startsWith('{"uid"'));
  if (!line) throw new Error(`no facts line in ${JSON.stringify(lines)}`);
  return JSON.parse(line) as Record<string, unknown>;
}

async function checkLockedDown(docker: Docker, launcher: DockerLauncher) {
  const messages: string[] = [];
  let inspected: Docker.ContainerInspectInfo | null = null;
  const spec = stubSpec({
    onEvent: (e) => {
      if (e.type !== 'log') return;
      messages.push(e.message);
      // While it runs: nothing secret is visible through `docker inspect`.
      void leftovers(docker, spec.jobId).then(async (list) => {
        if (list[0]) inspected = await docker.getContainer(list[0].Id).inspect();
      });
    },
  });
  const result = await launcher.run(spec);
  await new Promise((r) => setTimeout(r, 300));

  expect(result.exitCode).toBe(0);
  expect(result.result).toMatchObject({ type: 'result', ok: true, model: 'stub' });
  expect(factsOf(messages)).toEqual({
    uid: 10001,
    capEff: '0000000000000000',
    rootWritable: false,
    workspaceWritable: true,
    envHasSecret: false,
    gotSecret: true,
    nets: ['lo'],
    dockerSock: false,
  });
  expect(result.removed).toBe(true);
  expect(await leftovers(docker, spec.jobId)).toHaveLength(0);
  expect(inspected).not.toBeNull();
  expect(JSON.stringify(inspected)).not.toContain(SECRET);
  return result;
}

describe('DockerLauncher on real Docker', () => {
  const docker = new Docker();
  const launcher = new DockerLauncher(docker);

  beforeAll(async () => {
    await ensureImage(docker, NODE_IMAGE);
  }, 300_000);

  it('runs the runner locked down, passes secrets only on stdin, and removes the container', async () => {
    const result = await checkLockedDown(docker, launcher);
    expect(result.imageDigest).toMatch(/^sha256:/);
  });

  it('kills a runner that exceeds its wall-clock limit and still removes it', async () => {
    const lines: string[] = [];
    const spec = stubSpec({
      mode: 'sleep',
      timeoutMs: 4_000,
      onEvent: (e) => lines.push(JSON.stringify(e)),
      onText: (l) => lines.push(l),
    });
    const result = await launcher.run(spec);
    // Shows the exit code and output if the runner ended on its own.
    expect({ timedOut: result.timedOut, exitCode: result.exitCode, lines }).toMatchObject({
      timedOut: true,
    });
    expect(result.result).toBeNull();
    expect(result.removed).toBe(true);
    expect(await leftovers(docker, spec.jobId)).toHaveLength(0);
  });

  it('reaps orphaned runner containers', async () => {
    const orphan = await docker.createContainer({
      Image: NODE_IMAGE,
      Cmd: ['sleep', '60'],
      Labels: { [JOB_LABEL]: 'orphan', 'evolvesales.role': 'agent-runner' },
    });
    const reaped = await launcher.reapOrphans();
    expect(reaped).toContain(orphan.id);
    expect(await leftovers(docker, 'orphan')).toHaveLength(0);
  });
});

describe('through docker-socket-proxy (restricted Docker API)', () => {
  const docker = new Docker();
  let proxy: Docker.Container | null = null;
  let endpoint = '';

  beforeAll(async () => {
    await ensureImage(docker, NODE_IMAGE);
    await ensureImage(docker, SOCKET_PROXY_IMAGE);
    const template = path.resolve(
      import.meta.dirname,
      '../../../deploy/docker-socket-proxy/haproxy.cfg.template',
    );
    proxy = await docker.createContainer({
      Image: SOCKET_PROXY_IMAGE,
      Env: ['DISABLE_IPV6=1', 'LOG_LEVEL=warning'],
      ExposedPorts: { '2375/tcp': {} },
      HostConfig: {
        Binds: [
          '/var/run/docker.sock:/var/run/docker.sock:ro',
          `${template}:/usr/local/etc/haproxy/haproxy.cfg.template:ro`,
        ],
        PortBindings: { '2375/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] },
      },
    });
    await proxy.start();
    const info = await proxy.inspect();
    const port = info.NetworkSettings.Ports['2375/tcp']?.[0]?.HostPort;
    endpoint = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const ok = await fetch(`${endpoint}/_ping`).then(
        (r) => r.ok,
        () => false,
      );
      if (ok) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }, 300_000);

  afterAll(async () => {
    await proxy?.remove({ force: true });
  });

  it('runs a job end to end (attach, start, wait, kill, remove all pass the proxy)', async () => {
    const result = await checkLockedDown(
      new Docker(),
      new DockerLauncher(dockerClient(endpoint.replace('http:', 'tcp:'))),
    );
    expect(result.result).toMatchObject({ ok: true });
  });

  it('refuses everything the launcher does not need', async () => {
    const own = (await proxy?.inspect())?.Id ?? 'x';
    const denied = [
      ['POST', `/containers/${own}/exec`],
      ['GET', `/containers/${own}/archive?path=/etc`],
      ['GET', `/containers/${own}/export`],
      ['POST', `/containers/${own}/update`],
      ['GET', '/info'],
      ['POST', '/images/create?fromImage=alpine'],
      ['POST', '/volumes/create'],
      ['GET', '/secrets'],
      ['POST', '/build'],
    ] as const;
    for (const [method, url] of denied) {
      const status = await fetch(`${endpoint}${url}`, { method }).then((r) => r.status);
      expect(status, `${method} ${url}`).toBe(403);
    }
    expect((await fetch(`${endpoint}/containers/json`)).status).toBe(200);
  });
});

/**
 * Needs the local agent stack (`pnpm agents:up`) and the runner image (`pnpm runner:build`);
 * skipped otherwise (e.g. in CI). Uses the real network path: internal network → egress proxy.
 */
describe('agent network + egress proxy (local stack)', async () => {
  const docker = new Docker();
  const ready =
    (await networkExists(docker, AGENT_NETWORK)) && (await imageExists(docker, RUNNER_IMAGE));
  const launcher = new DockerLauncher(docker);
  const proxyEnv = {
    HTTPS_PROXY: 'http://egress-proxy:3128',
    HTTP_PROXY: 'http://egress-proxy:3128',
    https_proxy: 'http://egress-proxy:3128',
    http_proxy: 'http://egress-proxy:3128',
  };

  it.skipIf(!ready)(
    'has no direct route out and only allowlisted hosts via the proxy',
    async () => {
      const probe = String.raw`
      const net = require('net'); const http = require('http');
      const out = (m) => process.stdout.write(JSON.stringify({ type: 'log', level: 'info', source: 'runner', message: m }) + '\n');
      const direct = () => new Promise((r) => { const s = net.connect({ host: '1.1.1.1', port: 443, timeout: 4000 });
        s.on('connect', () => { s.destroy(); r('open'); }); s.on('error', (e) => r('error:' + e.code)); s.on('timeout', () => { s.destroy(); r('timeout'); }); });
      const tunnel = (target) => new Promise((r) => { const q = http.request({ host: 'egress-proxy', port: 3128, method: 'CONNECT', path: target });
        q.on('connect', (res, s) => { s.destroy(); r(res.statusCode); }); q.on('error', (e) => r('error:' + e.code)); q.end(); });
      (async () => {
        out('direct=' + await direct());
        out('github=' + await tunnel('github.com:443'));
        out('example=' + await tunnel('example.com:443'));
        out('ssh=' + await tunnel('github.com:22'));
        process.stdout.write(JSON.stringify({ type: 'result', ok: false, error: 'probe done' }) + '\n');
      })();`;
      const lines: string[] = [];
      const result = await launcher.run({
        ...stubSpec(),
        cmd: ['node', '-e', probe],
        network: AGENT_NETWORK,
        onEvent: (e) => {
          if (e.type === 'log') lines.push(e.message);
        },
      });
      expect(result.removed).toBe(true);
      expect(lines.find((l) => l.startsWith('direct='))).not.toBe('direct=open');
      expect(lines).toContain('github=200');
      expect(lines).toContain('example=403');
      expect(lines).toContain('ssh=403');
    },
  );

  it.skipIf(!ready)(
    'the real runner image clones the baseline through the proxy and stays read-only',
    { timeout: 300_000 },
    async () => {
      // A commit that exists on GitHub (the merged main of this repository).
      const sha = execFileSync('git', ['rev-parse', 'origin/main'], { encoding: 'utf8' }).trim();
      const lines: string[] = [];
      const result = await launcher.run({
        jobId: `test-real-${Date.now()}`,
        image: RUNNER_IMAGE,
        timeoutMs: 5 * 60_000,
        network: AGENT_NETWORK,
        env: proxyEnv,
        stdin: JSON.stringify({
          input: {
            protocol: 1,
            mode: 'analyze',
            jobId: '0193a3b2-0000-7000-8000-000000000001',
            repository: {
              fullName: 'eraqaty/evolvesales',
              cloneUrl: 'https://github.com/eraqaty/evolvesales.git',
            },
            baselineSha: sha,
            changeRequest: {
              key: 'CR-TEST',
              title: 't',
              originalRequest: 'r',
              structured: {},
              screen: 's',
              screenContext: null,
            },
            limits: { maxTurns: 2, maxBudgetUsd: 0.05 },
            model: 'claude-opus-5-5',
          },
          // A public repository needs no token; the AI key is deliberately invalid, so no spend.
          secrets: { githubToken: SECRET, anthropicApiKey: 'sk-ant-invalid-test-key-0000' },
        }),
        onEvent: (e) => {
          if (e.type === 'log') lines.push(e.message);
        },
        onText: (l) => lines.push(l),
      });
      expect(
        lines.some(
          (l) => l.startsWith(`workspace ready:`) && l.includes(sha) && l.includes('read-only'),
        ),
      ).toBe(true);
      // The model call fails (invalid key): reported as a failed result, never a fake plan.
      expect(result.result).toMatchObject({ type: 'result', ok: false });
      expect(result.removed).toBe(true);
      expect(JSON.stringify(lines)).not.toContain(SECRET);
      expect(JSON.stringify(lines)).not.toContain('sk-ant-invalid-test-key-0000');
    },
  );
});
