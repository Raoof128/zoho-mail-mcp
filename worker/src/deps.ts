export type Deps = {
  /** The Gmail API transport (google/gmail.ts and the recovery probe); removed with them in M4 Task 4.2. */
  googleFetch: typeof fetch;
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
