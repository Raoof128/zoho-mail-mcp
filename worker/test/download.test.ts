import { describe, it, expect } from "vitest";
import { zohoFixture } from "./zoho-mail.test";
import { callTool, loginAs, stagingGet } from "./zoho-helpers";
import { createWorker } from "../src/index";
import { HOST } from "./test-env";
import { hashCanonical } from "../src/crypto/canonical";

describe("download_attachment and the staging GET", () => {
  it("seals a handle with the real digest and streams the bytes to the companion with x-size and x-sha256", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const bytes = new TextEncoder().encode("%PDF-1.4 fake");
    const m = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "doc",
      content: "x",
      attachments: [{ name: "doc.pdf", bytes, mime: "application/pdf" }],
    });
    const att = z.mail.get(Z, m.messageId)!.attachments[0]!;
    const r = await callTool(e, d, "u", "download_attachment", {
      account: "sarabi",
      message_id: m.messageId,
      folder_id: m.folderId,
      attachment_id: att.attachmentId,
    });
    expect(r.sha256).toBe(await hashCanonical(new TextDecoder().decode(bytes)));
    expect(r.size).toBe(bytes.byteLength);
    const res = await stagingGet(e, d, "u", r.handle as string);
    expect(res.headers.get("x-size")).toBe(String(bytes.byteLength));
    expect(res.headers.get("x-sha256")).toBe(r.sha256);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    expect(
      (await e.DB.prepare("SELECT count(*) AS n FROM sealed_handles WHERE direction='download'").first<{
        n: number;
      }>())!.n,
    ).toBe(1);
  });
  it("refuses an attachment over 25 MiB before any stream", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const m = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "big",
      content: "x",
      attachments: [{ name: "big.bin", bytes: new Uint8Array(1), mime: "application/octet-stream" }],
    });
    z.mail.get(Z, m.messageId)!.attachments[0]!.attachmentSize = 26 * 1024 * 1024;
    await expect(
      callTool(e, d, "u", "download_attachment", {
        account: "sarabi",
        message_id: m.messageId,
        folder_id: m.folderId,
        attachment_id: z.mail.get(Z, m.messageId)!.attachments[0]!.attachmentId,
      }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  });
  it("the one-time link works once, only in the owner's signed-in browser, and always downloads (never renders)", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const bytes = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    const m = z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "page",
      content: "x",
      attachments: [{ name: "page.html", bytes, mime: "text/html" }],
    });
    const r = await callTool(e, d, "u", "download_attachment", {
      account: "sarabi",
      message_id: m.messageId,
      folder_id: m.folderId,
      attachment_id: z.mail.get(Z, m.messageId)!.attachments[0]!.attachmentId,
    });
    const path = new URL(r.one_time_link as string).pathname;
    const w = createWorker(d);
    // Without the owner's session (a link mailed out by an injected agent) it gives nothing away.
    const anon = await w.fetch(new Request(HOST + path), e, { waitUntil() {}, passThroughOnException() {} } as never);
    expect(anon.status).not.toBe(200);
    expect(await anon.text()).not.toContain("alert(1)");
    const owner = await loginAs(w, e, z, { sub: "u", email: "u@example.test" });
    const got = await owner.get(path);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("application/octet-stream");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(got.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
    expect((await owner.get(path)).status).toBe(404); // used once
  });
});
