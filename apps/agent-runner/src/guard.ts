import { realpathSync } from 'node:fs';
import path from 'node:path';

/** The only tools the analysis agent may use (§7). */
export const ANALYZE_TOOLS = ['Read', 'Grep', 'Glob'] as const;

/** Explicitly removed from the agent's context, in addition to the allowlist above. */
export const ANALYZE_DISALLOWED_TOOLS = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'Skill',
  'TodoWrite',
] as const;

const PATH_FIELDS = ['file_path', 'path', 'notebook_path'] as const;
const PATTERN_FIELDS = ['pattern', 'glob'] as const;

export type RealPath = (p: string) => string;

/**
 * Decides one tool call. Returns the reason to deny it, or null to allow it.
 * Every path the call names must resolve (symlinks included) inside `root`.
 */
export function checkToolCall(
  tool: string,
  input: unknown,
  root: string,
  realpath: RealPath = defaultRealpath,
): string | null {
  if (!(ANALYZE_TOOLS as readonly string[]).includes(tool)) {
    return `Tool ${tool} is not available to the analysis agent (read-only: Read, Grep, Glob)`;
  }
  if (typeof input !== 'object' || input === null) return 'Malformed tool input';
  const fields = input as Record<string, unknown>;

  for (const field of PATH_FIELDS) {
    const value = fields[field];
    if (value === undefined) continue;
    if (typeof value !== 'string') return `${field} must be a string`;
    if (!isInside(root, value, realpath)) return `${field} is outside the repository`;
  }
  if (tool === 'Glob' || tool === 'Grep') {
    for (const field of PATTERN_FIELDS) {
      const value = fields[field];
      if (value === undefined || (tool === 'Grep' && field === 'pattern')) continue;
      if (typeof value !== 'string') return `${field} must be a string`;
      if (value.startsWith('/') || value.startsWith('~') || value.split(/[\\/]/).includes('..')) {
        return `${field} may not leave the repository`;
      }
    }
  }
  return null;
}

function isInside(root: string, candidate: string, realpath: RealPath): boolean {
  const resolved = path.posix.resolve(root, candidate);
  if (!within(root, resolved)) return false;
  // Resolve symlinks for paths that exist; the runner also deletes symlinks after checkout.
  let real = resolved;
  try {
    real = realpath(resolved);
  } catch {
    return true; // does not exist: the tool will just report "not found"
  }
  return within(root, real);
}

function within(root: string, p: string): boolean {
  return p === root || p.startsWith(`${root}/`);
}

function defaultRealpath(p: string): string {
  return realpathSync(p);
}
