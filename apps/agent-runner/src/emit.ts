import { redactSecrets, type RunnerEvent } from '@evolvesales/shared';

/** Writes one protocol event as a single stdout line (see runner-protocol.ts). */
export function emit(event: RunnerEvent): void {
  const safe: RunnerEvent =
    event.type === 'log'
      ? { ...event, message: redactSecrets(event.message).slice(0, 4000) }
      : event.ok
        ? event
        : { ...event, error: redactSecrets(event.error).slice(0, 4000) };
  process.stdout.write(`${JSON.stringify(safe)}\n`);
}

export function log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  emit({ type: 'log', level, source: 'runner', message });
}

export function agentLog(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  emit({ type: 'log', level, source: 'agent', message });
}
