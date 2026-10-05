import { describe, it, expect } from "vitest";
import { zohoFixture } from "./zoho-mail.test";
import { uploadToZoho } from "../src/zoho/attachments";
import { hashCanonical } from "../src/crypto/canonical";

const stream = (bytes: Uint8Array) => new Response(bytes).body as ReadableStream<Uint8Array>;
describe("uploadToZoho", () => {
  it("streams to Zoho, hashes on the way, returns the store triple", async () => {
    const { z, e, d, acct } = await zohoFixture();
    const bytes = new TextEncoder().encode("hello zoho");
    const sha = await hashCanonical(new TextDecoder().decode(bytes));
    const r = await uploadToZoho(e, d, acct, {
      fileName: "h.txt",
      size: bytes.byteLength,
      body: stream(bytes),
      declaredSha256: sha,
    });
    expect(r.sha256).toBe(sha);
    expect(z.mail.uploads.get(r.ref.storeName)!.bytes).toEqual(bytes);
    expect(r.ref.attachmentSize).toBe(bytes.byteLength);
  });
  it("refuses a body whose digest differs from the declared one and seals nothing", async () => {
    const { e, d, acct } = await zohoFixture();
    const bytes = new TextEncoder().encode("tampered");
    await expect(
      uploadToZoho(e, d, acct, {
        fileName: "t.txt",
        size: bytes.byteLength,
        body: stream(bytes),
        declaredSha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "handle_invalid" });
    expect((await e.DB.prepare("SELECT count(*) AS n FROM sealed_handles").first<{ n: number }>())!.n).toBe(0);
  });
  it("refuses a body longer than declared before Zoho sees the extra bytes", async () => {
    const { e, d, acct } = await zohoFixture();
    const bytes = new Uint8Array(10);
    await expect(
      uploadToZoho(e, d, acct, { fileName: "l.bin", size: 5, body: stream(bytes), declaredSha256: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  });
});
