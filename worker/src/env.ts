import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cloudflare {
    interface Env {
      BUILD_ID: string;
      TOKEN_KEKS: string;
      TOKEN_KEK_CURRENT: string;
      STATE_HMAC_KEY: string;
      CSRF_HMAC_KEY: string;
      // Google stays declared until M1 Task 1.6 deletes worker/src/google.
      GOOGLE_CLIENT_ID: string;
      GOOGLE_CLIENT_SECRET: string;
      ZOHO_CLIENT_ID: string;
      ZOHO_CLIENT_SECRET: string;
      OWNER_ZOHO_SUBS: string; // comma separated Zoho subs allowed to log in; empty enables bootstrap
      OWNER_EMAILS: string;
      SLOTS: string; // JSON {"sarabi": "info@...", "rcp": "info@..."}
      ORG_DOMAINS: string; // comma separated
      OAUTH_PROVIDER: OAuthHelpers;
    }
  }
}
export type Env = Omit<Cloudflare.Env, "RECOVERY_PROFILE" | "RESTORE_GENERATION"> & {
  RECOVERY_PROFILE: "normal" | "scratch";
  RESTORE_GENERATION: string;
};

const csv = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "");
export function ownerSubs(env: Env): string[] {
  return csv(env.OWNER_ZOHO_SUBS);
}
export function ownerEmails(env: Env): string[] {
  return csv(env.OWNER_EMAILS).map((e) => e.toLowerCase());
}
export function orgDomains(env: Env): string[] {
  return csv(env.ORG_DOMAINS).map((d) => d.toLowerCase());
}
export const SLOT_NAMES = ["sarabi", "rcp"] as const;
export type Slot = (typeof SLOT_NAMES)[number];
const Slots = z.strictObject({ sarabi: z.email(), rcp: z.email() });
export function slots(env: Env): Record<Slot, string> {
  const parsed = Slots.safeParse(JSON.parse(env.SLOTS));
  if (!parsed.success) throw new Error("SLOTS must be exactly {sarabi, rcp} with valid addresses");
  return { sarabi: parsed.data.sarabi.toLowerCase(), rcp: parsed.data.rcp.toLowerCase() };
}
