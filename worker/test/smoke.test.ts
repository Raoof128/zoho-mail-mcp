import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createWorker } from "../src/index";
import { testEnv } from "./test-env";
const worker = createWorker();

describe("worker smoke", () => {
  it("returns 404 for an unknown path", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://x.test/nope"), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
  });

  it("has the D1 and KV bindings and no byte store (spec D16)", () => {
    expect(env.DB).toBeDefined();
    expect((env as unknown as Record<string, unknown>).STAGING).toBeUndefined();
    expect(env.OAUTH_KV).toBeDefined();
  });
});
