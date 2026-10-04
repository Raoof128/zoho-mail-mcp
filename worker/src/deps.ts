export type Deps = {
  googleFetch: typeof fetch; // removed in M1 Task 1.6
  zohoFetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  approvalWait: { intervalMs: number; deadlineMs: number };
};
export const defaultDeps: Deps = {
  googleFetch: (input, init) => fetch(input, init),
  zohoFetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  approvalWait: { intervalMs: 2000, deadlineMs: 120_000 },
};
