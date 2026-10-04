import type { Env } from "../src/env";
import type { Deps } from "../src/deps";
import { createWorker, type Worker } from "../src/index";
import { Browser, csrfFrom, mintToken } from "./browser";
import type { FakeZoho } from "./fake-zoho";
import { callTool as rawCall } from "./mcp-client";
import { HOST } from "./test-env";

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
  const t = await mintToken(worker, env, z as never, { scope, sub: user, email: `${user}@example.test` });
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
    throw Object.assign(new Error(String(r.result)), { code });
  }
  if (opts.approve && r.result?.status === "pending_approval") {
    const b = await loginAs(w, env, z, { sub: user, email: `${user}@example.test` });
    const page = await b.get(new URL(r.result.approval.url).pathname);
    const html = await page.text();
    await b.post(new URL(r.result.approval.url).pathname, { csrf: csrfFrom(html), decision: "approve" });
    const done = await rawCall(w, env, token, "execute_pending", { action_id: r.result.action_id });
    if (done.isError) throw Object.assign(new Error(String(done.result)), { code: done.result?.error ?? "error" });
    return done.result;
  }
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
