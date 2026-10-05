export type SeedMessage = {
  folder: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  content: string;
  threadId?: string;
  attachments?: { name: string; bytes: Uint8Array; mime: string }[];
  messageIdHeader?: string;
};
export type Msg = {
  accountId: string;
  messageId: string;
  folderId: string;
  threadId: string;
  fromAddress: string;
  toAddress: string;
  ccAddress: string;
  subject: string;
  summary: string;
  content: string;
  receivedTime: number;
  sentDateInGMT: number;
  status: "read" | "unread";
  flagid: "info" | "important" | "followup" | "flag_not_set";
  labels: string[];
  archived: boolean;
  hasAttachment: 0 | 1;
  attachments: {
    attachmentId: string;
    attachmentName: string;
    attachmentSize: number;
    mime: string;
    bytes: Uint8Array;
  }[];
  messageIdHeader: string;
  inReplyTo?: string;
  references?: string;
  isDraft: boolean;
};
/** The fields the fake reads from a send, draft or reply body; every one is a string when present. */
type MailBody = {
  fromAddress?: string;
  toAddress?: string;
  ccAddress?: string;
  subject?: string;
  content?: string;
  inReplyTo?: string;
  mode?: string;
  action?: string;
  attachments?: { storeName: string }[];
} & Record<string, unknown>;
export type Fault = {
  status: number;
  errorCode?: string;
  shape?: "object" | "array";
  retryAfter?: number;
  pathRe?: RegExp;
};
const SYSTEM = ["Inbox", "Drafts", "Sent", "Spam", "Trash", "Archive"];

/** Enough Zoho Mail to exercise every tool. Shapes follow the official pages saved on 2026-10-03. */
export class FakeZohoMail {
  readonly messages = new Map<string, Msg>(); // key `${accountId}/${messageId}`
  readonly folders = new Map<
    string,
    { folderId: string; folderName: string; accountId: string; folderType: string }[]
  >();
  readonly labels = new Map<string, { labelId: string; displayName: string; color: string }[]>();
  readonly uploads = new Map<string, { bytes: Uint8Array; name: string; accountId: string; at: number }>();
  readonly sent: { accountId: string; body: Record<string, unknown>; messageId: string }[] = [];
  readonly requests: Request[] = [];
  readonly faults: Fault[] = [];
  uploadLifetimeMs = 24 * 3_600_000;
  /** Models a Zoho that answers folders/{f}/messages/{id}/... for a message stored in another folder. */
  detailsIgnoreFolder = false;
  private seq = 1000;
  private id() {
    return String(++this.seq);
  }
  ensureFolders(accountId: string) {
    if (!this.folders.has(accountId))
      this.folders.set(
        accountId,
        SYSTEM.map((n) => ({
          folderId: this.id(),
          folderName: n,
          accountId,
          folderType: n === "Archive" ? "Archive" : n,
        })),
      );
    return this.folders.get(accountId)!;
  }
  folderId(accountId: string, name: string) {
    const f = this.ensureFolders(accountId).find((x) => x.folderName === name);
    if (!f) throw new Error(`no folder ${name}`);
    return f.folderId;
  }
  seedFolder(accountId: string, name: string) {
    const f = { folderId: this.id(), folderName: name, accountId, folderType: "Custom" };
    this.ensureFolders(accountId).push(f);
    return f;
  }
  seedLabel(accountId: string, displayName: string, color = "#ff0000") {
    const l = { labelId: this.id(), displayName, color };
    this.labels.set(accountId, [...(this.labels.get(accountId) ?? []), l]);
    return l;
  }
  seedMessage(accountId: string, s: SeedMessage): Msg {
    const messageId = this.id();
    const m: Msg = {
      accountId,
      messageId,
      folderId: this.folderId(accountId, s.folder),
      threadId: s.threadId ?? messageId,
      fromAddress: s.from,
      toAddress: s.to.join(","),
      ccAddress: (s.cc ?? []).join(","),
      subject: s.subject,
      summary: s.content.replace(/<[^>]+>/g, "").slice(0, 80),
      content: s.content,
      receivedTime: Date.now(),
      sentDateInGMT: Date.now(),
      status: "unread",
      flagid: "flag_not_set",
      labels: [],
      archived: false,
      hasAttachment: s.attachments?.length ? 1 : 0,
      attachments: (s.attachments ?? []).map((a) => ({
        attachmentId: this.id(),
        attachmentName: a.name,
        attachmentSize: a.bytes.byteLength,
        mime: a.mime,
        bytes: a.bytes,
      })),
      messageIdHeader: s.messageIdHeader ?? `<${messageId}@fake.zoho>`,
      isDraft: s.folder === "Drafts",
    };
    this.messages.set(`${accountId}/${messageId}`, m);
    return m;
  }
  get(accountId: string, messageId: string) {
    return this.messages.get(`${accountId}/${messageId}`);
  }
  /**
   * Rows in Zoho's documented shapes (saved pages, 2026-10-03). The list page (messages/view, details) answers with
   * strings ("status": "1", "hasAttachment": "0", escaped addresses, "Not Provided" for an empty Cc); the search page
   * answers with numbers, a lower-case receivedtime, a numeric flagid and a URI carrying the exact ids. To details
   * come back only when includeto=true.
   */
  private listRow(m: Msg, shape: "view" | "search" = "view", includeTo = true) {
    const esc = (x: string) =>
      x.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const threadCount = [...this.messages.values()].filter(
      (x) => x.accountId === m.accountId && x.threadId === m.threadId,
    ).length;
    const flagNum = { flag_not_set: 0, info: 1, important: 2, followup: 3 }[m.flagid];
    if (shape === "search")
      return {
        URI: `https://mail.zoho.com.au/api/accounts/${m.accountId}/folders/${m.folderId}/messages/${m.messageId}`,
        messageId: Number(m.messageId),
        folderId: Number(m.folderId),
        threadId: m.threadId ? Number(m.threadId) : 0,
        threadCount,
        fromAddress: m.fromAddress,
        ...(includeTo ? { toAddress: esc(m.toAddress) } : {}),
        ccAddress: m.ccAddress ? esc(m.ccAddress) : "Not Provided",
        subject: m.subject,
        summary: esc(m.summary),
        receivedtime: m.receivedTime,
        sentDateInGMT: m.sentDateInGMT,
        status: m.status,
        flagid: flagNum,
        hasAttachment: m.hasAttachment,
        sender: m.fromAddress,
        size: m.content.length,
        status2: "none",
        priority: 3,
      };
    return {
      messageId: m.messageId,
      folderId: m.folderId,
      threadId: m.threadId,
      threadCount: String(threadCount),
      fromAddress: m.fromAddress,
      ...(includeTo ? { toAddress: esc(m.toAddress) } : {}),
      ccAddress: m.ccAddress ? esc(m.ccAddress) : "Not Provided",
      subject: m.subject,
      summary: esc(m.summary),
      receivedTime: String(m.receivedTime),
      sentDateInGMT: String(m.sentDateInGMT),
      status: m.status === "read" ? "1" : "0",
      flagid: m.flagid,
      hasAttachment: String(m.hasAttachment),
      sender: m.fromAddress,
      size: String(m.content.length),
      status2: "0",
      priority: "3",
    };
  }
  private err(status: number, errorCode: string, shape: "object" | "array" = "object") {
    return shape === "array"
      ? Response.json([2, { msg: "Error while processing!", errorCode, authFail: "true", status: String(status) }], {
          status,
        })
      : Response.json({ status: { code: status, description: errorCode }, data: { errorCode } }, { status });
  }
  async fetch(req: Request, accountId: string, path: string): Promise<Response> {
    this.requests.push(req);
    const fi = this.faults.findIndex((f) => !f.pathRe || f.pathRe.test(path));
    if (fi >= 0) {
      const f = this.faults.splice(fi, 1)[0]!;
      const r = this.err(f.status, f.errorCode ?? "ERROR", f.shape);
      if (f.retryAfter) r.headers.set("retry-after", String(f.retryAfter));
      return r;
    }
    const url = new URL(req.url);
    const mine = [...this.messages.values()].filter((m) => m.accountId === accountId);
    const includeTo = url.searchParams.get("includeto") === "true";
    const page = (rows: Msg[], shape: "view" | "search" = "view") => {
      const start = Number(url.searchParams.get("start") ?? "1"),
        limit = Math.min(200, Number(url.searchParams.get("limit") ?? "10"));
      if (limit < 1 || Number(url.searchParams.get("limit") ?? "10") > 200) return this.err(400, "INVALID_PARAMETER");
      return Response.json({
        status: { code: 200, description: "success" },
        data: rows.slice(start - 1, start - 1 + limit).map((m) => this.listRow(m, shape, includeTo)),
      });
    };
    if (req.method === "GET" && path === "/folders")
      return Response.json({
        status: { code: 200, description: "success" },
        data: this.ensureFolders(accountId).map(({ folderId, folderName, folderType }) => ({
          folderId,
          folderName,
          folderType,
          path: "/" + folderName,
        })),
      });
    if (req.method === "GET" && path === "/labels")
      return Response.json({ status: { code: 200, description: "success" }, data: this.labels.get(accountId) ?? [] });
    if (req.method === "POST" && path === "/labels") {
      const b = await req.json<{ labelName: string; color?: string }>();
      return Response.json({
        status: { code: 200, description: "success" },
        data: this.seedLabel(accountId, b.labelName, b.color),
      });
    }
    if (req.method === "GET" && path === "/messages/view") {
      let rows = mine.filter((m) => !m.isDraft || url.searchParams.get("folderId") === m.folderId);
      const tid = url.searchParams.get("threadId");
      if (tid) rows = rows.filter((m) => m.threadId === tid);
      const fid = url.searchParams.get("folderId");
      if (fid) rows = rows.filter((m) => m.folderId === fid);
      if (url.searchParams.get("includearchive") !== "true") rows = rows.filter((m) => !m.archived);
      return page(rows);
    }
    if (req.method === "GET" && path === "/messages/search") {
      const key = url.searchParams.get("searchKey") ?? "";
      let rows = mine.filter((m) => !m.isDraft);
      for (const term of key.split("::")) {
        const [k, ...rest] = term.split(":");
        const v = rest.join(":").replace(/^"|"$/g, "").toLowerCase();
        if (k === "sender") rows = rows.filter((m) => m.fromAddress.toLowerCase().includes(v));
        else if (k === "to") rows = rows.filter((m) => m.toAddress.toLowerCase().includes(v));
        else if (k === "subject") rows = rows.filter((m) => m.subject.toLowerCase().includes(v));
        else if (k === "entire") rows = rows.filter((m) => (m.subject + m.content).toLowerCase().includes(v));
        else if (k === "has" && v === "attachment") rows = rows.filter((m) => m.hasAttachment === 1);
        else if (k === "newMails") rows = rows.filter((m) => m.status === "unread");
        else if (k === "in") {
          const f = this.ensureFolders(accountId).find((x) => x.folderName.toLowerCase() === v);
          rows = rows.filter((m) => m.folderId === f?.folderId);
        }
      }
      return page(rows, "search");
    }
    const detail = /^\/folders\/(\d+)\/messages\/(\d+)\/(details|content|header|attachmentinfo)$/.exec(path);
    if (req.method === "GET" && detail) {
      const m = this.get(accountId, detail[2]!);
      if (!m || (m.folderId !== detail[1] && !this.detailsIgnoreFolder)) return this.err(404, "INVALID_MESSAGE");
      if (detail[3] === "details")
        return Response.json({ status: { code: 200, description: "success" }, data: this.listRow(m) });
      if (detail[3] === "content")
        return Response.json({
          status: { code: 200, description: "success" },
          data: { messageId: m.messageId, content: m.content },
        });
      if (detail[3] === "header")
        return Response.json({
          status: { code: 200, description: "success" },
          data: {
            headerContent: {
              "Message-ID": [m.messageIdHeader],
              ...(m.inReplyTo ? { "In-Reply-To": [m.inReplyTo] } : {}),
              ...(m.references ? { References: [m.references] } : {}),
              From: [m.fromAddress],
              To: [m.toAddress],
              ...(m.ccAddress ? { Cc: [m.ccAddress] } : {}),
            },
          },
        });
      return Response.json({
        status: { code: 200, description: "success" },
        data: {
          attachments: m.attachments.map(({ attachmentId, attachmentName, attachmentSize }) => ({
            attachmentId,
            attachmentName,
            attachmentSize,
          })),
        },
      });
    }
    const att = /^\/folders\/(\d+)\/messages\/(\d+)\/attachments\/(\d+)$/.exec(path);
    if (req.method === "GET" && att) {
      const a = this.get(accountId, att[2]!)?.attachments.find((x) => x.attachmentId === att[3]);
      return a
        ? new Response(a.bytes, { headers: { "content-type": a.mime, "content-length": String(a.bytes.byteLength) } })
        : this.err(404, "INVALID_ATTACHMENT");
    }
    const orig = /^\/messages\/(\d+)\/originalmessage$/.exec(path);
    if (req.method === "GET" && orig) {
      const m = this.get(accountId, orig[1]!);
      return m
        ? Response.json({
            status: { code: 200, description: "success" },
            data: { content: `Message-ID: ${m.messageIdHeader}\r\nSubject: ${m.subject}\r\n\r\n${m.content}` },
          })
        : this.err(404, "INVALID_MESSAGE");
    }
    if (req.method === "POST" && path === "/messages/attachments") {
      const bytes = new Uint8Array(await req.arrayBuffer());
      const name = url.searchParams.get("fileName") ?? "file";
      const storeName = `store-${this.id()}`;
      this.uploads.set(storeName, { bytes, name, accountId, at: Date.now() });
      return Response.json({
        status: { code: 200, description: "success" },
        data: {
          storeName,
          attachmentName: name,
          attachmentPath: `/path/${storeName}`,
          attachmentSize: bytes.byteLength,
        },
      });
    }
    if (req.method === "POST" && path === "/messages") {
      const b = await req.json<MailBody>();
      for (const a of (b.attachments as { storeName: string }[] | undefined) ?? []) {
        const u = this.uploads.get(a.storeName);
        if (!u || u.at + this.uploadLifetimeMs < Date.now()) return this.err(400, "INVALID_ATTACHMENT");
      }
      const folder = b.mode === "draft" ? "Drafts" : "Sent";
      const m = this.seedMessage(accountId, {
        folder,
        from: String(b.fromAddress),
        to: String(b.toAddress).split(","),
        cc: b.ccAddress ? String(b.ccAddress).split(",") : [],
        subject: String(b.subject ?? ""),
        content: String(b.content ?? ""),
      });
      if (b.inReplyTo) {
        m.inReplyTo = String(b.inReplyTo);
        const parent = mine.find((x) => x.messageIdHeader === b.inReplyTo);
        if (parent) m.threadId = parent.threadId;
      }
      if (folder === "Sent") this.sent.push({ accountId, body: b, messageId: m.messageId });
      return Response.json({
        status: { code: 200, description: "success" },
        data: { messageId: m.messageId, folderId: m.folderId },
      });
    }
    const reply = /^\/messages\/(\d+)$/.exec(path);
    if (req.method === "POST" && reply) {
      const parent = this.get(accountId, reply[1]!);
      if (!parent) return this.err(404, "INVALID_MESSAGE");
      const b = await req.json<MailBody>();
      if (b.action !== "Reply") return this.err(400, "INVALID_PARAMETER");
      const m = this.seedMessage(accountId, {
        folder: "Sent",
        from: String(b.fromAddress),
        to: String(b.toAddress).split(","),
        cc: b.ccAddress ? String(b.ccAddress).split(",") : [],
        subject: String(b.subject ?? parent.subject),
        content: String(b.content ?? ""),
        threadId: parent.threadId,
      });
      m.inReplyTo = parent.messageIdHeader;
      this.sent.push({ accountId, body: b, messageId: m.messageId });
      return Response.json({
        status: { code: 200, description: "success" },
        data: { messageId: m.messageId, folderId: m.folderId },
      });
    }
    if (req.method === "PUT" && (path === "/updatemessage" || path === "/updatethread")) {
      const b = await req.json<Record<string, unknown>>();
      const ids = (b.messageId as string[] | undefined) ?? [];
      const tids = (b.threadId as string[] | undefined) ?? [];
      const targets = mine.filter((m) => ids.includes(m.messageId) || tids.includes(m.threadId));
      const mode = String(b.mode);
      // The saved official pages answer every update with status only, no data (final review of M4, C1).
      const ok = () => Response.json({ status: { code: 200, description: "success" } });
      // Thread labels go to /updatethread; every other thread action is /updatemessage with threadId (saved pages).
      const labelMode = mode === "applyLabel" || mode === "removeLabel" || mode === "removeAllLabels";
      if (path === "/updatethread" && !labelMode) return this.err(400, "INVALID_METHOD");
      switch (mode) {
        case "markAsRead":
          targets.forEach((m) => (m.status = "read"));
          return ok();
        case "markAsUnread":
          targets.forEach((m) => (m.status = "unread"));
          return ok();
        case "moveMessage": {
          const dest = String(b.destfolderId);
          if (!this.ensureFolders(accountId).some((f) => f.folderId === dest)) return this.err(400, "INVALID_FOLDER");
          targets.forEach((m) => (m.folderId = dest));
          return ok();
        }
        case "setFlag": {
          const f = String(b.flagid);
          if (!["info", "important", "followup", "flag_not_set"].includes(f)) return this.err(400, "INVALID_PARAMETER");
          targets.forEach((m) => (m.flagid = f as Msg["flagid"]));
          return ok();
        }
        case "applyLabel":
          targets.forEach((m) => (m.labels = [...new Set([...m.labels, ...(b.labelId as string[])])]));
          return ok();
        case "removeLabel":
          targets.forEach((m) => (m.labels = m.labels.filter((l) => !(b.labelId as string[]).includes(l))));
          return ok();
        case "removeAllLabels":
          targets.forEach((m) => (m.labels = []));
          return ok();
        case "archiveMails":
          targets.forEach((m) => (m.archived = true));
          return ok();
        case "unArchiveMails":
          targets.forEach((m) => (m.archived = false));
          return ok();
        case "moveToSpam":
          targets.forEach((m) => (m.folderId = this.folderId(accountId, "Spam")));
          return ok();
        case "markNotSpam":
          targets.forEach((m) => (m.folderId = this.folderId(accountId, "Inbox")));
          return ok();
        default:
          return this.err(400, "INVALID_PARAMETER");
      }
    }
    const labelDelete = req.method === "DELETE" ? /^\/labels\/(\d+)$/.exec(path) : null;
    if (labelDelete) {
      // A label delete is allowed under ZohoMail.tags.ALL; it removes the label from every message.
      const id = labelDelete[1]!;
      const before = this.labels.get(accountId) ?? [];
      if (!before.some((l) => l.labelId === id)) return this.err(404, "LABEL_NOT_FOUND");
      this.labels.set(
        accountId,
        before.filter((l) => l.labelId !== id),
      );
      mine.forEach((m) => (m.labels = m.labels.filter((l) => l !== id)));
      return Response.json({ status: { code: 200, description: "success" } });
    }
    if (req.method === "DELETE") return this.err(401, "INVALID_OAUTHSCOPE", "array"); // the token never has messages.DELETE
    return this.err(404, "URL_RULE_NOT_CONFIGURED");
  }
}
