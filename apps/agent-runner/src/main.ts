import { runnerStdinSchema } from '@evolvesales/shared';
import { runAnalysis } from './analyze.js';
import { emit, log } from './emit.js';
import { prepareWorkspace } from './workspace.js';

const MAX_STDIN_BYTES = 1024 * 1024;

/** Lines read before giving up: the job line, plus Docker attach noise (see DockerLauncher). */
const MAX_STDIN_LINES = 4;

/**
 * Reads stdin line by line until a line parses as the job document, then stops reading.
 * Empty lines and lines that aren't a job document are skipped.
 */
async function readJob(): Promise<ReturnType<typeof runnerStdinSchema.safeParse>> {
  let text = '';
  let lines = 0;
  let last: ReturnType<typeof runnerStdinSchema.safeParse> = runnerStdinSchema.safeParse(null);
  try {
    for await (const chunk of process.stdin) {
      text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (text.length > MAX_STDIN_BYTES) throw new Error('job input is too large');
      let nl = text.indexOf('\n');
      while (nl >= 0) {
        const line = text.slice(0, nl).trim();
        text = text.slice(nl + 1);
        nl = text.indexOf('\n');
        if (!line) continue;
        lines += 1;
        last = runnerStdinSchema.safeParse(tryJson(line));
        if (last.success || lines >= MAX_STDIN_LINES) return last;
      }
    }
    return last;
  } finally {
    process.stdin.destroy();
  }
}

function tryJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Entry point of the single-use runner container. Reads `{input, secrets}` from stdin,
 * prepares a read-only checkout at the exact baseline SHA, runs the analysis agent and writes
 * one `result` event. Exit code 0 means a result was written (successful or not).
 */
async function main(): Promise<number> {
  let parsed: ReturnType<typeof runnerStdinSchema.safeParse>;
  try {
    parsed = await readJob();
  } catch (err) {
    emit({ type: 'result', ok: false, error: `unreadable job input: ${message(err)}` });
    return 2;
  }
  if (!parsed.success) {
    emit({ type: 'result', ok: false, error: 'job input does not match the runner protocol' });
    return 2;
  }
  const { input, secrets } = parsed.data;
  log(`runner started: ${input.mode} ${input.changeRequest.key} (${input.repository.fullName})`);

  let headSha: string;
  try {
    headSha = await prepareWorkspace(
      input.repository.cloneUrl,
      input.baselineSha,
      secrets.githubToken,
    );
  } catch (err) {
    emit({
      type: 'result',
      ok: false,
      error: `could not check out ${input.baselineSha}: ${message(err)}`,
    });
    return 0;
  }

  try {
    const r = await runAnalysis(input, secrets.anthropicApiKey);
    if (r.ok) {
      emit({
        type: 'result',
        ok: true,
        plan: r.plan,
        model: input.model,
        headSha,
        numTurns: r.numTurns,
        usage: r.usage,
        costUsd: r.costUsd,
      });
    } else {
      emit({
        type: 'result',
        ok: false,
        error: r.error ?? 'analysis failed',
        usage: r.usage,
        costUsd: r.costUsd,
      });
    }
  } catch (err) {
    emit({ type: 'result', ok: false, error: `analysis failed: ${message(err)}` });
  }
  return 0;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

process.exitCode = await main();
