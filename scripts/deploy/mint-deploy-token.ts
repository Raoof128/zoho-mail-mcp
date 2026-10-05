#!/usr/bin/env node
// Mints a scoped deploy token on the client's Cloudflare account from the recorded minting token.
// Prints the two .env lines ONCE to stdout (append them to .env); never logs the token elsewhere.
import { readEnvFile } from "./env-file.ts";

type Group = { id: string; name: string };
type Envelope<T> = { success: boolean; errors: unknown; result: T };
const env = readEnvFile();
const minter = env.CLOUDFLARE_API_TOKEN,
  account = env.CF_ACCOUNT_ID,
  zone = env.CF_ZONE_SARABISFINERUGS_COM_AU;
if (!minter || !account || !zone)
  throw new Error("missing CLOUDFLARE_API_TOKEN, CF_ACCOUNT_ID or CF_ZONE_SARABISFINERUGS_COM_AU");
async function cf<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { authorization: `Bearer ${minter}`, "content-type": "application/json" },
  });
  const j = (await r.json()) as Envelope<T>;
  if (!j.success) throw new Error(`Cloudflare ${path}: ${JSON.stringify(j.errors)}`);
  return j.result;
}
const groups = await cf<Group[]>("/user/tokens/permission_groups");
const id = (name: string) => {
  const g = groups.find((x) => x.name === name);
  if (!g) throw new Error(`permission group not found: ${name}`);
  return { id: g.id };
};
const made = await cf<{ id: string; value: string }>("/user/tokens", {
  method: "POST",
  body: JSON.stringify({
    name: `zoho-mail-mcp deploy ${new Date().toISOString().slice(0, 10)}`,
    policies: [
      {
        effect: "allow",
        resources: { [`com.cloudflare.api.account.${account}`]: "*" },
        permission_groups: [
          "Workers Scripts Write",
          "D1 Write",
          "Workers KV Storage Write",
          "Workers Tail Read",
          "Account Settings Read",
        ].map(id),
      },
      {
        effect: "allow",
        resources: { [`com.cloudflare.api.account.zone.${zone}`]: "*" },
        permission_groups: ["DNS Write", "Workers Routes Write", "Zone Read"].map(id),
      },
    ],
  }),
});
process.stdout.write(`ZOHO_MCP_CF_TOKEN=${made.value}\nZOHO_MCP_CF_TOKEN_ID=${made.id}\n`);
