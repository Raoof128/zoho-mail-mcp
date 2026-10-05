import { describe, it, expect } from "vitest";
import { zohoFixture } from "./zoho-mail.test";
import { callTool } from "./zoho-helpers";
import { ListRow } from "../src/zoho/mail";
import { messageView, htmlToText } from "../src/zoho/messages";
import { systemFolders } from "../src/zoho/folders";

// Final review of M2 (2026-10-05). Rows below are copied from the saved official pages
// docs/superpowers/specs/2026-10-03-zoho-sources/get-emails-list.html and get-search-emails.html.
const LIST_ROW = {
  summary: "reply test On Fri, 08 Mar 2024 07:31:31 +0000 rebecca&lt;rebecca@zylker.com&gt; wrote -",
  sentDateInGMT: "1709867251000",
  calendarType: 0,
  subject: "Re: Hello ",
  messageId: "1709887058769100001",
  threadCount: "0",
  flagid: "flag_not_set",
  status2: "0",
  priority: "3",
  hasInline: "false",
  toAddress: "&quot;rebecca&quot;&lt;rebecca@zylker.com&gt;",
  folderId: "9000000002014",
  ccAddress: "Not Provided",
  threadId: "1709883095364100001",
  hasAttachment: "0",
  size: "1190",
  sender: "rebecca",
  receivedTime: "1709887053409",
  fromAddress: "rebecca@zylker.com",
  status: "1",
};
// The search page returns ids as JSON numbers; a 19-digit id loses precision in JSON.parse, so the exact ids are
// taken from URI. This row is the documented one with its ids made 19 digits and the numeric fields rounded.
const SEARCH_JSON = `{"URI":"https://mail.zoho.com/api/accounts/123456789/folders/9000000000905/messages/1709887058769100003","hasAttachment":0,"fromAddress":"rebecca@zylker.com","folderId":9000000000905,"messageId":1709887058769100003,"sender":"Maria Daniel","summary":"It is extremely important for us to focus on","status2":"reply","sentDateInGMT":1270171976000,"size":540,"status":"read","priority":3,"threadCount":0,"flagid":2,"subject":"Marketing Strategy","threadId":1,"receivedtime":1425388373920}`;

describe("C1: list and search rows in Zoho's documented shapes", () => {
  it('parses the documented list row: string fields, status 1, hasAttachment "0", escaped and absent addresses', () => {
    const v = messageView(ListRow.parse(LIST_ROW), { format: "METADATA_ONLY", bodyCharLimit: 0, includeBody: false });
    expect(v).toMatchObject({
      id: "1709887058769100001",
      folder_id: "9000000002014",
      thread_id: "1709883095364100001",
      to: ['"rebecca"<rebecca@zylker.com>'],
      cc: [],
      read: true,
      has_attachment: false,
      flag: "flag_not_set",
      snippet: "reply test On Fri, 08 Mar 2024 07:31:31 +0000 rebecca<rebecca@zylker.com> wrote -",
    });
    expect(v.date).toBe(new Date(1709887053409).toISOString());
  });
  it("parses the documented search row: exact ids from URI, lowercase receivedtime, numeric flag, read status", () => {
    const v = messageView(ListRow.parse(JSON.parse(SEARCH_JSON)), {
      format: "METADATA_ONLY",
      bodyCharLimit: 0,
      includeBody: false,
    });
    expect(v).toMatchObject({
      id: "1709887058769100003",
      folder_id: "9000000000905",
      read: true,
      flag: "important",
      has_attachment: false,
    });
    expect(v.date).toBe(new Date(1425388373920).toISOString());
  });
});

describe("I1: a folder filter uses Zoho's in: syntax", () => {
  it("search_messages with folder sends in:<folder>, quoted when it has a space", async () => {
    const { z, e, d } = await zohoFixture();
    await callTool(e, d, "u", "search_messages", { account: "sarabi", query: "subject:Quote", folder: "Sent" });
    await callTool(e, d, "u", "search_messages", { account: "sarabi", query: "subject:Quote", folder: "Old Quotes" });
    const keys = z.mail.requests
      .map((r) => new URL(r.url))
      .filter((u) => u.pathname.endsWith("/messages/search"))
      .map((u) => u.searchParams.get("searchKey"));
    expect(keys).toEqual(["subject:Quote::in:Sent", 'subject:Quote::in:"Old Quotes"']);
  });
});

describe("I2: hostile HTML cannot stall the text conversion", () => {
  it("converts half a megabyte of unclosed openers in well under a second", () => {
    for (const unit of ["<style", "<", "<a "]) {
      const t0 = performance.now();
      htmlToText(unit.repeat(80_000));
      expect(performance.now() - t0).toBeLessThan(1000);
    }
    expect(htmlToText("<div>a<br>b</div><p>c</p><style>x{}</style><script>bad()</script>d")).toBe("a\nb\nc\nd");
  });
});

describe("I3: get_thread's cursor continues the bodies", () => {
  it("a second call with next_cursor returns the remaining bodies", async () => {
    const { z, e, d, Z } = await zohoFixture();
    for (let i = 0; i < 12; i++)
      z.mail.seedMessage(Z, {
        folder: "Inbox",
        from: "c@example.org",
        to: ["sarabi@example.test"],
        subject: `m${i}`,
        content: `<p>${i}</p>`,
        threadId: "900",
      });
    const args = { account: "sarabi", thread_id: "900", message_format: "PLAIN_TEXT" };
    const first = await callTool(e, d, "u", "get_thread", args);
    const second = await callTool(e, d, "u", "get_thread", { ...args, cursor: first.thread.next_cursor });
    const withBody = (r: { thread: { messages: { id: string; plaintext_body?: string }[] } }) =>
      r.thread.messages.filter((m) => m.plaintext_body !== undefined).map((m) => m.id);
    expect(withBody(first)).toHaveLength(8);
    expect(withBody(second)).toHaveLength(4);
    expect(new Set([...withBody(first), ...withBody(second)]).size).toBe(12);
    expect(second.thread.next_cursor).toBeUndefined();
  });
});

describe("I4: search_threads never drops threads between pages", () => {
  it("30 single-message threads at limit 20 come back as 20 then 10", async () => {
    const { z, e, d, Z } = await zohoFixture();
    for (let i = 0; i < 30; i++)
      z.mail.seedMessage(Z, {
        folder: "Inbox",
        from: "c@example.org",
        to: ["sarabi@example.test"],
        subject: `t${i}`,
        content: "x",
        threadId: String(7000 + i),
      });
    const a = await callTool(e, d, "u", "search_threads", { account: "sarabi", limit: 20 });
    expect(a.threads).toHaveLength(20);
    expect(a.next_page_token).toBeDefined();
    const b = await callTool(e, d, "u", "search_threads", {
      account: "sarabi",
      limit: 20,
      page_token: a.next_page_token,
    });
    expect(b.threads).toHaveLength(10);
    const ids = new Set([...a.threads, ...b.threads].map((t: { id: string }) => t.id));
    expect(ids.size).toBe(30);
  });
});

describe("I5: list calls ask Zoho for To details", () => {
  it("get_thread and list_drafts rows carry to", async () => {
    const { z, e, d, Z } = await zohoFixture();
    z.mail.seedMessage(Z, {
      folder: "Inbox",
      from: "c@example.org",
      to: ["sarabi@example.test"],
      subject: "a",
      content: "x",
      threadId: "950",
    });
    const t = await callTool(e, d, "u", "get_thread", {
      account: "sarabi",
      thread_id: "950",
      message_format: "METADATA_ONLY",
    });
    expect(t.thread.messages[0].to).toEqual(["sarabi@example.test"]);
    const views = z.mail.requests.map((r) => new URL(r.url)).filter((u) => u.pathname.endsWith("/messages/view"));
    expect(views.every((u) => u.searchParams.get("includeto") === "true")).toBe(true);
  });
});

describe("I7: a bare message id stays inside the budget and does not hide outages", () => {
  it("a message in Trash costs at most 9 requests", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const m = z.mail.seedMessage(Z, {
      folder: "Trash",
      from: "c@example.org",
      to: [],
      subject: "gone",
      content: "<p>x</p>",
    });
    const before = z.mail.requests.length;
    const r = await callTool(e, d, "u", "get_message", { account: "sarabi", message_id: m.messageId });
    expect(r.message.subject).toBe("gone");
    expect(z.mail.requests.length - before).toBeLessThanOrEqual(9);
  });
  it("a refusal other than not-found during the probe surfaces instead of handle_invalid", async () => {
    const { z, e, d, Z } = await zohoFixture();
    const m = z.mail.seedMessage(Z, { folder: "Sent", from: "s@example.test", to: [], subject: "s", content: "x" });
    z.mail.faults.push({ status: 403, errorCode: "ACCESS_DENIED", pathRe: /\/details$/ });
    await expect(
      callTool(e, d, "u", "get_message", { account: "sarabi", message_id: m.messageId }),
    ).rejects.toMatchObject({
      code: "zoho_error",
    });
  });
});

describe("I8: a custom folder cannot shadow a system folder", () => {
  it("prefers folderType over folderName", async () => {
    const { z, e, d, acct, Z } = await zohoFixture();
    const real = z.mail.folderId(Z, "Sent");
    const fake = z.mail.seedFolder(Z, "Sent");
    const list = z.mail.folders.get(Z)!;
    list.unshift(list.splice(list.indexOf(fake), 1)[0]!); // the custom one comes first
    expect((await systemFolders(e, d, acct)).sent).toBe(real);
  });
});
