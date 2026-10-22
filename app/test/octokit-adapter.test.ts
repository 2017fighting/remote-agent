import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { OctokitGitHub } from "../src/adapters/octokit.js";
import { json, startStubServer, type StubRequest, type StubServer } from "./http-stub.js";

/**
 * Production GitHub adapter against a local HTTP stub (spec #43 acceptance
 * criteria): no network, and every assertion is about the wire — method, path,
 * body, and which credential signed the request. `GITHUB_API_BASE_URL` is the
 * stub's URL, so a call that ignored it would simply fail.
 */

const APP_ID = "5390512";
const REPO = "2017fighting/pi-web";
const OWNER = "2017fighting";
const NAME = "pi-web";

/** Throwaway signing key: the JWT flow is exercised for real, with no GitHub app. */
const { privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const INSTALLATION_ID = 4242;
const INSTALLATION_TOKEN = "ghs_stub_installation_token";

let stub: StubServer;

beforeEach(() => {
  stub = undefined as unknown as StubServer;
});

afterEach(async () => {
  await stub?.close();
});

function issuePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1001,
    number: 1,
    state: "open",
    title: "Issue 1",
    body: "Body of #1",
    labels: [{ name: "ready-for-agent" }, { name: "agent:implement" }],
    ...overrides,
  };
}

function pullPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 2001,
    number: 77,
    state: "open",
    draft: false,
    title: "Spec closeout",
    body: "Closes #33",
    head: { ref: "agent/spec-33" },
    base: { ref: "main" },
    ...overrides,
  };
}

/** Default stub: the endpoints the adapter uses, with the installation flow wired. */
function defaultHandler(request: StubRequest) {
  const { method, path } = request;

  if (method === "GET" && path === "/app/installations") {
    return json(200, [{ id: INSTALLATION_ID }]);
  }
  if (method === "GET" && path === `/repos/${OWNER}/${NAME}/installation`) {
    return json(200, { id: INSTALLATION_ID });
  }
  if (method === "POST" && path === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
    return json(201, {
      token: INSTALLATION_TOKEN,
      expires_at: "2026-01-01T00:00:00Z",
      permissions: { contents: "write" },
      repository_selection: "selected",
    });
  }
  if (method === "GET" && path === "/installation/repositories") {
    return json(200, {
      total_count: 1,
      repositories: [{ id: 1, name: NAME, full_name: `${OWNER}/${NAME}` }],
    });
  }
  if (method === "GET" && path === `/repos/${OWNER}/${NAME}/issues`) {
    return json(200, [
      issuePayload({ number: 1 }),
      // A pull request is an "issue" to the REST endpoint and must be dropped.
      issuePayload({ number: 77, pull_request: { url: "x" } }),
    ]);
  }
  if (method === "GET" && path === `/repos/${OWNER}/${NAME}/issues/1`) {
    return json(200, issuePayload());
  }
  if (method === "GET" && path === `/repos/${OWNER}/${NAME}/issues/1/sub_issues`) {
    return json(200, [
      issuePayload({ number: 2, title: "Ticket 2" }),
      issuePayload({ number: 3, title: "Ticket 3" }),
    ]);
  }
  if (method === "GET" && path === `/repos/${OWNER}/${NAME}/issues/1/dependencies/blocked_by`) {
    return json(200, [issuePayload({ number: 9, state: "open" })]);
  }
  if (method === "GET" && path === `/repos/${OWNER}/${NAME}/issues/1/comments`) {
    return json(200, [
      { id: 20, body: "later", created_at: "2026-01-02T00:00:00Z", user: { login: "b" } },
      { id: 10, body: "earlier", created_at: "2026-01-01T00:00:00Z", user: { login: "a" } },
    ]);
  }
  if (method === "GET" && path === `/repos/${OWNER}/${NAME}/pulls`) {
    return json(200, [pullPayload()]);
  }
  // Writes the tests do not override succeed with an empty body.
  if (method === "POST" && path === `/repos/${OWNER}/${NAME}/issues/1/labels`) return json(200, []);
  if (method === "DELETE" && path.startsWith(`/repos/${OWNER}/${NAME}/issues/1/labels/`)) return json(200, []);
  if (method === "POST" && path === `/repos/${OWNER}/${NAME}/issues/1/comments`) return json(201, { id: 30 });
  if (method === "PATCH" && path === `/repos/${OWNER}/${NAME}/issues/1`) return json(200, issuePayload({ state: "closed" }));
  return undefined;
}

async function adapter(): Promise<OctokitGitHub> {
  stub = await startStubServer(defaultHandler);
  return new OctokitGitHub({ appId: APP_ID, privateKey: TEST_PRIVATE_KEY, apiBaseUrl: stub.url });
}

function jwtPayload(authorization: string | undefined): Record<string, unknown> {
  const token = (authorization ?? "").replace(/^bearer /i, "");
  const [, payload] = token.split(".");
  if (payload === undefined) throw new Error(`not a JWT: ${authorization ?? "<none>"}`);
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("OctokitGitHub: reads", () => {
  it("listIssues walks the installation, honours GITHUB_API_BASE_URL, and drops pull requests", async () => {
    const github = await adapter();

    const issues = await github.listIssues();

    expect(issues).toEqual([
      {
        ownerRepo: `${OWNER}/${NAME}`,
        number: 1,
        state: "open",
        title: "Issue 1",
        body: "Body of #1",
        labels: ["ready-for-agent", "agent:implement"],
      },
    ]);
    // Every request landed on the stub — that is the base-URL assertion. The
    // path also shows the App-JWT → installation-token hand-off: list the
    // installations, mint a token, then read with that token.
    expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /app/installations",
      "POST /app/installations/4242/access_tokens",
      "GET /installation/repositories",
      "GET /repos/2017fighting/pi-web/issues",
    ]);
    expect(stub.requests[3]?.query.get("state")).toBe("all");
    // JWT for App-level endpoints, installation token for data reads.
    expect(stub.requests[0]?.headers.authorization).toMatch(/^bearer eyJ/);
    expect(stub.requests[3]?.headers.authorization).toBe(`token ${INSTALLATION_TOKEN}`);
  });

  it("the JWT is signed with the app id and an RS256 key", async () => {
    const github = await adapter();
    await github.getIssue(REPO, 1);

    const authorization = stub.requests[0]?.headers.authorization;
    expect(jwtPayload(authorization).iss).toBe(APP_ID);
    const header = JSON.parse(
      Buffer.from((authorization ?? "").replace(/^bearer /i, "").split(".")[0] ?? "", "base64url").toString("utf8"),
    ) as { alg: string };
    expect(header.alg).toBe("RS256");
  });

  it("listSubIssues keeps GitHub's order and maps every field", async () => {
    const github = await adapter();

    const subIssues = await github.listSubIssues(REPO, 1);

    expect(subIssues.map((issue) => issue.number)).toEqual([2, 3]);
    expect(subIssues[0]?.ownerRepo).toBe(REPO);
    expect(stub.requests.at(-1)?.path).toBe(`/repos/${OWNER}/${NAME}/issues/1/sub_issues`);
  });

  it("listBlockers reads the blocked_by dependencies endpoint", async () => {
    const github = await adapter();

    const blockers = await github.listBlockers(REPO, 1);

    expect(blockers.map((issue) => issue.number)).toEqual([9]);
    expect(stub.requests.at(-1)?.path).toBe(`/repos/${OWNER}/${NAME}/issues/1/dependencies/blocked_by`);
  });

  it("getIssue returns null on 404 instead of throwing", async () => {
    const github = await adapter();

    expect(await github.getIssue(REPO, 404)).toBeNull();
  });

  it("listComments returns oldest first, with the author", async () => {
    const github = await adapter();

    const comments = await github.listComments(REPO, 1);

    expect(comments.map((comment) => [comment.id, comment.body, comment.author])).toEqual([
      [10, "earlier", "a"],
      [20, "later", "b"],
    ]);
  });

  it("findPullRequestByBranch asks by owner:branch and returns null when there is none", async () => {
    const github = await adapter();

    const found = await github.findPullRequestByBranch(REPO, "agent/spec-33");
    expect(found).toEqual({
      ownerRepo: REPO,
      number: 77,
      state: "open",
      draft: false,
      headBranch: "agent/spec-33",
      baseBranch: "main",
      title: "Spec closeout",
      body: "Closes #33",
    });
    expect(stub.requests.at(-1)?.query.get("head")).toBe(`${OWNER}:agent/spec-33`);
    expect(stub.requests.at(-1)?.query.get("state")).toBe("open");

    expect(await github.findPullRequestByBranch(REPO, "agent/spec-99")).toBeNull();
  });
});

describe("OctokitGitHub: writes", () => {
  it("editLabels adds with POST and removes one DELETE per label", async () => {
    const github = await adapter();

    await github.editLabels(REPO, 1, ["agent:in-progress"], ["ready-for-agent"]);

    const writes = stub.requests.filter((r) => r.method !== "GET" && !r.path.includes("access_tokens"));
    expect(writes.map((r) => `${r.method} ${r.path}`)).toEqual([
      `POST /repos/${OWNER}/${NAME}/issues/1/labels`,
      `DELETE /repos/${OWNER}/${NAME}/issues/1/labels/ready-for-agent`,
    ]);
    expect(writes[0]?.json()).toEqual({ labels: ["agent:in-progress"] });
  });

  it("editLabels tolerates removing a label that is already gone (404 = no-op)", async () => {
    stub = await startStubServer((request) => {
      if (request.method === "DELETE") return json(404, { message: "Label does not exist" });
      return defaultHandler(request);
    });
    const github = new OctokitGitHub({ appId: APP_ID, privateKey: TEST_PRIVATE_KEY, apiBaseUrl: stub.url });

    await expect(github.editLabels(REPO, 1, [], ["agent:blocked"])).resolves.toBeUndefined();
  });

  it("editLabels still throws on a non-404 failure", async () => {
    stub = await startStubServer((request) => {
      if (request.method === "DELETE") return json(422, { message: "Validation Failed" });
      return defaultHandler(request);
    });
    const github = new OctokitGitHub({ appId: APP_ID, privateKey: TEST_PRIVATE_KEY, apiBaseUrl: stub.url });

    await expect(github.editLabels(REPO, 1, [], ["agent:blocked"])).rejects.toThrow();
  });

  it("addComment posts the body to the issue comments endpoint", async () => {
    const github = await adapter();

    await github.addComment(REPO, 1, "<!-- remote-agent:done:agent-x -->\nsummary");

    const write = stub.requests.at(-1);
    expect(`${write?.method} ${write?.path}`).toBe(`POST /repos/${OWNER}/${NAME}/issues/1/comments`);
    expect(write?.json()).toEqual({ body: "<!-- remote-agent:done:agent-x -->\nsummary" });
  });

  it("closeIssue PATCHes the issue state to closed", async () => {
    const github = await adapter();

    await github.closeIssue(REPO, 1);

    const write = stub.requests.at(-1);
    expect(`${write?.method} ${write?.path}`).toBe(`PATCH /repos/${OWNER}/${NAME}/issues/1`);
    expect(write?.json()).toEqual({ state: "closed" });
  });

  it("createIssue sends title, body and labels and maps the created issue back", async () => {
    stub = await startStubServer((request) => {
      if (request.method === "POST" && request.path === `/repos/${OWNER}/${NAME}/issues`) {
        return json(201, issuePayload({ number: 42, title: "Follow-up", body: "b", labels: [{ name: "ready-for-human" }] }));
      }
      return defaultHandler(request);
    });
    const github = new OctokitGitHub({ appId: APP_ID, privateKey: TEST_PRIVATE_KEY, apiBaseUrl: stub.url });

    const created = await github.createIssue({
      ownerRepo: REPO,
      title: "Follow-up",
      body: "b",
      labels: ["ready-for-human"],
    });

    expect(created).toMatchObject({ number: 42, state: "open", labels: ["ready-for-human"] });
    expect(stub.requests.at(-1)?.json()).toEqual({ title: "Follow-up", body: "b", labels: ["ready-for-human"] });
  });

  it("addSubIssue links by numeric id, and is a no-op when the link already exists", async () => {
    const github = await adapter();

    // #2 is already listed as a sub-issue: no write. The token-mint POST is
    // the only POST the adapter may issue here.
    await github.addSubIssue(REPO, 1, 2);
    expect(stub.requests.some((r) => r.method === "POST" && r.path.endsWith("/sub_issues"))).toBe(false);

    // #5 is not: read the child's id, then link it.
    stub.requests.length = 0;
    stub = await startStubServer((request) => {
      if (request.method === "GET" && request.path === `/repos/${OWNER}/${NAME}/issues/5`) {
        return json(200, issuePayload({ number: 5, id: 5005 }));
      }
      if (request.method === "POST" && request.path === `/repos/${OWNER}/${NAME}/issues/1/sub_issues`) {
        return json(201, issuePayload({ number: 5 }));
      }
      return defaultHandler(request);
    });
    const second = new OctokitGitHub({ appId: APP_ID, privateKey: TEST_PRIVATE_KEY, apiBaseUrl: stub.url });
    await second.addSubIssue(REPO, 1, 5);

    const write = stub.requests.at(-1);
    expect(`${write?.method} ${write?.path}`).toBe(`POST /repos/${OWNER}/${NAME}/issues/1/sub_issues`);
    expect(write?.json()).toEqual({ sub_issue_id: 5005 });
  });

  it("createPullRequest returns the open PR for the branch instead of creating a second one", async () => {
    const github = await adapter();

    const existing = await github.createPullRequest({
      ownerRepo: REPO,
      title: "Spec closeout",
      body: "Closes #33",
      headBranch: "agent/spec-33",
      baseBranch: "main",
    });

    expect(existing.number).toBe(77);
    expect(stub.requests.some((r) => r.method === "POST" && r.path.endsWith("/pulls"))).toBe(false);
  });

  it("createPullRequest creates a ready PR when the branch has none", async () => {
    stub = await startStubServer((request) => {
      if (request.method === "POST" && request.path === `/repos/${OWNER}/${NAME}/pulls`) {
        return json(201, pullPayload({ head: { ref: "agent/spec-34" } }));
      }
      return defaultHandler(request);
    });
    const github = new OctokitGitHub({ appId: APP_ID, privateKey: TEST_PRIVATE_KEY, apiBaseUrl: stub.url });

    const created = await github.createPullRequest({
      ownerRepo: REPO,
      title: "Spec closeout",
      body: "Closes #34",
      headBranch: "agent/spec-34",
      baseBranch: "main",
    });

    expect(created).toMatchObject({ headBranch: "agent/spec-34", baseBranch: "main", draft: false });
    const write = stub.requests.at(-1);
    expect(`${write?.method} ${write?.path}`).toBe(`POST /repos/${OWNER}/${NAME}/pulls`);
    expect(write?.json()).toEqual({
      title: "Spec closeout",
      body: "Closes #34",
      head: "agent/spec-34",
      base: "main",
    });
  });
});

describe("OctokitGitHub: configuration", () => {
  it("fails at construction when the App credentials are missing, naming the env key", () => {
    expect(() => new OctokitGitHub({ appId: "", privateKey: TEST_PRIVATE_KEY, apiBaseUrl: "http://127.0.0.1:1" })).toThrow(
      /GITHUB_APP_ID/,
    );
    expect(() => new OctokitGitHub({ appId: APP_ID, privateKey: "", apiBaseUrl: "http://127.0.0.1:1" })).toThrow(
      /GITHUB_APP_PRIVATE_KEY/,
    );
  });

  it("accepts a base URL with a trailing slash (the stub's form) and an escaped private key", async () => {
    stub = await startStubServer(defaultHandler);
    const github = new OctokitGitHub({
      appId: APP_ID,
      privateKey: TEST_PRIVATE_KEY.replace(/\n/g, "\\n"),
      apiBaseUrl: `${stub.url}/`,
    });

    expect(await github.getIssue(REPO, 1)).toMatchObject({ number: 1 });
    expect(stub.requests.every((request) => request.path.startsWith("/"))).toBe(true);
  });
});

describe("OctokitGitHub: installation token mint", () => {
  it("requests contents: write scoped to the one target repo", async () => {
    const github = await adapter();

    const minted = await github.mintInstallationToken(REPO);

    expect(minted).toEqual({ token: INSTALLATION_TOKEN, expiresAt: "2026-01-01T00:00:00Z" });
    const mint = stub.requests.at(-1);
    expect(`${mint?.method} ${mint?.path}`).toBe(`POST /app/installations/${INSTALLATION_ID}/access_tokens`);
    expect(mint?.json()).toEqual({ repositories: [NAME], permissions: { contents: "write" } });
  });

  it("mints with the App JWT, and the token never appears in a URL", async () => {
    const github = await adapter();

    await github.mintInstallationToken(REPO);

    const mint = stub.requests.at(-1);
    // Signed by the App, not by an installation token: this is the JWT step.
    expect(mint?.headers.authorization).toMatch(/^bearer eyJ/);
    expect(jwtPayload(mint?.headers.authorization).iss).toBe(APP_ID);
    // ADR-0009: the credential travels in the response body, never the URL.
    for (const request of stub.requests) {
      expect(request.path).not.toContain(INSTALLATION_TOKEN);
      expect(request.query.toString()).not.toContain(INSTALLATION_TOKEN);
    }
  });
});
