import { McpError } from "@zoho-mail-mcp/shared/errors";
import type { Deps } from "../deps";
import type { Env } from "../env";
import { accountStub } from "./account-do";
import type { ZohoAcct } from "./client";
import { listFolders, listMessages, type ZohoFolder, type ZohoListRow } from "./mail";

export type SystemFolders = {
  inbox: string;
  drafts: string;
  sent: string;
  trash: string;
  spam: string;
  archive: string | null;
};
const TTL = 10 * 60_000;
/** A system folder is matched on folderType first, so a custom folder named "Sent" cannot shadow the real one. */
const pick = (fs: ZohoFolder[], name: string) =>
  fs.find((f) => f.folderType?.toLowerCase() === name.toLowerCase()) ??
  fs.find((f) => f.folderName.toLowerCase() === name.toLowerCase());

export async function systemFolders(env: Env, deps: Deps, acct: ZohoAcct): Promise<SystemFolders> {
  const stub = accountStub(env, acct.accountId);
  const cached = await stub.getCache("folders");
  if (cached) return JSON.parse(cached) as SystemFolders;
  const fs = await listFolders(env, deps, acct);
  const need = (n: string) => {
    const f = pick(fs, n);
    if (!f) throw new McpError("zoho_error", `zoho_error: system folder ${n} not found`);
    return f.folderId;
  };
  const out: SystemFolders = {
    inbox: need("Inbox"),
    drafts: need("Drafts"),
    sent: need("Sent"),
    trash: need("Trash"),
    spam: need("Spam"),
    archive: pick(fs, "Archive")?.folderId ?? null,
  };
  await stub.setCache("folders", JSON.stringify(out), TTL);
  return out;
}
export async function folderByName(env: Env, deps: Deps, acct: ZohoAcct, name: string): Promise<ZohoFolder> {
  const f = pick(await listFolders(env, deps, acct), name);
  if (!f) throw new McpError("invalid_header", `invalid_header: no folder named ${name}`);
  return f;
}
/** One list call with the threadId filter; Zoho returns every folder's messages, each with its own folderId. */
export function threadMessages(
  env: Env,
  deps: Deps,
  acct: ZohoAcct,
  threadId: string,
  limit: number,
): Promise<ZohoListRow[]> {
  return listMessages(env, deps, acct, {
    threadId,
    limit: Math.min(200, limit),
    includesent: true,
    includearchive: true,
    includeto: true,
  });
}
