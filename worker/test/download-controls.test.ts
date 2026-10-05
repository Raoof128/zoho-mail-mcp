import { describe, it, expect } from "vitest";
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
    expect(await code(leasedDownload(f.e, f.d, "u", handles[L.downloadsOwner]!))).toBe("handle_invalid");
    await Promise.all(open.map((b) => b.cancel()));
    // Cancelling frees the slots.
    const { body } = await leasedDownload(f.e, f.d, "u", handles[L.downloadsOwner]!);
    await new Response(body).arrayBuffer();
  });
});
