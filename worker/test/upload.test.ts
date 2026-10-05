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

describe("uploadToZoho memory (security review of 421a605)", () => {
  it("pulls the body only as fast as Zoho reads it: no tee buffering ahead of the upload", async () => {
    const { e, d, acct } = await zohoFixture();
    const CHUNKS = 64;
    const chunk = new Uint8Array(1024).fill(7);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          if (pulled === CHUNKS) return c.close();
          pulled++;
          c.enqueue(chunk);
        },
      },
      { highWaterMark: 0 },
    );
    const all = new Uint8Array(CHUNKS * 1024).fill(7);
    const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", all))]
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    let pulledAfterFirstRead = -1;
    const slowZoho: typeof fetch = async (input, init) => {
      const req = new Request(input, init);
      if (!new URL(req.url).pathname.endsWith("/messages/attachments")) return d.zohoFetch(input, init);
      const reader = req.body!.getReader();
      await reader.read();
      await new Promise((r) => setTimeout(r, 30));
      pulledAfterFirstRead = pulled;
      let n = 1024;
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        n += r.value.byteLength;
      }
      return Response.json({
        status: { code: 200 },
        data: { storeName: "store-x", attachmentName: "m.bin", attachmentPath: "/p", attachmentSize: n },
      });
    };
    const r = await uploadToZoho(e, { ...d, zohoFetch: slowZoho }, acct, {
      fileName: "m.bin",
      size: CHUNKS * 1024,
      body,
      declaredSha256: sha,
    });
    expect(r.sha256).toBe(sha);
    expect(pulledAfterFirstRead).toBeLessThan(CHUNKS / 2);
  });
});
