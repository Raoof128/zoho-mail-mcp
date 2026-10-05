import { describe, it, expect, vi } from "vitest";
import { STAGING_LIMITS as L } from "@zoho-mail-mcp/shared/staging";
import { zohoFixture } from "./zoho-mail.test";
import { callTool } from "./zoho-helpers";
import { leasedDownload } from "../src/staging/downloads";

// Background security review of e8fbdc9 ("control-regression in downloads.ts"): the Zoho-streaming download lost the
// R2 path's admission controls. Each case failed first.
async function sealed() {
  const f = await zohoFixture();
  const m = f.z.mail.seedMessage(f.Z, {
    folder: "Inbox",
    from: "c@example.org",
    to: ["sarabi@example.test"],
    subject: "d",
    content: "x",
    attachments: [{ name: "a.pdf", bytes: new Uint8Array([1, 2, 3]), mime: "application/pdf" }],
  });
  const r = await callTool(f.e, f.d, "u", "download_attachment", {
    account: "sarabi",
    message_id: m.messageId,
    folder_id: m.folderId,
    attachment_id: f.z.mail.get(f.Z, m.messageId)!.attachments[0]!.attachmentId,
  });
  return { ...f, handle: r.handle as string };
}
const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { code?: string }) => e.code ?? "error",
  );

describe("download admission controls", () => {
  it("a handle older than an hour is refused even when its expiry was extended", async () => {
    const { e, d, handle } = await sealed();
    await e.DB.prepare("UPDATE sealed_handles SET created_at = ?, expires_at = ? WHERE handle = ?")
      .bind(Date.now() - 61 * 60_000, Date.now() + 60 * 60_000, handle)
      .run();
    expect(await code(leasedDownload(e, d, "u", handle))).toBe("handle_expired");
  });
  it("an owner cannot hold more concurrent streams than the cap", async () => {
    const f = await zohoFixture();
    const m = f.z.mail.seedMessage(f.Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "d",
      content: "x",
      attachments: Array.from({ length: L.downloadsOwner + 1 }, (_, i) => ({
        name: `f${i}.pdf`,
        bytes: new Uint8Array([i]),
        mime: "application/pdf",
      })),
    });
    const handles: string[] = [];
    for (const att of f.z.mail.get(f.Z, m.messageId)!.attachments)
      handles.push(
        (
          await callTool(f.e, f.d, "u", "download_attachment", {
            account: "sarabi",
            message_id: m.messageId,
            folder_id: m.folderId,
            attachment_id: att.attachmentId,
          })
        ).handle as string,
      );
    const open: ReadableStream<Uint8Array>[] = [];
    for (const h of handles.slice(0, L.downloadsOwner)) open.push((await leasedDownload(f.e, f.d, "u", h)).body);
    expect(await code(leasedDownload(f.e, f.d, "u", handles[L.downloadsOwner]!))).toBe("rate_limited"); // busy, not dead (M5 review I2)
    await Promise.all(open.map((b) => b.cancel()));
    // Cancelling frees the slots.
    const { body } = await leasedDownload(f.e, f.d, "u", handles[L.downloadsOwner]!);
    await new Response(body).arrayBuffer();
  });
  it("download_attachment's digest pass takes a stream slot too (security review of 6e0b0dc)", async () => {
    const f = await zohoFixture();
    const m = f.z.mail.seedMessage(f.Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "d",
      content: "x",
      attachments: Array.from({ length: L.downloadsOwner + 1 }, (_, i) => ({
        name: `g${i}.pdf`,
        bytes: new Uint8Array([i]),
        mime: "application/pdf",
      })),
    });
    const atts = f.z.mail.get(f.Z, m.messageId)!.attachments;
    const seal = (i: number) =>
      callTool(f.e, f.d, "u", "download_attachment", {
        account: "sarabi",
        message_id: m.messageId,
        folder_id: m.folderId,
        attachment_id: atts[i]!.attachmentId,
      });
    const open: ReadableStream<Uint8Array>[] = [];
    for (let i = 0; i < L.downloadsOwner; i++)
      open.push((await leasedDownload(f.e, f.d, "u", (await seal(i)).handle as string)).body);
    await expect(seal(L.downloadsOwner)).rejects.toMatchObject({ code: "rate_limited" });
    await Promise.all(open.map((b) => b.cancel()));
    expect((await seal(L.downloadsOwner)).handle).toMatch(/^sh_/);
  });
  it("a stream that outlives its lease is cut off, so a lapsed slot cannot hide a live stream", async () => {
    const f = await zohoFixture();
    const m = f.z.mail.seedMessage(f.Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "d",
      content: "x",
      attachments: [{ name: "slow.bin", bytes: new Uint8Array(4096), mime: "application/octet-stream" }],
    });
    const h = (
      await callTool(f.e, f.d, "u", "download_attachment", {
        account: "sarabi",
        message_id: m.messageId,
        folder_id: m.folderId,
        attachment_id: f.z.mail.get(f.Z, m.messageId)!.attachments[0]!.attachmentId,
      })
    ).handle as string;
    const { body } = await leasedDownload(f.e, f.d, "u", h);
    const real = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(real + L.leaseMs + 1000);
    try {
      await expect(new Response(body).arrayBuffer()).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("download storage stays bounded (security review of the attachments tool)", () => {
  it("the cron purges an expired handle together with its one-time link instead of failing on the reference", async () => {
    const { runCron } = await import("../src/cron");
    const { testEnv } = await import("./test-env");
    const f = await sealed();
    const link = await f.e.DB.prepare("SELECT id FROM download_links WHERE handle = ?")
      .bind(f.handle)
      .first<{ id: string }>();
    expect(link).not.toBeNull();
    await f.e.DB.prepare("UPDATE sealed_handles SET expires_at = ? WHERE handle = ?")
      .bind(Date.now() - 1, f.handle)
      .run();
    await f.e.DB.prepare("UPDATE download_links SET expires_at = ? WHERE handle = ?")
      .bind(Date.now() - 1, f.handle)
      .run();
    await runCron(testEnv(), Date.now());
    expect(
      await f.e.DB.prepare("SELECT count(*) AS n FROM sealed_handles WHERE handle = ?").bind(f.handle).first(),
    ).toEqual({ n: 0 });
    expect(
      await f.e.DB.prepare("SELECT count(*) AS n FROM download_links WHERE handle = ?").bind(f.handle).first(),
    ).toEqual({ n: 0 });
  });
  it("an owner cannot pile up unbounded outstanding download handles", async () => {
    const f = await sealed();
    const now = Date.now();
    for (let i = 0; i < 25; i++)
      await f.e.DB.prepare(
        `INSERT INTO sealed_handles (handle,user_id,account_id,direction,provider_ref,filename,mime,size,sha256,created_at,expires_at) VALUES (?,?,?,'download','{}','f','m',1,?,?,?)`,
      )
        .bind(`sh_${String(i).padStart(43, "q")}`, "u", f.accountId, "0".repeat(64), now, now + 600_000)
        .run();
    const m = f.z.mail.seedMessage(f.Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "e",
      content: "x",
      attachments: [{ name: "e.pdf", bytes: new Uint8Array([9]), mime: "application/pdf" }],
    });
    await expect(
      callTool(f.e, f.d, "u", "download_attachment", {
        account: "sarabi",
        message_id: m.messageId,
        folder_id: m.folderId,
        attachment_id: f.z.mail.get(f.Z, m.messageId)!.attachments[0]!.attachmentId,
      }),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });
});
