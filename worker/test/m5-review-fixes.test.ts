import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { STAGING_LIMITS as L } from "@zoho-mail-mcp/shared/staging";
import { zohoFixture } from "./zoho-mail.test";
import { callTool, loginAs, stagingGet } from "./zoho-helpers";
import { seedUserAndAccount } from "./fixtures";
import { testEnv } from "./test-env";
import { runCron } from "../src/cron";
import { createWorker } from "../src/index";
import { leasedDownload } from "../src/staging/downloads";

// Final review of M5 (2026-10-05). Each case failed before its fix.
async function withAttachments(n: number) {
  const f = await zohoFixture();
  const m = f.z.mail.seedMessage(f.Z, {
    folder: "Inbox",
    from: "c@example.org",
    to: ["sarabi@example.test"],
    subject: "a",
    content: "x",
    attachments: Array.from({ length: n }, (_, i) => ({
      name: `a${i}.pdf`,
      bytes: new Uint8Array([i, 1, 2]),
      mime: "application/pdf",
    })),
  });
  const seal = async (i: number) =>
    callTool(f.e, f.d, "u", "download_attachment", {
      account: "sarabi",
      message_id: m.messageId,
      folder_id: m.folderId,
      attachment_id: f.z.mail.get(f.Z, m.messageId)!.attachments[i]!.attachmentId,
    });
  return { ...f, seal };
}

describe("C1: the cron purges admission and recovery state, so caps never fill permanently", () => {
  it("expired recovery slots, acknowledgements, admissions, lapsed streams and finished transfers are removed", async () => {
    await seedUserAndAccount(env.DB, { userId: "uc1", accountId: "ac1", alias: "sarabi", slot: "sarabi" });
    const past = Date.now() - 86_400_000;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO staging_recovery_slots (user_id, key, units, retain_until) VALUES ('uc1', 'download:sh_old', 2, ?)",
      ).bind(past),
      env.DB.prepare("INSERT INTO download_admissions VALUES ('uc1','sh_old','ac1',?,?,?)").bind(past, past, past),
      env.DB.prepare("INSERT INTO download_streams VALUES ('ds_old','uc1','sh_old',?)").bind(past),
      env.DB.prepare("INSERT INTO staging_acknowledgements VALUES ('uc1','sh_ack','ac1',?,?)").bind(past, past),
      env.DB.prepare(
        "INSERT INTO upload_transfers (user_id,id,account_id,account_alias,metadata_json,intent_hash,state,created_at,authority_until,retain_until) VALUES ('uc1','tr_done','ac1','sarabi','{}','h','completed',?,?,?)",
      ).bind(past, past, past),
    ]);
    await runCron(testEnv(), Date.now());
    const n = async (sql: string) => (await env.DB.prepare(sql).first<{ n: number }>())!.n;
    expect(await n("SELECT count(*) AS n FROM staging_recovery_slots WHERE user_id='uc1'")).toBe(0);
    expect(await n("SELECT count(*) AS n FROM download_admissions WHERE user_id='uc1'")).toBe(0);
    expect(await n("SELECT count(*) AS n FROM download_streams WHERE user_id='uc1'")).toBe(0);
    expect(await n("SELECT count(*) AS n FROM staging_acknowledgements WHERE user_id='uc1'")).toBe(0);
    expect(await n("SELECT count(*) AS n FROM upload_transfers WHERE user_id='uc1'")).toBe(0);
  });
});

describe("I1 and I2: a busy refusal is rate_limited and does not burn the one-time link", () => {
  it("at the stream cap the link answers 429 and still works once the slots free", async () => {
    const f = await withAttachments(L.downloadsOwner + 1);
    const open: ReadableStream<Uint8Array>[] = [];
    for (let i = 0; i < L.downloadsOwner; i++)
      open.push((await leasedDownload(f.e, f.d, "u", (await f.seal(i)).handle as string)).body);
    const r = await f.seal(L.downloadsOwner).catch(() => null);
    expect(r).toBeNull(); // the digest pass itself is refused at the cap
    for (const b of open) await b.cancel();
    const sealed = await f.seal(L.downloadsOwner);
    for (let i = 0; i < L.downloadsOwner; i++) open.splice(0, 1);
    const held: ReadableStream<Uint8Array>[] = [];
    for (let i = 0; i < L.downloadsOwner; i++)
      held.push((await leasedDownload(f.e, f.d, "u", (await f.seal(i)).handle as string)).body);
    const w = createWorker(f.d);
    const owner = await loginAs(w, f.e, f.z, { sub: "u", email: "u@example.test" });
    const path = new URL(sealed.one_time_link as string).pathname;
    const atCap = await owner.get(path);
    expect(atCap.status + " " + (await atCap.text())).toMatch(/^429/);
    const busy = await stagingGet(f.e, f.d, "u", sealed.handle as string);
    expect(busy.status).toBe(429);
    for (const b of held) await b.cancel();
    const ok = await owner.get(path);
    expect(ok.status).toBe(200);
    await ok.arrayBuffer();
  });
});

describe("I3: one failing cron step does not stop the others", () => {
  it("the audit purge still runs when the sealed-handle purge fails", async () => {
    await seedUserAndAccount(env.DB, { userId: "uc3", accountId: "ac3", alias: "sarabi", slot: "sarabi" });
    await env.DB.prepare(
      "INSERT INTO audit_log (ts, user_id, account_id, tool, action, phase, decision) VALUES (?, 'uc3', 'ac3', 't', 'read.search', 'intent', 'allow')",
    )
      .bind(Date.now() - 400 * 86_400_000)
      .run();
    await env.DB.prepare("ALTER TABLE download_links RENAME TO download_links_away").run();
    try {
      await runCron(testEnv(), Date.now());
    } finally {
      await env.DB.prepare("ALTER TABLE download_links_away RENAME TO download_links").run();
    }
    expect(
      (await env.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE user_id='uc3'").first<{ n: number }>())!.n,
    ).toBe(0);
  });
});

describe("I4: the digest pass cannot outrun its slot", () => {
  it("digestWithin stops a stream that runs past its deadline, and enforces the size limit", async () => {
    const { digestWithin } = await import("../src/tools/attachments");
    const body = () => new Response(new Uint8Array([1, 2, 3])).body as ReadableStream<Uint8Array>;
    await expect(digestWithin(body(), 10, Date.now() - 1)).rejects.toMatchObject({ code: "handle_expired" });
    await expect(digestWithin(body(), 2, Date.now() + 60_000)).rejects.toMatchObject({ code: "limit_exceeded" });
    const ok = await digestWithin(body(), 10, Date.now() + 60_000);
    expect(ok.length).toBe(3);
    expect(ok.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
