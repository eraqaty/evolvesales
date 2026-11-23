import { describe, expect, it } from 'vitest';
import {
  CONTAINER_LIMITS,
  dockerClient,
  JOB_LABEL,
  runnerContainerOptions,
} from './docker-launcher.js';

describe('runner container options (§9)', () => {
  const opts = runnerContainerOptions(
    {
      jobId: 'job-1',
      image: 'evolvesales/agent-runner:local',
      stdin: '{"secrets":"never here"}',
      timeoutMs: 1000,
      network: 'evolvesales-agent-net',
      env: { HTTPS_PROXY: 'http://egress-proxy:3128' },
    },
    'sha256:abc',
  );
  const host = opts.HostConfig ?? {};

  it('runs the inspected image as a non-root user', () => {
    expect(opts.Image).toBe('sha256:abc');
    expect(opts.User).toBe('10001:10001');
    expect(opts.Labels?.[JOB_LABEL]).toBe('job-1');
  });

  it('locks the container down', () => {
    expect(host.ReadonlyRootfs).toBe(true);
    expect(host.CapDrop).toEqual(['ALL']);
    expect(host.SecurityOpt).toEqual(['no-new-privileges:true']);
    expect(host.Privileged).toBe(false);
    expect(host.Binds).toEqual([]);
    expect(host.Mounts).toEqual([]);
    expect(host.Devices).toEqual([]);
    expect(host.NanoCpus).toBe(CONTAINER_LIMITS.nanoCpus);
    expect(host.Memory).toBe(4 * 1024 ** 3);
    expect(host.MemorySwap).toBe(host.Memory);
    expect(host.PidsLimit).toBe(512);
    expect(Object.keys(host.Tmpfs ?? {}).sort()).toEqual(['/home/agent', '/tmp', '/workspace']);
    for (const t of Object.values(host.Tmpfs ?? {})) expect(t).toMatch(/noexec,nosuid,nodev,size=/);
  });

  it('joins only the internal agent network, or none', () => {
    expect(host.NetworkMode).toBe('evolvesales-agent-net');
    expect(opts.NetworkDisabled).toBe(false);
    const isolated = runnerContainerOptions(
      { jobId: 'j', image: 'i', stdin: '', timeoutMs: 1, network: null, env: {} },
      'i',
    );
    expect(isolated.HostConfig?.NetworkMode).toBe('none');
    expect(isolated.NetworkDisabled).toBe(true);
  });

  it('keeps secrets out of the inspectable configuration', () => {
    expect(JSON.stringify(opts)).not.toContain('never here');
    expect(opts.Env).toEqual(['HTTPS_PROXY=http://egress-proxy:3128']);
    expect(opts.OpenStdin).toBe(true);
    expect(opts.StdinOnce).toBe(true);
  });

  it('connects to the socket proxy over TCP when configured', () => {
    const docker = dockerClient('tcp://127.0.0.1:2375');
    expect(docker.modem).toMatchObject({ host: '127.0.0.1', port: 2375, protocol: 'http' });
  });
});
