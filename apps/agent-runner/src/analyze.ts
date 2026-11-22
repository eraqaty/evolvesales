import {
  type HookCallback,
  type Options,
  query,
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { implementationPlanJsonSchema, type RunnerInput } from '@evolvesales/shared';
import { agentLog, log } from './emit.js';
import { ANALYZE_DISALLOWED_TOOLS, ANALYZE_TOOLS, checkToolCall } from './guard.js';
import { ANALYZE_SYSTEM_PROMPT, analyzeUserPrompt } from './prompts.js';
import { REPO_DIR } from './workspace.js';

export interface AnalysisResult {
  ok: boolean;
  plan: unknown;
  error: string | null;
  numTurns: number;
  costUsd: number;
  usage: { inputTokens: number; outputTokens: number };
}

/** Every tool call passes this hook, whatever the permission rules would have decided. */
const guardHook: HookCallback = (input) => {
  if (input.hook_event_name !== 'PreToolUse') return Promise.resolve({});
  const reason = checkToolCall(input.tool_name, input.tool_input, REPO_DIR);
  if (reason === null) return Promise.resolve({});
  log(`denied ${input.tool_name}: ${reason}`, 'warn');
  return Promise.resolve({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
};

export function analysisOptions(input: RunnerInput, apiKey: string): Options {
  return {
    cwd: REPO_DIR,
    model: input.model,
    systemPrompt: ANALYZE_SYSTEM_PROMPT,
    tools: [...ANALYZE_TOOLS],
    allowedTools: [...ANALYZE_TOOLS],
    disallowedTools: [...ANALYZE_DISALLOWED_TOOLS],
    // Anything not pre-allowed is denied without asking; the hook guards paths on top.
    permissionMode: 'dontAsk',
    hooks: { PreToolUse: [{ hooks: [guardHook] }] },
    // Isolation: ignore settings, CLAUDE.md, hooks and MCP servers found in the repository.
    settingSources: [],
    mcpServers: {},
    strictMcpConfig: true,
    maxTurns: input.limits.maxTurns,
    maxBudgetUsd: input.limits.maxBudgetUsd,
    outputFormat: { type: 'json_schema', schema: implementationPlanJsonSchema() },
    // The subprocess gets exactly this environment (it replaces process.env).
    env: {
      PATH: process.env.PATH,
      HOME: '/home/agent',
      TMPDIR: '/tmp',
      ANTHROPIC_API_KEY: apiKey,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      HTTP_PROXY: process.env.HTTP_PROXY,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'evolvesales-agent-runner/0.1.0',
    },
    stderr: (data) => {
      const line = data.trim();
      if (line) log(`agent stderr: ${line.slice(0, 1000)}`, 'warn');
    },
  };
}

export async function runAnalysis(input: RunnerInput, apiKey: string): Promise<AnalysisResult> {
  let final: SDKResultMessage | null = null;
  const conversation = query({
    prompt: analyzeUserPrompt(input),
    options: analysisOptions(input, apiKey),
  });
  for await (const message of conversation) {
    describe(message);
    if (message.type === 'result') final = message;
  }
  if (!final) {
    return {
      ok: false,
      plan: null,
      error: 'The agent ended without a result',
      numTurns: 0,
      costUsd: 0,
      usage: zero(),
    };
  }

  const usage = Object.values(final.modelUsage).reduce(
    (sum, u) => ({
      inputTokens:
        sum.inputTokens + u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens,
      outputTokens: sum.outputTokens + u.outputTokens,
    }),
    zero(),
  );
  const base = { numTurns: final.num_turns, costUsd: final.total_cost_usd, usage };
  if (final.subtype !== 'success') {
    const why: Record<typeof final.subtype, string> = {
      error_max_turns: `The agent reached its turn limit (${input.limits.maxTurns}) without finishing`,
      error_max_budget_usd: `The agent reached its budget of ${input.limits.maxBudgetUsd} USD without finishing`,
      error_max_structured_output_retries:
        'The agent could not produce a plan in the required format',
      error_during_execution: `The agent failed: ${final.errors.join('; ').slice(0, 1000) || 'unknown error'}`,
    };
    return { ...base, ok: false, plan: null, error: why[final.subtype] };
  }
  const plan = final.structured_output ?? tryParse(final.result);
  if (plan === undefined) {
    return { ...base, ok: false, plan: null, error: 'The agent finished without returning a plan' };
  }
  return { ...base, ok: true, plan, error: null };
}

/** Streams a short, human-readable trace of the agent's steps to the job log. */
function describe(message: SDKMessage): void {
  if (message.type !== 'assistant') return;
  // The message follows the Messages API shape; read it defensively.
  const content: unknown = (message.message as { content?: unknown }).content;
  if (!Array.isArray(content)) return;
  for (const raw of content as unknown[]) {
    const block = asRecord(raw);
    if (!block) continue;
    if (block.type === 'tool_use') {
      const input = asRecord(block.input);
      const target = input?.file_path ?? input?.pattern ?? input?.path;
      const name = typeof block.name === 'string' ? block.name : 'tool';
      agentLog(`${name} ${typeof target === 'string' ? target : ''}`.trim());
    } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      agentLog(block.text.trim().slice(0, 500));
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function zero() {
  return { inputTokens: 0, outputTokens: 0 };
}
