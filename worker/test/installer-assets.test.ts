import { createExecutionContext } from "cloudflare:test";
import { it, expect } from "vitest";
import { createWorker } from "../src/index";
import { testEnv } from "./test-env";
import type { Env } from "../src/env";

const e = testEnv();
function withAssets() {
  const seen: string[] = [];
  const assets = {
    fetch: (request: Request) => {
      seen.push(new URL(request.url).pathname);
      return Promise.resolve(new Response("asset", { status: 200 }));
    },
  };
  return { seen, env: { ...e, ASSETS: assets } as unknown as Env };
}
it("serves exactly the four installer files from static assets, stamped, on GET only", async () => {
  const worker = createWorker();
  const { seen, env: assetsEnv } = withAssets();
  for (const path of ["/install.sh", "/companion.tgz", "/companion.sha256", "/companion.version"]) {
    const res = await worker.fetch(
      new Request(`https://${e.WORKER_HOSTNAME}${path}`),
      assetsEnv,
      createExecutionContext(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("asset");
    expect(res.headers.get("x-recovery-build")).toBe(e.BUILD_ID);
  }
  await worker.fetch(
    new Request(`https://${e.WORKER_HOSTNAME}/install.sh`, { method: "POST" }),
    assetsEnv,
    createExecutionContext(),
  );
  await worker.fetch(new Request(`https://${e.WORKER_HOSTNAME}/.gitkeep`), assetsEnv, createExecutionContext());
  await worker.fetch(new Request(`https://${e.WORKER_HOSTNAME}/.assetsignore`), assetsEnv, createExecutionContext());
  expect(seen).toEqual(["/install.sh", "/companion.tgz", "/companion.sha256", "/companion.version"]);
});
it("publishes the companion's public client id without a session, and 404s until it is registered", async () => {
  const worker = createWorker();
  const get = () =>
    worker.fetch(new Request(`https://${e.WORKER_HOSTNAME}/companion-client-id`), e, createExecutionContext());
  await e.DB.prepare("DELETE FROM settings WHERE key='companion_client_id'").run();
  expect((await get()).status).toBe(404);
  await e.DB.prepare("INSERT INTO settings(key,value,updated_at) VALUES('companion_client_id','pending',0)").run();
  expect((await get()).status).toBe(404);
  await e.DB.prepare("UPDATE settings SET value='cid_abc' WHERE key='companion_client_id'").run();
  const res = await get();
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.text()).toBe("cid_abc");
  await e.DB.prepare("DELETE FROM settings WHERE key='companion_client_id'").run();
});
