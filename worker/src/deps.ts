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
  // Retired in production: gmail.ts and the recovery probe now carry Zoho access tokens, and a live transport would
  // send them to gmail.googleapis.com. Only tests inject a Gmail double here. The seam goes in M4 Task 4.2.
  googleFetch: () => Promise.reject(new Error("The Gmail transport is retired; Zoho tools replace it in M2 to M4.")),
  zohoFetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  approvalWait: { intervalMs: 2000, deadlineMs: 120_000 },
};
