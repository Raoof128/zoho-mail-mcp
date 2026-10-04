import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll } from "vitest";

// No test reaches a real provider. Every outbound call goes through a fake injected as zohoFetch or googleFetch;
// anything that falls through to the global fetch is a test bug, refused loudly rather than sent to Zoho or
// Google (M1 Task 1.6: two recovery tests were found sending a refresh to the real accounts.zoho.com.au).
globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  return Promise.reject(new Error(`network disabled in tests: ${new URL(url).origin}`));
};

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare("INSERT OR REPLACE INTO recovery_installation VALUES(1,5,'test-generation','active')").run();
});
