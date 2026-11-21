import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';

type LanguageModelV4CallOptions = Parameters<MockLanguageModelV4['doStream']>[0];
type LanguageModelV4StreamPart =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P>
    ? P
    : never;

/** One model response: optional text and/or tool calls (a tool call ends the step). */
export interface ScriptedStep {
  text?: string;
  toolCalls?: Array<{ name: string; input: unknown }>;
}

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

/**
 * A deterministic stand-in for the LLM: replays `steps` in order, one per model call, so tests
 * drive the real assistant code (tool execution, persistence, streaming) without a network call.
 * `calls` records the prompts the assistant actually sent. With `queue: true` each call takes
 * (removes) the first step, so a test file can refill `steps` per test.
 */
export function scriptedModel(
  steps: ScriptedStep[],
  mode: { queue?: boolean } = {},
): {
  model: MockLanguageModelV4;
  calls: LanguageModelV4CallOptions[];
} {
  let index = 0;
  const calls: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doStream: (options) => {
      calls.push(options);
      const next = mode.queue ? steps.shift() : steps[index++];
      const step = next ?? { text: '(no more scripted steps)' };
      const parts: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: [] }];
      if (step.text) {
        parts.push(
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: step.text },
          { type: 'text-end', id: 't' },
        );
      }
      for (const [i, call] of (step.toolCalls ?? []).entries()) {
        parts.push({
          type: 'tool-call',
          toolCallId: `call-${index}-${i}`,
          toolName: call.name,
          input: JSON.stringify(call.input),
        });
      }
      parts.push({
        type: 'finish',
        usage,
        finishReason: { unified: step.toolCalls?.length ? 'tool-calls' : 'stop', raw: undefined },
      });
      return Promise.resolve({ stream: convertArrayToReadableStream(parts) });
    },
  });
  return { model, calls };
}

/** A complete, valid proposal for tests. */
export const sampleProposal = {
  title: 'Export invoice list to Excel',
  category: 'feature',
  description: 'Add an Export to Excel button on the invoice list that exports the filtered rows.',
  screen: 'sales.invoices.list',
  userStory: 'As a sales user I want to export the invoices I see so that I can share them.',
  acceptanceCriteria: ['The export contains exactly the filtered invoices'],
  outOfScope: ['PDF export'],
  priority: 'MEDIUM',
  assumptions: ['XLSX format'],
} as const;
