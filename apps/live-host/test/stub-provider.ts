/**
 * GitHub-shaped stub for the OAuth + release flow — lets the whole login →
 * repo-gate → session → release path run locally without real credentials
 * (tests, offline demos). Point the live host at it:
 *
 *   GITHUB_CLIENT_ID=stub GITHUB_CLIENT_SECRET=stub \
 *   GITHUB_BASE_URL=http://localhost:8399 GITHUB_API_URL=http://localhost:8399 \
 *   LIVE_PUSH_URL_OVERRIDE=<file:///path/to/bare.git> npm start
 *
 * Control endpoint (tests): POST /_control {"permission":"read"|"write"}
 * simulates a user with/without repo access; {"addIssue":…} seeds tracker rows
 * (incl. PR-shaped ones) and {"issuesForbidden":true} simulates an app missing
 * the Issues permission. GET /_control returns recorded pull-request payloads.
 */
import { createServer, type ServerResponse } from "node:http";

const PORT = Number(process.env.STUB_PORT ?? 8399);

let permission = "write";
let lastManifest: { redirect_url?: string; callback_urls?: string[] } | undefined;
let installationRepos: string[] = ["acme/bpm-processes"];
const pulls: unknown[] = [];
// in-memory issue tracker (todo feature): labels + issues per repo. Issues are
// GitHub-shaped; only PULL-REQUEST rows carry a pull_request key (like the real
// list endpoint). `issuesForbidden` simulates an app without the Issues permission.
interface StubIssue {
  number: number;
  html_url: string;
  title: string;
  state: string;
  body: string;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  created_at: string;
  pull_request?: { url: string };
}
const repoLabels = new Map<string, Set<string>>();
const repoIssues = new Map<string, StubIssue[]>();
let issuesForbidden = false;
const addIssue = (repo: string, i: { title: string; body?: string; labels?: string[]; pull_request?: boolean }) => {
  const list = repoIssues.get(repo) ?? [];
  repoIssues.set(repo, list);
  const number = list.length + 1;
  const issue: StubIssue = {
    number,
    html_url: `http://localhost:${PORT}/${repo}/issues/${number}`,
    title: i.title,
    state: "open",
    body: i.body ?? "",
    labels: (i.labels ?? []).map((name) => ({ name })),
    assignees: [],
    created_at: new Date().toISOString(),
    ...(i.pull_request ? { pull_request: { url: `http://localhost:${PORT}/${repo}/pulls/${number}` } } : {}),
  };
  list.push(issue);
  return issue;
};
// installation directory for multi-tenant / cell tests: id -> repos
// (defaults to the single legacy installation #1 = acme's repos)
const installations = new Map<number, { repos: string[]; suspended: boolean; account: string }>([
  [1, { repos: [], suspended: false, account: "acme" }], // repos come from installationRepos for #1 (back-compat)
]);

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const body = await new Promise<string>((r) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => r(data));
  });

  // GitHub App manifest flow: "create app" auto-approves, conversion returns credentials
  // (personal AND org-scoped creation URL, like the real thing)
  if (url.pathname === "/settings/apps/new" || /^\/organizations\/[^/]+\/settings\/apps\/new$/.test(url.pathname)) {
    lastManifest = JSON.parse(new URLSearchParams(body).get("manifest") ?? "{}");
    const redirect = new URL(lastManifest?.redirect_url ?? "http://localhost:8301/setup/created");
    redirect.searchParams.set("code", "stub-manifest-code");
    redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
    res.writeHead(302, { location: redirect.toString() });
    return res.end();
  }
  if (/^\/app-manifests\/[^/]+\/conversions$/.test(url.pathname) && req.method === "POST") {
    return json(res, 201, {
      id: 4711,
      slug: "bpm-live-stub",
      client_id: "stub-app-client",
      client_secret: "stub-app-secret",
      pem: "-----BEGIN FAKE KEY-----\nstub\n-----END FAKE KEY-----",
      webhook_secret: "stub-webhook",
    });
  }
  if (/^\/apps\/[^/]+\/installations\/new$/.test(url.pathname)) {
    // simulate GitHub's install picker + request_oauth_on_install: auto-install,
    // then bounce into the user authorization against the app's callback URL
    const callback = new URL(lastManifest?.callback_urls?.[0] ?? "http://localhost:8301/auth/github/callback");
    callback.searchParams.set("code", "stub-code");
    callback.searchParams.set("installation_id", "1");
    callback.searchParams.set("setup_action", "install");
    res.writeHead(302, { location: callback.toString() });
    return res.end();
  }

  // GitHub App server-side API: installations → repositories → tokens
  // (the JWT signature is NOT verified — this is a stub)
  if (url.pathname === "/app") return json(res, 200, { slug: "bpm-live-stub", id: 4711 });
  const reposOf = (id: number): string[] => (id === 1 ? installationRepos : (installations.get(id)?.repos ?? []));
  const instJson = (id: number) => {
    const inst = installations.get(id)!;
    return { id, suspended_at: inst.suspended ? new Date().toISOString() : null, account: { login: inst.account } };
  };
  if (url.pathname === "/app/installations") {
    return json(res, 200, [...installations.keys()].map(instJson));
  }
  const singleInst = url.pathname.match(/^\/app\/installations\/(\d+)$/);
  if (singleInst && req.method === "GET") {
    const id = Number(singleInst[1]);
    if (!installations.has(id)) return json(res, 404, { message: "Not Found" });
    return json(res, 200, instJson(id));
  }
  if (url.pathname === "/installation/repositories") {
    // which installation? the token identifies it: "stub-installation-token-<id>"
    const auth = req.headers.authorization ?? "";
    const m = auth.match(/stub-installation-token-(\d+)/);
    const id = m ? Number(m[1]) : 1;
    return json(res, 200, {
      repositories: reposOf(id).map((full_name) => ({
        full_name,
        default_branch: "main",
        private: true,
        owner: { avatar_url: null },
      })),
    });
  }
  const tokenReq = url.pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
  if (tokenReq && req.method === "POST") {
    return json(res, 201, {
      token: `stub-installation-token-${tokenReq[1]}`,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
  }
  // collaborator permission (ADR 0001 authz via installation token)
  const permReq = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/collaborators\/([^/]+)\/permission$/);
  if (permReq && req.method === "GET") {
    return json(res, 200, { permission, role_name: permission, user: { login: permReq[1] } });
  }

  // OAuth: auto-approve the grant, bounce straight back with a code
  if (url.pathname === "/login/oauth/authorize") {
    const redirect = new URL(url.searchParams.get("redirect_uri")!);
    redirect.searchParams.set("code", "stub-code");
    redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
    res.writeHead(302, { location: redirect.toString() });
    return res.end();
  }
  if (url.pathname === "/login/oauth/access_token") return json(res, 200, { access_token: "stub-token" });

  // REST
  if (url.pathname === "/user") return json(res, 200, { login: "petra", name: "Petra Prozess", avatar_url: null });
  // installations of THIS app the user can access (org membership + collaborator)
  if (url.pathname === "/user/installations") {
    return json(res, 200, {
      total_count: installations.size,
      installations: [...installations.keys()].map((id) => ({ id })),
    });
  }
  if (/^\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) {
    // effective user permissions, like GET /repos/{owner}/{repo} with a user token
    return json(res, 200, {
      full_name: url.pathname.slice("/repos/".length),
      permissions: { admin: false, maintain: false, push: permission === "write", pull: true },
    });
  }
  if (/^\/repos\/[^/]+\/[^/]+\/pulls$/.test(url.pathname) && req.method === "POST") {
    const payload = JSON.parse(body);
    pulls.push(payload);
    return json(res, 201, { html_url: `http://localhost:${PORT}/fake/pr/${pulls.length}`, number: pulls.length });
  }

  // Issues + labels (todo feature) — like GitHub: 422 on duplicate label, the
  // issues list filters by labels (ALL must match) + state and includes PR rows
  const labelsRoute = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/labels$/);
  const issuesRoute = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues$/);
  if ((labelsRoute || issuesRoute) && issuesForbidden) {
    return json(res, 403, { message: "Resource not accessible by integration" });
  }
  if (labelsRoute && req.method === "POST") {
    const repo = labelsRoute[1]!;
    const { name } = JSON.parse(body) as { name: string };
    const set = repoLabels.get(repo) ?? new Set<string>();
    repoLabels.set(repo, set);
    if (set.has(name)) {
      return json(res, 422, { message: "Validation Failed", errors: [{ resource: "Label", code: "already_exists" }] });
    }
    set.add(name);
    return json(res, 201, { name });
  }
  if (labelsRoute && req.method === "GET") {
    return json(
      res,
      200,
      [...(repoLabels.get(labelsRoute[1]!) ?? [])].map((name) => ({ name })),
    );
  }
  if (issuesRoute && req.method === "POST") {
    const payload = JSON.parse(body) as { title: string; body?: string; labels?: string[] };
    return json(res, 201, addIssue(issuesRoute[1]!, payload));
  }
  if (issuesRoute && req.method === "GET") {
    const state = url.searchParams.get("state") ?? "open";
    const wanted = (url.searchParams.get("labels") ?? "").split(",").filter(Boolean);
    const rows = (repoIssues.get(issuesRoute[1]!) ?? []).filter(
      (i) => (state === "all" || i.state === state) && wanted.every((w) => i.labels.some((l) => l.name === w)),
    );
    return json(res, 200, rows);
  }

  // test control
  if (url.pathname === "/_control" && req.method === "POST") {
    const ctl = JSON.parse(body) as {
      permission?: string;
      addRepo?: string;
      repos?: string[];
      setInstallation?: { id: number; repos: string[]; account?: string; suspended?: boolean };
      removeInstallation?: number;
      /** seed a tracker row directly — pull_request:true makes it a PR-shaped row */
      addIssue?: { repo: string; title: string; body?: string; labels?: string[]; pull_request?: boolean };
      issuesForbidden?: boolean;
    };
    if (ctl.permission) permission = ctl.permission;
    if (ctl.addIssue) addIssue(ctl.addIssue.repo, ctl.addIssue);
    if (typeof ctl.issuesForbidden === "boolean") issuesForbidden = ctl.issuesForbidden;
    if (ctl.repos) installationRepos = ctl.repos;
    if (ctl.addRepo && !installationRepos.includes(ctl.addRepo)) installationRepos.push(ctl.addRepo);
    if (ctl.setInstallation) {
      const i = ctl.setInstallation;
      installations.set(i.id, { repos: i.repos, account: i.account ?? `org-${i.id}`, suspended: i.suspended ?? false });
      if (i.id === 1) installationRepos = i.repos;
    }
    if (ctl.removeInstallation) installations.delete(ctl.removeInstallation);
    return json(res, 200, { permission, installationRepos, installations: [...installations.keys()] });
  }
  if (url.pathname === "/_control") return json(res, 200, { permission, pulls });

  json(res, 404, { error: `stub: no route for ${req.method} ${url.pathname}` });
}).listen(PORT, () => console.log(`stub git provider on http://localhost:${PORT} (permission=${permission})`));
