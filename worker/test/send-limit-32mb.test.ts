import { env } from "cloudflare:test";
import { it, expect } from "vitest";
import { seedUserAndAccount } from "./fixtures";
import { MESSAGE_BYTES_CEILING } from "../src/tools/compose";

// Raouf, 2026-10-05: raise the per-message send limit to the spec's 32 MB (D14), up from the
// Gmail-era 25 MiB column cap. The per-file staging cap stays 25 MiB.
it("lets an account's send limit reach the 32 MB message ceiling, never past it, and defaults to it", async () => {
  await seedUserAndAccount(env.DB, { userId: "u32", accountId: "ac32", alias: "sarabi", slot: "sarabi" });
  const row = await env.DB.prepare("SELECT send_limit_bytes FROM accounts WHERE id='ac32'").first<{
    send_limit_bytes: number;
  }>();
  expect(row!.send_limit_bytes).toBe(MESSAGE_BYTES_CEILING);
  await env.DB.prepare("UPDATE accounts SET send_limit_bytes=? WHERE id='ac32'").bind(MESSAGE_BYTES_CEILING).run();
  await expect(
    env.DB.prepare("UPDATE accounts SET send_limit_bytes=? WHERE id='ac32'")
      .bind(MESSAGE_BYTES_CEILING + 1)
      .run(),
  ).rejects.toThrow(/CHECK/);
});
it("keeps every foreign key that points at accounts after the table rebuild", async () => {
  const fk = await env.DB.prepare("PRAGMA foreign_key_check").all();
  expect(fk.results).toEqual([]);
  const idx = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='accounts'").all<{
    name: string;
  }>();
  expect(idx.results.map((r) => r.name)).toEqual(
    expect.arrayContaining(["accounts_one_default", "accounts_user_slot_live"]),
  );
});
it("rebuilds accounts with every column it had, including ones later migrations added", async () => {
  const cols = await env.DB.prepare("PRAGMA table_info(accounts)").all<{ name: string }>();
  expect(cols.results.map((c) => c.name)).toEqual([
    "id",
    "user_id",
    "alias",
    "slot",
    "expected_primary_email",
    "zoho_account_id",
    "location",
    "zoho_sub",
    "zoho_email",
    "send_as",
    "org_domains",
    "scopes",
    "status",
    "is_default",
    "send_limit_bytes",
    "refresh_token_enc",
    "refresh_token_key_id",
    "access_token_enc",
    "access_token_key_id",
    "access_expires_at",
    "created_at",
    "last_refresh_at",
    "credential_version",
  ]);
});
