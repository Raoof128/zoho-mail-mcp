import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

/** One object per Zoho account (spec D8). M1 adds the bucket, the refresh lock and the budgets. */
export class AccountDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }
  ping(): "pong" {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO state(key, value) VALUES ('pinged_at', ?)", String(Date.now()));
    return "pong";
  }
}
export function accountStub(env: Env, accountId: string): DurableObjectStub<AccountDO> {
  return env.ACCOUNT_DO.get(env.ACCOUNT_DO.idFromName(accountId));
}
