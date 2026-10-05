import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseEnv, prodConfig, workerSecrets, generatedKeyLines, PROD } from "../../deploy/lib.ts";

const DB = "0b5e6f2a-1111-4222-8333-444455556666";
const KV = "0123456789abcdef0123456789abcdef";
const dev = readFileSync(new URL("../../../worker/wrangler.jsonc", import.meta.url), "utf8");

it("derives the production config from the dev config, keeping assets, DO, cron and adding the custom domain", () => {
  const c = prodConfig(dev, { dbId: DB, kvId: KV, buildId: "27b1eb4" }) as Record<string, any>;
  expect(c.name).toBe("zoho-mail-mcp");
  expect(c.vars).toEqual({
    WORKER_HOSTNAME: PROD.host,
    RECOVERY_PROFILE: "normal",
    RESTORE_GENERATION: PROD.restoreGeneration,
    BUILD_ID: "27b1eb4",
  });
  expect(c.d1_databases).toEqual([
    { binding: "DB", database_name: "zoho-mail-mcp", database_id: DB, migrations_dir: "migrations" },
  ]);
  expect(c.kv_namespaces).toEqual([{ binding: "OAUTH_KV", id: KV }]);
  expect(c.routes).toEqual([{ pattern: PROD.host, custom_domain: true }]);
  expect(c.assets).toEqual({ directory: "./public", binding: "ASSETS", run_worker_first: true });
  expect(c.durable_objects).toEqual({ bindings: [{ name: "ACCOUNT_DO", class_name: "AccountDO" }] });
  expect(c.triggers).toEqual({ crons: ["*/5 * * * *"] });
  expect(c.compatibility_flags).toContain("nodejs_compat");
  expect(() => prodConfig(dev, { dbId: "", kvId: KV, buildId: "27b1eb4" })).toThrow("database id");
  expect(() => prodConfig(dev, { dbId: DB, kvId: KV, buildId: "" })).toThrow("build id");
});
it("parses .env without evaluating it, and builds the Worker secrets from it", () => {
  const env = parseEnv(
    [
      "# comment",
      "ZOHO_MCP_CLIENT_ID=1000.ABC",
      "ZOHO_MCP_CLIENT_SECRET=s=ecret",
      "ZMC_TOKEN_KEK_K1=" + "A".repeat(43) + "=",
      "ZMC_STATE_HMAC_KEY=" + "B".repeat(43) + "=",
      "ZMC_CSRF_HMAC_KEY=" + "C".repeat(43) + "=",
      "ZMC_OWNER_ZOHO_SUBS=",
      "",
    ].join("\n"),
  );
  expect(env.ZOHO_MCP_CLIENT_SECRET).toBe("s=ecret");
  const s = workerSecrets(env);
  expect(Object.keys(s).sort()).toEqual(
    [
      "CSRF_HMAC_KEY",
      "ORG_DOMAINS",
      "OWNER_EMAILS",
      "OWNER_ZOHO_SUBS",
      "SLOTS",
      "STATE_HMAC_KEY",
      "TOKEN_KEKS",
      "TOKEN_KEK_CURRENT",
      "ZOHO_CLIENT_ID",
      "ZOHO_CLIENT_SECRET",
    ].sort(),
  );
  expect(JSON.parse(s.TOKEN_KEKS!)).toEqual({ k1: "A".repeat(43) + "=" });
  expect(s.TOKEN_KEK_CURRENT).toBe("k1");
  expect(s.OWNER_EMAILS).toBe("info@sarabisfinerugs.com.au");
  expect(s.OWNER_ZOHO_SUBS).toBe("");
  expect(JSON.parse(s.SLOTS!)).toEqual({ sarabi: "info@sarabisfinerugs.com.au", rcp: "info@rugcleaningpro.com.au" });
  expect(() => workerSecrets({ ...env, ZOHO_MCP_CLIENT_SECRET: "" })).toThrow("ZOHO_MCP_CLIENT_SECRET");
});
it("generates only the keys .env lacks, each 32 random bytes in base64", () => {
  const lines = generatedKeyLines({ ZMC_STATE_HMAC_KEY: "x" });
  expect(lines.map((l) => l.split("=")[0])).toEqual(["ZMC_TOKEN_KEK_K1", "ZMC_CSRF_HMAC_KEY"]);
  for (const l of lines) expect(Buffer.from(l.slice(l.indexOf("=") + 1), "base64")).toHaveLength(32);
  expect(generatedKeyLines({ ZMC_TOKEN_KEK_K1: "a", ZMC_STATE_HMAC_KEY: "b", ZMC_CSRF_HMAC_KEY: "c" })).toEqual([]);
});
