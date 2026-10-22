import type { GitHubPort } from "../ports/GitHubPort.js";

/**
 * Production GitHubPort implementation backed by octokit.
 * Not implemented in this ticket (#34): production adapters live in later
 * tickets; the decision layer talks to the port, never to this file.
 */
export class OctokitGitHub implements GitHubPort {
  constructor(_config: { appId: string; clientId: string; privateKey: string; apiBaseUrl: string }) {
    void _config;
  }

  private notImplemented(method: string): never {
    throw new Error(`OctokitGitHub.${method} not implemented (ticket #34 only defines ports)`);
  }

  listIssues(): Promise<never> {
    return this.notImplemented("listIssues");
  }
  listSubIssues(): Promise<never> {
    return this.notImplemented("listSubIssues");
  }
  listBlockers(): Promise<never> {
    return this.notImplemented("listBlockers");
  }
  getIssue(): Promise<never> {
    return this.notImplemented("getIssue");
  }
  listComments(): Promise<never> {
    return this.notImplemented("listComments");
  }
  findPullRequestByBranch(): Promise<never> {
    return this.notImplemented("findPullRequestByBranch");
  }
  editLabels(): Promise<never> {
    return this.notImplemented("editLabels");
  }
  addComment(): Promise<never> {
    return this.notImplemented("addComment");
  }
  closeIssue(): Promise<never> {
    return this.notImplemented("closeIssue");
  }
  createPullRequest(): Promise<never> {
    return this.notImplemented("createPullRequest");
  }
  mintInstallationToken(): Promise<never> {
    return this.notImplemented("mintInstallationToken");
  }
}
