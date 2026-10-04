#!/usr/bin/env node
// Read-only where possible; the only writes are one draft (saved, then moved to Trash) and one
// 1-byte attachment upload (never sent). Prints Markdown to stdout and never prints a token.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
const env = Object.fromEntries(
  readFileSync(process.env.ENV_FILE ?? ".env", "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);
const need = (k) => {
  if (!env[k]) throw new Error(`missing ${k}`);
  return env[k];
};
const ACC = "https://accounts.zoho.com.au",
  MAIL = "https://mail.zoho.com.au/api";
const out = [];
const say = (s) => {
  out.push(s);
  process.stdout.write(s + "\n");
};
const tok = await (
  await fetch(`${ACC}/oauth/v2/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: need("ZOHO_PROBE_REFRESH_TOKEN"),
      client_id: need("ZOHO_MCP_CLIENT_ID"),
      client_secret: need("ZOHO_MCP_CLIENT_SECRET"),
    }),
  })
).json();
if (!tok.access_token) throw new Error("refresh failed: " + JSON.stringify({ ...tok, access_token: undefined }));
say(
  `# Zoho conformance probe ${new Date().toISOString()}\n\n- token scope echoed: \`${tok.scope}\`\n- api_domain: \`${tok.api_domain}\` (ignored, we route on location)`,
);
const H = { authorization: `Zoho-oauthtoken ${tok.access_token}`, accept: "application/json" };
const call = async (method, path, body, raw = false) => {
  const r = await fetch(`${MAIL}${path}`, {
    method,
    headers: body ? { ...H, "content-type": "application/json" } : H,
    body: body ? JSON.stringify(body) : undefined,
  });
  const rl = Object.fromEntries([...r.headers].filter(([k]) => /limit|rate|retry/i.test(k)));
  const text = await r.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    j = { raw: text.slice(0, 300) };
  }
  say(
    `\n### ${method} ${path}\nHTTP ${r.status}; rate headers: ${JSON.stringify(rl)}\n\`\`\`json\n${JSON.stringify(j, null, 1).slice(0, raw ? 4000 : 1200)}\n\`\`\``,
  );
  return { status: r.status, body: j, headers: r.headers };
};
const accounts = await call("GET", "/accounts");
const acc = accounts.body?.data?.[0]?.accountId;
if (!acc) throw new Error("no account");
const folders = await call("GET", `/accounts/${acc}/folders`);
const byName = Object.fromEntries((folders.body.data ?? []).map((f) => [f.folderName, f]));
say(
  `\nFolder names: ${Object.keys(byName).join(", ")}. Archive folder present: ${"Archive" in byName}. Field names on a folder: ${Object.keys(folders.body.data?.[0] ?? {}).join(", ")}`,
);
await call("GET", `/accounts/${acc}/labels`);
const list = await call("GET", `/accounts/${acc}/messages/view?limit=200`);
await call("GET", `/accounts/${acc}/messages/view?limit=201`);
const first = list.body?.data?.[0];
if (first) {
  say(`\nList row field names: ${Object.keys(first).join(", ")}`);
  await call("GET", `/accounts/${acc}/messages/view?threadId=${first.threadId}&limit=50`);
  await call("GET", `/accounts/${acc}/folders/${first.folderId}/messages/${first.messageId}/details`);
  await call("GET", `/accounts/${acc}/folders/${first.folderId}/messages/${first.messageId}/header`, undefined, true);
  await call("GET", `/accounts/${acc}/folders/${first.folderId}/messages/${first.messageId}/attachmentinfo`);
}
await call(
  "GET",
  `/accounts/${acc}/messages/search?searchKey=${encodeURIComponent('subject:"New Form Submission"')}&limit=2`,
);
await call(
  "GET",
  `/accounts/${acc}/messages/search?searchKey=${encodeURIComponent("has:attachment::sender:sarabisfinerugs")}&limit=2`,
);
// Write 1: a draft, then move it to Trash with moveMessage (no DELETE scope on this token).
const self = accounts.body.data[0].primaryEmailAddress;
const draft = await call("POST", `/accounts/${acc}/messages`, {
  mode: "draft",
  fromAddress: self,
  toAddress: self,
  subject: "zoho-mcp probe draft (safe to delete)",
  content: "probe",
  mailFormat: "plaintext",
});
const draftId = draft.body?.data?.messageId;
if (draftId) {
  const draftWithAtt = await call("POST", `/accounts/${acc}/messages`, {
    mode: "draft",
    fromAddress: self,
    toAddress: self,
    subject: "zoho-mcp probe draft with attachments field",
    content: "probe",
    attachments: [],
  });
  say(
    `\nDraft with an empty attachments field: HTTP ${draftWithAtt.status} (documents whether the field is accepted on a draft).`,
  );
  const moved = await call("PUT", `/accounts/${acc}/updatemessage`, {
    mode: "moveMessage",
    messageId: [draftId, draftWithAtt.body?.data?.messageId].filter(Boolean),
    destfolderId: byName.Trash?.folderId,
  });
  say(`\nDraft moved to Trash with moveMessage under messages.UPDATE: HTTP ${moved.status}.`);
}
// Write 2: a one-byte upload, never sent; re-check it after the interval to measure store lifetime.
const up = await fetch(`${MAIL}/accounts/${acc}/messages/attachments?fileName=probe.txt`, {
  method: "POST",
  headers: { ...H, "content-type": "application/octet-stream" },
  body: new Uint8Array([120]),
});
const upBody = await up.json();
say(
  `\n### POST /messages/attachments (1 byte)\nHTTP ${up.status}\n\`\`\`json\n${JSON.stringify(upBody, null, 1)}\n\`\`\`\nStore lifetime: re-run with \`PROBE_STORE=${JSON.stringify(upBody.data ?? {})}\` after 30, 60 and 120 minutes; a send attempt to self with that store either succeeds (store alive) or fails with the error that then goes into spec D16. The probe never sends.`,
);
// Delete scope must be absent: prove it.
await call("DELETE", `/accounts/${acc}/folders/${byName.Trash?.folderId}/messages/0?expunge=false`);
mkdirSync("scripts/probe/out", { recursive: true });
const file = `scripts/probe/out/${new Date().toISOString().slice(0, 10)}.md`;
writeFileSync(file, out.join("\n") + "\n");
process.stdout.write(`\nwritten ${file}\n`);
