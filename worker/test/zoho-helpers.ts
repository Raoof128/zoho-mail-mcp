import type { Env } from "../src/env";
import type { Deps } from "../src/deps";
import { createWorker, type Worker } from "../src/index";
import { Browser, csrfFrom, mintToken } from "./browser";
import type { FakeZoho } from "./fake-zoho";
import { callTool as rawCall } from "./mcp-client";
import { HOST } from "./test-env";
import { registerCompanionClient } from "../src/auth/companion";

const workers = new WeakMap<Deps, Worker>();
const tokens = new Map<string, string>();
function workerFor(deps: Deps): Worker {
  let w = workers.get(deps);
  if (!w) {
    w = createWorker(deps);
    workers.set(deps, w);
  }
  return w;
}
const zohoOf = (deps: Deps): FakeZoho => (deps as Deps & { __zoho: FakeZoho }).__zoho; // testDeps(z) attaches z as __zoho

export async function loginAs(
  worker: Worker,
  env: Env,
  z: FakeZoho,
  o: { sub: string; email: string },
): Promise<Browser> {
  const b = new Browser(worker, env);
  const res = await b.login(z, o);
  if (res.status !== 303) throw new Error(`login failed ${res.status}`);
  return b;
}
export async function mcpTokenFor(
  worker: Worker,
  env: Env,
  z: FakeZoho,
  user: string,
  scope: "mcp" | "staging" = "mcp",
): Promise<string> {
  const key = `${scope}:${user}`;
  const cached = tokens.get(key);
  if (cached) return cached;
  // Staging tokens are issued to the registered companion client on its loopback redirect, as in staging-api.test.
  const t =
    scope === "staging"
      ? await (async () => {
          const browser = new Browser(worker, env);
          await browser.login(z, { sub: user, email: `${user}@example.test` });
          const clientId = await registerCompanionClient({ ...env, OAUTH_PROVIDER: undefined as never }, worker);
          return mintToken(worker, env, z, {
            scope: "staging",
            clientId,
            redirectUri: "http://127.0.0.1:61234/callback",
            browser,
            sub: user,
            email: `${user}@example.test`,
          });
        })()
      : await mintToken(worker, env, z, { scope, sub: user, email: `${user}@example.test` });
  tokens.set(key, t.accessToken);
  return t.accessToken;
}
export async function callTool(
  env: Env,
  deps: Deps,
  user: string,
  name: string,
  args: Record<string, unknown>,
  opts: { approve?: boolean } = {},
): Promise<any> {
  const w = workerFor(deps);
  const z = zohoOf(deps);
  const token = await mcpTokenFor(w, env, z, user);
  const r = await rawCall(w, env, token, name, args);
  if (r.isError) {
    const code = typeof r.result === "object" && r.result?.error ? r.result.error : String(r.result).split(":")[0];
    throw Object.assign(new Error(typeof r.result === "object" ? JSON.stringify(r.result) : String(r.result)), {
      code,
    });
  }
  if (opts.approve && r.result?.status === "pending_approval") return approvePending(env, deps, user, r.result);
  return r.result;
}
export async function stagingGet(env: Env, deps: Deps, user: string, handle: string): Promise<Response> {
  const w = workerFor(deps);
  const token = await mcpTokenFor(w, env, zohoOf(deps), user, "staging");
  return w.fetch(
    new Request(`${HOST}/staging/${handle}`, { headers: { authorization: `Bearer ${token}` } }),
    env,
    {} as never,
  );
}

/** Approves a pending action in the browser as its owner, then runs it with execute_pending. */
export async function approvePending(
  env: Env,
  deps: Deps,
  user: string,
  pending: { approval: { url: string }; action_id: string },
): Promise<any> {
  const w = workerFor(deps);
  const z = zohoOf(deps);
  const token = await mcpTokenFor(w, env, z, user);
  const b = await loginAs(w, env, z, { sub: user, email: `${user}@example.test` });
  const path = new URL(pending.approval.url).pathname;
  const html = await (await b.get(path)).text();
  // The page carries more than one form; take the approval form's token.
  const posted = await b.post(path, { csrf: csrfFrom(html, path), decision: "approve" });
  if (posted.status >= 400) throw new Error(`approval refused: ${posted.status} ${await posted.text()}`);
  const done = await rawCall(w, env, token, "execute_pending", { action_id: pending.action_id });
  if (done.isError)
    throw Object.assign(
      new Error(typeof done.result === "object" ? JSON.stringify(done.result) : String(done.result)),
      { code: done.result?.error ?? "error" },
    );
  return done.result;
}
