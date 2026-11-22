import { Injectable } from '@nestjs/common';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { OrchestratorConfig, type GitHubAppConfig } from '../config.js';

export class GitHubNotConfiguredError extends Error {
  constructor() {
    super(
      'GitHub App not configured: set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH for the Orchestrator (see docs/GITHUB_APP_SETUP.md).',
    );
    this.name = 'GitHubNotConfiguredError';
  }
}

export interface InstallationRepository {
  githubId: number;
  fullName: string;
  installationId: number;
  defaultBranch: string;
  isPrivate: boolean;
}

export interface RepoRef {
  fullName: string;
  installationId: number;
}

export interface ScopedToken {
  token: string;
  expiresAt: string;
}

/** Largest file the PlanVerifier will download to check an excerpt. */
const MAX_VERIFY_FILE_BYTES = 1_000_000;

/**
 * GitHub App access (§11). The App's private key stays in this process; jobs get short-lived
 * installation tokens narrowed to one repository and the permissions the job needs.
 */
@Injectable()
export class GitHubAppService {
  private readonly app: GitHubAppConfig | null;

  constructor(config: OrchestratorConfig) {
    this.app = config.github;
  }

  get configured(): boolean {
    return this.app !== null;
  }

  get cloneBaseUrl(): string {
    return this.requireApp().cloneBaseUrl;
  }

  /** Every repository every installation of the App can see. */
  async listInstallationRepositories(): Promise<InstallationRepository[]> {
    const app = this.appClient();
    const installations = await app.paginate(app.rest.apps.listInstallations, { per_page: 100 });
    const repos: InstallationRepository[] = [];
    for (const installation of installations) {
      const { data } = await app.rest.apps.createInstallationAccessToken({
        installation_id: installation.id,
        permissions: { metadata: 'read' },
      });
      const client = this.tokenClient(data.token);
      const list = await client.paginate(client.rest.apps.listReposAccessibleToInstallation, {
        per_page: 100,
      });
      for (const r of list) {
        repos.push({
          githubId: r.id,
          fullName: r.full_name,
          installationId: installation.id,
          defaultBranch: r.default_branch ?? 'main',
          isPrivate: r.private,
        });
      }
    }
    return repos;
  }

  /** A read-only token for exactly one repository (`contents:read`, about 1 hour). */
  async mintReadToken(repo: RepoRef): Promise<ScopedToken> {
    const app = this.appClient();
    const { data } = await app.rest.apps.createInstallationAccessToken({
      installation_id: repo.installationId,
      repositories: [repoName(repo.fullName)],
      permissions: { contents: 'read', metadata: 'read' },
    });
    return { token: data.token, expiresAt: data.expires_at };
  }

  /** The commit SHA a branch points at now. */
  async resolveBranchSha(token: string, fullName: string, branch: string): Promise<string> {
    const [owner, repo] = splitName(fullName);
    const { data } = await this.tokenClient(token).rest.repos.getBranch({ owner, repo, branch });
    return data.commit.sha;
  }

  /** All file paths at a commit. Throws when GitHub truncates the tree (too large to verify). */
  async listFiles(token: string, fullName: string, sha: string): Promise<Set<string>> {
    const [owner, repo] = splitName(fullName);
    const { data } = await this.tokenClient(token).rest.git.getTree({
      owner,
      repo,
      tree_sha: sha,
      recursive: 'true',
    });
    if (data.truncated) throw new Error(`The tree of ${fullName}@${sha} is too large to verify`);
    return new Set(data.tree.filter((e) => e.type === 'blob' && e.path).map((e) => e.path ?? ''));
  }

  /** A file's text at a commit, or null if it is missing, binary or too large. */
  async readFile(
    token: string,
    fullName: string,
    path: string,
    sha: string,
  ): Promise<string | null> {
    const [owner, repo] = splitName(fullName);
    try {
      const { data } = await this.tokenClient(token).rest.repos.getContent({
        owner,
        repo,
        path,
        ref: sha,
      });
      if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) return null;
      if (data.size > MAX_VERIFY_FILE_BYTES) return null;
      const bytes = Buffer.from(data.content, 'base64');
      if (bytes.includes(0)) return null;
      return bytes.toString('utf8');
    } catch (err) {
      if (statusOf(err) === 404) return null;
      throw err;
    }
  }

  private requireApp(): GitHubAppConfig {
    if (!this.app) throw new GitHubNotConfiguredError();
    return this.app;
  }

  private appClient(): Octokit {
    const app = this.requireApp();
    return new Octokit({
      baseUrl: app.apiBaseUrl,
      authStrategy: createAppAuth,
      auth: { appId: app.appId, privateKey: app.privateKey },
      userAgent: 'evolvesales-orchestrator',
    });
  }

  private tokenClient(token: string): Octokit {
    return new Octokit({
      baseUrl: this.requireApp().apiBaseUrl,
      auth: token,
      userAgent: 'evolvesales-orchestrator',
    });
  }
}

export function splitName(fullName: string): [string, string] {
  const [owner, repo, ...rest] = fullName.split('/');
  if (!owner || !repo || rest.length > 0) throw new Error(`Invalid repository name: ${fullName}`);
  return [owner, repo];
}

function repoName(fullName: string): string {
  return splitName(fullName)[1];
}

function statusOf(err: unknown): number | undefined {
  return typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof err.status === 'number'
    ? err.status
    : undefined;
}
