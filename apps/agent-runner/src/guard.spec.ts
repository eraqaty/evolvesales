import { describe, expect, it } from 'vitest';
import { implementationPlanJsonSchema, type RunnerInput } from '@evolvesales/shared';
import { analysisOptions } from './analyze.js';
import { ANALYZE_DISALLOWED_TOOLS, checkToolCall } from './guard.js';

const ROOT = '/workspace/repo';
const identity = (p: string) => p;

describe('tool guard', () => {
  it('allows read-only tools inside the repository', () => {
    expect(
      checkToolCall('Read', { file_path: '/workspace/repo/README.md' }, ROOT, identity),
    ).toBeNull();
    expect(checkToolCall('Read', { file_path: 'apps/api/src/main.ts' }, ROOT, identity)).toBeNull();
    expect(checkToolCall('Grep', { pattern: 'invoice', path: 'apps' }, ROOT, identity)).toBeNull();
    expect(checkToolCall('Glob', { pattern: '**/*.ts' }, ROOT, identity)).toBeNull();
  });

  it('denies every other tool', () => {
    for (const tool of ['Bash', 'Write', 'Edit', 'WebFetch', 'Task', 'mcp__x__y']) {
      expect(checkToolCall(tool, {}, ROOT, identity)).toMatch(/not available/);
    }
  });

  it('denies paths outside the repository', () => {
    for (const p of [
      '/etc/passwd',
      '/proc/self/environ',
      '../../home/agent/.git-token',
      '/workspace',
    ]) {
      expect([p, checkToolCall('Read', { file_path: p }, ROOT, identity)]).toEqual([
        p,
        expect.stringMatching(/outside/),
      ]);
    }
    expect(checkToolCall('Grep', { pattern: 'x', path: '/home/agent' }, ROOT, identity)).toMatch(
      /outside/,
    );
    expect(checkToolCall('Glob', { pattern: '../**/*' }, ROOT, identity)).toMatch(/may not leave/);
    expect(checkToolCall('Glob', { pattern: '/etc/*' }, ROOT, identity)).toMatch(/may not leave/);
    expect(checkToolCall('Grep', { pattern: 'x', glob: '../*' }, ROOT, identity)).toMatch(
      /may not leave/,
    );
  });

  it('follows symlinks before deciding', () => {
    const realpath = (p: string) => (p.endsWith('link') ? '/etc/shadow' : p);
    expect(checkToolCall('Read', { file_path: 'evil-link' }, ROOT, realpath)).toMatch(/outside/);
  });

  it('rejects malformed input', () => {
    expect(checkToolCall('Read', null, ROOT, identity)).toMatch(/Malformed/);
    expect(checkToolCall('Read', { file_path: 42 }, ROOT, identity)).toMatch(/must be a string/);
  });
});

describe('agent options', () => {
  const input: RunnerInput = {
    protocol: 1,
    mode: 'analyze',
    jobId: '0193a3b2-0000-7000-8000-000000000001',
    repository: { fullName: 'o/r', cloneUrl: 'https://github.com/o/r.git' },
    baselineSha: 'a'.repeat(40),
    changeRequest: {
      key: 'CR-0001',
      title: 't',
      originalRequest: 'r',
      structured: {},
      screen: 's',
      screenContext: null,
    },
    limits: { maxTurns: 40, maxBudgetUsd: 5 },
    model: 'claude-opus-5-5',
  };

  it('runs isolated, read-only and capped', () => {
    const o = analysisOptions(input, 'sk-ant-test');
    expect(o.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(o.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
    expect(o.disallowedTools).toEqual([...ANALYZE_DISALLOWED_TOOLS]);
    expect(o.permissionMode).toBe('dontAsk');
    expect(o.settingSources).toEqual([]);
    expect(o.mcpServers).toEqual({});
    expect(o.maxTurns).toBe(40);
    expect(o.maxBudgetUsd).toBe(5);
    expect(o.cwd).toBe('/workspace/repo');
    expect(o.outputFormat).toEqual({ type: 'json_schema', schema: implementationPlanJsonSchema() });
    expect(o.hooks?.PreToolUse).toHaveLength(1);
    // Only the variables it needs; nothing inherited wholesale.
    expect(Object.keys(o.env ?? {}).sort()).toEqual(
      [
        'ANTHROPIC_API_KEY',
        'CLAUDE_AGENT_SDK_CLIENT_APP',
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
        'HOME',
        'HTTPS_PROXY',
        'HTTP_PROXY',
        'PATH',
        'TMPDIR',
      ].sort(),
    );
  });
});
