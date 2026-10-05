import { describe, it, expect } from "vitest";
import { messageView, splitAddressList, htmlToText } from "../src/zoho/messages";
import { ListRow } from "../src/zoho/mail";

const row = ListRow.parse({
  messageId: "9",
  folderId: "1",
  threadId: "7",
  threadCount: 2,
  fromAddress: "Carla <c@example.org>",
  toAddress: "sarabi@example.test, rcp@example.test",
  ccAddress: "",
  subject: "Hi",
  summary: "s",
  receivedTime: 1700000000000,
  sentDateInGMT: 1700000000000,
  status: "unread",
  flagid: "important",
  hasAttachment: 1,
  sender: "Carla",
});

describe("messageView", () => {
  it("keeps Gmail field names and adds folder, flag, archived, read", () => {
    const v = messageView(row, {
      format: "PLAIN_TEXT",
      bodyCharLimit: 100,
      includeBody: true,
      content: "<p>Hello <b>there</b></p>",
      headers: { "Message-ID": ["<a@b>"], "In-Reply-To": ["<z@b>"], "Reply-To": ["r@example.org"] },
    });
    expect(v).toMatchObject({
      id: "9",
      thread_id: "7",
      folder_id: "1",
      subject: "Hi",
      from: "Carla <c@example.org>",
      to: ["sarabi@example.test", "rcp@example.test"],
      message_id_header: "<a@b>",
      in_reply_to: "<z@b>",
      reply_to: ["r@example.org"],
      flag: "important",
      archived: false,
      read: false,
      plaintext_body: "Hello there",
    });
    expect(v.date).toBe(new Date(1700000000000).toISOString());
  });
  it("truncates and flags the body, and omits it when asked", () => {
    const v = messageView(row, { format: "PLAIN_TEXT", bodyCharLimit: 3, includeBody: true, content: "abcdef" });
    expect(v.plaintext_body).toBe("abc");
    expect(v.body_truncated).toBe(true);
    expect(
      messageView(row, { format: "METADATA_ONLY", bodyCharLimit: 3, includeBody: false }).plaintext_body,
    ).toBeUndefined();
  });
  it("splits address lists on commas outside quotes and brackets", () => {
    expect(splitAddressList('"Doe, Jane" <j@example.org>, k@example.org')).toEqual([
      '"Doe, Jane" <j@example.org>',
      "k@example.org",
    ]);
    expect(htmlToText("<div>a<br>b</div><p>c</p>")).toBe("a\nb\nc");
  });
});
