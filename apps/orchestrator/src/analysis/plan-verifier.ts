import type {
  AffectedComponent,
  ImplementationPlan,
  PlanVerification,
  StoredImplementationPlan,
} from '@evolvesales/shared';

/** Read access to the repository at the baseline commit. */
export interface RepoSnapshot {
  readonly sha: string;
  hasFile(path: string): boolean;
  /** File text, or null when it can't be read (missing, binary, too large). */
  readFile(path: string): Promise<string | null>;
}

export interface VerifiedPlan {
  plan: StoredImplementationPlan;
  verifiedCount: number;
  assumptionCount: number;
}

/** Lines of slack around the cited range, since models are often off by a few lines. */
const LINE_SLACK = 10;
const MAX_ASSUMPTIONS = 40;

/**
 * PlanVerifier (§7 step 7). The agent's `verified` flags are claims, not facts: a component is
 * verified only when its cited excerpt really appears in that file at about those lines at the
 * baseline commit. Anything else is downgraded, explained, and listed as an assumption so the
 * approver sees what the plan rests on.
 */
export async function verifyPlan(
  plan: ImplementationPlan,
  repo: RepoSnapshot,
  now: Date = new Date(),
): Promise<VerifiedPlan> {
  const downgraded: PlanVerification['downgraded'] = [];
  const components: AffectedComponent[] = [];

  for (const component of plan.affectedComponents) {
    const problem = await checkComponent(component, repo);
    if (problem === null) {
      components.push({ ...component, verified: true, verificationNote: undefined });
      continue;
    }
    components.push({ ...component, verified: false, verificationNote: problem });
    // Only a claim that was made and failed is a downgrade; unverified-by-design entries
    // (e.g. new files with no evidence) are simply recorded as unverified.
    if (component.verified || component.evidence) {
      downgraded.push({ path: component.path, reason: problem });
    }
  }

  const assumptions = [
    ...plan.assumptions,
    ...downgraded.map((d) => `Unverified finding for ${d.path}: ${d.reason}`.slice(0, 500)),
  ].slice(0, MAX_ASSUMPTIONS);

  const verifiedCount = components.filter((c) => c.verified).length;
  return {
    plan: {
      ...plan,
      affectedComponents: components,
      assumptions,
      verification: {
        baselineSha: repo.sha,
        checkedAt: now.toISOString(),
        verifiedCount,
        downgraded,
      },
    },
    verifiedCount,
    assumptionCount: assumptions.length,
  };
}

async function checkComponent(c: AffectedComponent, repo: RepoSnapshot): Promise<string | null> {
  const exists = repo.hasFile(c.path);
  if (c.change !== 'add' && !exists) {
    return `${c.path} does not exist at the baseline commit`;
  }
  if (c.change === 'add' && exists) {
    return `${c.path} already exists, but the plan says it will be added`;
  }
  if (!c.evidence) {
    return c.change === 'add' ? 'New file: there is nothing to cite yet' : 'No evidence was cited';
  }

  const ev = c.evidence;
  if (!repo.hasFile(ev.path)) return `Cited file ${ev.path} does not exist at the baseline commit`;
  const text = await repo.readFile(ev.path);
  if (text === null) return `Cited file ${ev.path} could not be read (binary or too large)`;

  const lines = text.split(/\r?\n/);
  if (ev.startLine > lines.length) {
    return `Cited lines ${ev.startLine}-${ev.endLine} are past the end of ${ev.path} (${lines.length} lines)`;
  }
  const from = Math.max(0, ev.startLine - 1 - LINE_SLACK);
  const to = Math.min(lines.length, ev.endLine + LINE_SLACK);
  const window = normalize(lines.slice(from, to).join('\n'));
  const excerpt = normalize(ev.excerpt);
  if (excerpt.length === 0) return 'The cited excerpt is empty';
  if (!window.includes(excerpt)) {
    return `The cited excerpt was not found in ${ev.path} near lines ${ev.startLine}-${ev.endLine}`;
  }
  return null;
}

/** Ignores indentation, trailing spaces and blank lines, which models often reflow. */
function normalize(s: string): string {
  return s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n');
}
