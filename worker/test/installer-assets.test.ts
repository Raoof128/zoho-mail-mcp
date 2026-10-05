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
