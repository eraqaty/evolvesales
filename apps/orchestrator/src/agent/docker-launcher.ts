import { PassThrough } from 'node:stream';
import { Injectable, Logger } from '@nestjs/common';
import Docker from 'dockerode';
import { parseRunnerEvent, type RunnerEvent, type RunnerResultEvent } from '@evolvesales/shared';

export const JOB_LABEL = 'evolvesales.job';
export const ROLE_LABEL = 'evolvesales.role';
const RUNNER_ROLE = 'agent-runner';
const RUNNER_UID = '10001';

/** Hard limits from §9; tests may lower them, nothing may raise them above these. */
export const CONTAINER_LIMITS = {
  nanoCpus: 2_000_000_000,
  memoryBytes: 4 * 1024 ** 3,
  pids: 512,
  /** Total stdout+stderr a job may produce before it is killed. */
  outputBytes: 8 * 1024 ** 2,
} as const;

export interface LaunchSpec {
  jobId: string;
  image: string;
  /** Written to stdin as one line (JSON). The only channel for secrets. */
  stdin: string;
  timeoutMs: number;
  /** Docker network to join, or null for no network at all. */
  network: string | null;
  /** Non-secret environment only (it is visible in `docker inspect`). */
  env: Record<string, string>;
  /** Overrides the image's command (tests use a stub runner). */
  cmd?: string[];
  onEvent?: (event: RunnerEvent) => void;
  /** Output lines that are not protocol events (e.g. crash traces). */
  onText?: (line: string, stream: 'stdout' | 'stderr') => void;
}

export interface LaunchResult {
  containerId: string;
  /** Content digest of the image that ran (repo digest if pinned, else the image id). */
  imageDigest: string;
  exitCode: number | null;
  timedOut: boolean;
  outputLimitHit: boolean;
  result: RunnerResultEvent | null;
  /** Whether the container was confirmed gone afterwards. */
  removed: boolean;
}

export class RunnerImageMissingError extends Error {
  constructor(image: string) {
    super(
      `Runner image ${image} is not available to Docker. Build it with "pnpm runner:build" and set AGENT_RUNNER_IMAGE.`,
    );
    this.name = 'RunnerImageMissingError';
  }
}

export function dockerClient(host: string | undefined): Docker {
  if (!host) return new Docker();
  const url = new URL(host.replace(/^tcp:/, 'http:'));
  return new Docker({
    host: url.hostname,
    port: Number(url.port || 2375),
    protocol: url.protocol === 'https:' ? 'https' : 'http',
  });
}

/** The container settings of §9, in one place so tests can assert on them. */
export function runnerContainerOptions(
  spec: LaunchSpec,
  imageRef: string,
): Docker.ContainerCreateOptions {
  const tmpfs = (size: string) =>
    `rw,noexec,nosuid,nodev,size=${size},uid=${RUNNER_UID},gid=${RUNNER_UID},mode=0700`;
  return {
    Image: imageRef,
    ...(spec.cmd && { Cmd: spec.cmd }),
    User: `${RUNNER_UID}:${RUNNER_UID}`,
    WorkingDir: '/workspace',
    Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
    Labels: { [JOB_LABEL]: spec.jobId, [ROLE_LABEL]: RUNNER_ROLE },
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: true,
    StdinOnce: true,
    Tty: false,
    NetworkDisabled: spec.network === null,
    StopTimeout: 5,
    HostConfig: {
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Privileged: false,
      Init: true,
      NanoCpus: CONTAINER_LIMITS.nanoCpus,
      Memory: CONTAINER_LIMITS.memoryBytes,
      MemorySwap: CONTAINER_LIMITS.memoryBytes,
      PidsLimit: CONTAINER_LIMITS.pids,
      Tmpfs: {
        '/workspace': tmpfs('2g'),
        '/tmp': tmpfs('256m'),
        '/home/agent': tmpfs('512m'),
      },
      NetworkMode: spec.network ?? 'none',
      // No Binds, no Mounts, no Docker socket, no host paths, no devices.
      Binds: [],
      Mounts: [],
      Devices: [],
      AutoRemove: false,
      RestartPolicy: { Name: 'no' },
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '1' } },
    },
  };
}

/**
 * Runs one agent-runner container to completion (§9) and always removes it afterwards.
 * Talks to Docker through docker-socket-proxy in real deployments (AGENT_DOCKER_HOST).
 */
@Injectable()
export class DockerLauncher {
  private readonly logger = new Logger(DockerLauncher.name);

  constructor(private readonly docker: Docker) {}

  async run(spec: LaunchSpec): Promise<LaunchResult> {
    const image = await this.inspectImage(spec.image);
    const container = await this.docker.createContainer(runnerContainerOptions(spec, image.ref));
    let exitCode: number | null = null;
    let timedOut = false;
    let outputLimitHit = false;
    let result: RunnerResultEvent | null = null;

    try {
      const stream = await container.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true,
        hijack: true,
      });
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      container.modem.demuxStream(stream, stdout, stderr);
      // The attach stream ends after the container's last output; wait for it, not a timer.
      const drained = new Promise<void>((resolve) => {
        stream.once('end', resolve);
        stream.once('close', resolve);
        stream.once('error', () => resolve());
      });

      let outputBytes = 0;
      const kill = (why: string) => {
        this.logger.warn(`killing runner for job ${spec.jobId}: ${why}`);
        container.kill().catch(() => undefined);
      };
      const consume = (source: PassThrough, name: 'stdout' | 'stderr') => {
        let pending = '';
        source.on('data', (chunk: Buffer) => {
          outputBytes += chunk.length;
          if (outputBytes > CONTAINER_LIMITS.outputBytes && !outputLimitHit) {
            outputLimitHit = true;
            kill('output limit exceeded');
            return;
          }
          pending += chunk.toString('utf8');
          let nl = pending.indexOf('\n');
          while (nl >= 0) {
            const line = pending.slice(0, nl);
            pending = pending.slice(nl + 1);
            handleLine(line, name);
            nl = pending.indexOf('\n');
          }
        });
        source.on('end', () => {
          if (pending) handleLine(pending, name);
        });
      };
      const handleLine = (line: string, name: 'stdout' | 'stderr') => {
        if (line.trim() === '') return;
        const event = name === 'stdout' ? parseRunnerEvent(line) : null;
        if (event?.type === 'result') result = event;
        if (event) spec.onEvent?.(event);
        else spec.onText?.(line, name);
      };
      consume(stdout, 'stdout');
      consume(stderr, 'stderr');

      await container.start();
      // One newline-terminated line; the runner stops reading after it. The write side is
      // left open on purpose: half-closing a Windows named pipe closes it for output too.
      // The leading newline matters: over a Windows named pipe docker-modem's attach options
      // can arrive in stdin first; this puts them on their own line, which the runner skips.
      stream.write(`\n${spec.stdin.replace(/\n/g, ' ')}\n`);

      const timer = setTimeout(() => {
        timedOut = true;
        kill(`wall-clock limit of ${Math.round(spec.timeoutMs / 1000)} s reached`);
      }, spec.timeoutMs);
      try {
        const waited = (await container.wait()) as { StatusCode?: number };
        exitCode = typeof waited.StatusCode === 'number' ? waited.StatusCode : null;
      } finally {
        clearTimeout(timer);
      }
      // Read everything the runner wrote before deciding on the result (bounded wait).
      await Promise.race([drained, new Promise((r) => setTimeout(r, 15_000).unref())]);
      stdout.end();
      stderr.end();
      await new Promise((r) => setImmediate(r));
    } finally {
      await container.remove({ force: true, v: true }).catch((err: unknown) => {
        this.logger.error(
          `could not remove runner container ${container.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }

    return {
      containerId: container.id,
      imageDigest: image.digest,
      exitCode,
      timedOut,
      outputLimitHit,
      result: timedOut || outputLimitHit ? null : result,
      removed: await this.isGone(container.id),
    };
  }

  /** Removes runner containers left over from a crash (label `evolvesales.job`). */
  async reapOrphans(): Promise<string[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${ROLE_LABEL}=${RUNNER_ROLE}`] },
    });
    const removed: string[] = [];
    for (const c of containers) {
      await this.docker
        .getContainer(c.Id)
        .remove({ force: true, v: true })
        .then(() => removed.push(c.Id))
        .catch(() => undefined);
    }
    return removed;
  }

  private async inspectImage(image: string): Promise<{ ref: string; digest: string }> {
    try {
      const info = await this.docker.getImage(image).inspect();
      const pinned = image.includes('@sha256:') ? image.split('@')[1] : undefined;
      // Run the exact image we inspected, by id, so a re-tag mid-job can't swap it.
      return { ref: info.Id, digest: pinned ?? info.RepoDigests?.[0]?.split('@')[1] ?? info.Id };
    } catch (err) {
      if (statusOf(err) === 404) throw new RunnerImageMissingError(image);
      throw err;
    }
  }

  private async isGone(id: string): Promise<boolean> {
    try {
      await this.docker.getContainer(id).inspect();
      return false;
    } catch (err) {
      return statusOf(err) === 404;
    }
  }
}

function statusOf(err: unknown): number | undefined {
  return typeof err === 'object' &&
    err !== null &&
    'statusCode' in err &&
    typeof err.statusCode === 'number'
    ? err.statusCode
    : undefined;
}
