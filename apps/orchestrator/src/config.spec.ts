import { describe, expect, it } from 'vitest';
import { OrchestratorConfig, orchestratorEnvSchema } from './config.js';

const env = (extra: Record<string, string> = {}) =>
  orchestratorEnvSchema.parse({ DATABASE_URL: 'postgres://x', ...extra });
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n';

describe('orchestrator config', () => {
  it('needs both GitHub App settings or neither', () => {
    expect(() => env({ GITHUB_APP_ID: '1' })).toThrow(/GITHUB_APP_PRIVATE_KEY_PATH/);
    expect(new OrchestratorConfig(env()).github).toBeNull();
    const c = new OrchestratorConfig(
      env({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY_PATH: 'k.pem' }),
      () => PEM,
    );
    expect(c.github).toMatchObject({
      appId: '1',
      apiBaseUrl: 'https://api.github.com',
      cloneBaseUrl: 'https://github.com',
    });
  });

  it('refuses a key file that is not a PEM key, without echoing it', () => {
    const run = () =>
      new OrchestratorConfig(
        env({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY_PATH: 'k.pem' }),
        () => 'top-secret',
      );
    expect(run).toThrow(/not a PEM private key/);
    expect(run).not.toThrow(/top-secret/);
  });

  it('reports what the analysis agent is missing', () => {
    expect(new OrchestratorConfig(env()).agentRuntime).toEqual({
      missing: expect.stringMatching(/ANTHROPIC_API_KEY/),
    });
    expect(new OrchestratorConfig(env({ ANTHROPIC_API_KEY: 'k' })).agentRuntime).toEqual({
      missing: expect.stringMatching(/AGENT_RUNNER_IMAGE/),
    });
    const ready = new OrchestratorConfig(env({ ANTHROPIC_API_KEY: 'k', AGENT_RUNNER_IMAGE: 'img' }))
      .agentRuntime;
    expect(ready).toMatchObject({ model: 'claude-opus-5-5', maxTurns: 40, timeoutMs: 15 * 60_000 });
  });

  it('requires a digest-pinned runner image in production', () => {
    expect(() =>
      env({ NODE_ENV: 'production', AGENT_RUNNER_IMAGE: 'evolvesales/agent-runner:latest' }),
    ).toThrow(/pinned by digest/);
    expect(() =>
      env({
        NODE_ENV: 'production',
        AGENT_RUNNER_IMAGE: `evolvesales/agent-runner@sha256:${'a'.repeat(64)}`,
      }),
    ).not.toThrow();
  });
});
