export type Deps = {
  zohoFetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  approvalWait: { intervalMs: number; deadlineMs: number };
  /** Test-only handle to the fake behind zohoFetch, read by test/zoho-helpers.ts. Never set in production. */
  __zoho?: unknown;
};
export const defaultDeps: Deps = {
  zohoFetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  approvalWait: { intervalMs: 2000, deadlineMs: 120_000 },
};
