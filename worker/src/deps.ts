export type Deps = {
  googleFetch: typeof fetch; // removed in M1 Task 1.6
  zohoFetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  approvalWait: { intervalMs: number; deadlineMs: number };
  /** Test-only handle to the fake behind zohoFetch, read by test/zoho-helpers.ts. Never set in production. */
  __zoho?: unknown;
};
export const defaultDeps: Deps = {
  googleFetch: (input, init) => fetch(input, init),
  zohoFetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  approvalWait: { intervalMs: 2000, deadlineMs: 120_000 },
};
