#!/usr/bin/env node
// Gate G14: MCP OAuth conformance of a deployed Worker, from the outside.
// Usage: node scripts/gates/g14-oauth.ts [https://mail-mcp.sarabisfinerugs.com.au] [--registration-open]
// --registration-open: the owner opened the registration window on /accounts first; then /register must
// answer 201 and an authorize with a foreign resource must be refused. Without it, /register must refuse.
// The client checks (codex mcp login, claude mcp add, one list_accounts each) are recorded by hand.
import { mkdirSync, writeFileSync } from "node:fs";

const base = (process.argv[2] ?? "https://mail-mcp.sarabisfinerugs.com.au").replace(/\/$/, "");
const open = process.argv.includes("--registration-open");
const results: { check: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail: string) => {
  results.push({ check: name, pass, detail });
  process.stdout.write(`${pass ? "PASS" : "FAIL"}  ${name}  ${detail}\n`);
};
const json = async (r: Response) => (await r.json().catch(() => ({}))) as Record<string, unknown>;

const prm = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
const prmBody = await json(prm);
check(
  "protected resource metadata names an authorization server",
  prm.ok && Array.isArray(prmBody.authorization_servers) && prmBody.authorization_servers.length > 0,
  `status ${prm.status}`,
);
const as = await fetch(`${base}/.well-known/oauth-authorization-server`);
const asBody = await json(as);
const methods = (asBody.code_challenge_methods_supported as string[] | undefined) ?? [];
check("PKCE S256 only", methods.includes("S256") && !methods.includes("plain"), JSON.stringify(methods));

const anon = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
const challenge = anon.headers.get("www-authenticate") ?? "";
check(
  "/mcp without a bearer is 401 with resource_metadata",
  anon.status === 401 && challenge.includes("resource_metadata="),
  `status ${anon.status}`,
);
await anon.body?.cancel();

const forged = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { authorization: "Bearer forged:grant:secret", "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
check("a forged bearer is 401", forged.status === 401, `status ${forged.status}`);
await forged.body?.cancel();

const reg = await fetch(`${base}/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: "g14 conformance probe",
    redirect_uris: ["http://127.0.0.1:9/callback"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  }),
});
const regBody = await json(reg);
if (open) {
  check("registration window open: /register is 201", reg.status === 201, `status ${reg.status}`);
  const clientId = typeof regBody.client_id === "string" ? regBody.client_id : "";
  const authorize = new URL(`${base}/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "http://127.0.0.1:9/callback",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    state: "g14",
    resource: "https://elsewhere.example/mcp",
  }).toString();
  const wrong = await fetch(authorize, { redirect: "manual" });
  const where = wrong.headers.get("location") ?? "";
  const text = where ? "" : await wrong.text();
  check(
    "authorize with a foreign resource is refused (invalid_target)",
    where.includes("invalid_target") || text.includes("invalid_target"),
    `status ${wrong.status}`,
  );
} else {
  check("registration window closed: /register refuses", reg.status !== 201, `status ${reg.status}`);
}

const pass = results.every((r) => r.pass);
mkdirSync(new URL("out/", import.meta.url), { recursive: true });
const file = new URL(`out/g14-${new Date().toISOString().slice(0, 10)}.json`, import.meta.url);
writeFileSync(
  file,
  JSON.stringify({ base, registrationOpen: open, pass, results, at: new Date().toISOString() }, null, 2) + "\n",
);
process.stdout.write(`${pass ? "G14 PASS" : "G14 FAIL"}; evidence ${file.pathname}\n`);
process.exitCode = pass ? 0 : 1;
