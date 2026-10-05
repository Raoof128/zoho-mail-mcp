import type { Env } from "../../env";
import { auditOutcome } from "../../audit/log";
import { getCompanionClientId, registerCompanionClient } from "../../auth/companion";
import {
  REGISTRATION_WINDOW_MS,
  closeRegistration,
  isRegistrationOpen,
  openRegistration,
} from "../../auth/registration";
import { auditIntent } from "../../audit/log";
import { revokeAccount } from "../../zoho/tokens";
import { slots, type Slot } from "../../env";
import { parseAddress, toAsciiDomain } from "../../policy/recipients";
import { csrfToken } from "../csrf";
import { escapeHtml, redirect } from "../html";
import { type Route, guardPost, page, readForm, requireRecent, requireSession } from "../router";
import { revokeOtherSessions, type Session } from "../session";

const MAX_SEND_LIMIT = 26_214_400;

type AccountRow = {
  id: string;
  alias: string;
  zoho_email: string;
  slot: Slot;
  status: string;
  is_default: number;
  send_limit_bytes: number;
};

/**
 * Stored exactly as isTrusted() will read it, through the same two functions. A pattern that these
 * reject is not a trust decision we could later honour, so it is refused here with the same error.
 */
function canonicalPattern(raw: string): string {
  const p = raw.trim();
  if (p.startsWith("@")) return `@${toAsciiDomain(p.slice(1))}`;
  return parseAddress(p).normalized;
}

async function render(env: Env, s: Session, notice?: string): Promise<Response> {
  const accounts = (
    await env.DB.prepare(
      "SELECT id, alias, slot, zoho_email, status, is_default, send_limit_bytes FROM accounts WHERE user_id = ? ORDER BY alias",
    )
      .bind(s.userId)
      .all<AccountRow>()
  ).results;
  const allow = (
    await env.DB.prepare("SELECT account_id, pattern FROM contact_allowlist WHERE user_id = ? ORDER BY pattern")
      .bind(s.userId)
      .all<{ account_id: string; pattern: string }>()
  ).results;
  const companion = await getCompanionClientId(env.DB);
  const controls = new Map<string, string>();
  for (const a of accounts) {
    const csrf = await csrfToken(env, s, "POST", "/accounts", a.id);
    const hidden = `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="account" value="${escapeHtml(a.id)}">`;
    const patterns = allow.filter((x) => x.account_id === a.id).map((x) => x.pattern);
    controls.set(
      a.id,
      `<div data-account="${escapeHtml(a.id)}">
<p class="muted">${escapeHtml(a.alias)} · ${escapeHtml(a.zoho_email)}${a.is_default ? " · default" : ""}</p>
<form method="post" action="/accounts" class="inline">${hidden}<button name="op" value="default"${a.is_default || a.status !== "active" ? " disabled" : ""}>Make default</button></form>
<form method="post" action="/accounts" class="inline">${hidden}<button name="op" value="revoke" class="deny"${a.status === "revoked" ? " disabled" : ""}>Revoke</button></form>
<h3>Trusted recipients</h3>
<ul>${patterns.map((p) => `<li>${escapeHtml(p)} <form method="post" action="/accounts" class="inline">${hidden}<input type="hidden" name="pattern" value="${escapeHtml(p)}"><button name="op" value="allowlist_remove">Remove</button></form></li>`).join("")}</ul>
<form method="post" action="/accounts">${hidden}<input name="pattern" placeholder="name@example.com or @example.com" required> <button name="op" value="allowlist_add">Add</button></form>
<h3>Limits</h3>
<form method="post" action="/accounts">${hidden}<label>Send limit (bytes) <input name="bytes" type="number" min="1" max="${MAX_SEND_LIMIT}" value="${a.send_limit_bytes}"></label> <button name="op" value="send_limit">Save</button></form>
</div>`,
    );
  }
  // Spec 2.1: two fixed slots, each bound to the address it must connect to.
  const configured = slots(env);
  const rows = (Object.keys(configured) as Slot[]).map((slot) => {
    const label = slot === "sarabi" ? "Sarabi's Fine Rugs" : "Rug Cleaning Pro";
    const bound = accounts.filter((x) => x.slot === slot);
    const status = bound.length ? bound.map((a) => escapeHtml(a.status)).join(", ") : "not connected";
    return `<section data-slot="${slot}"><h2>${label} <span class="muted">${escapeHtml(configured[slot])} · ${status}</span></h2>
<p>Sign in to Zoho as the user who owns <strong>${escapeHtml(configured[slot])}</strong>, then <a href="/connect?slot=${slot}">${bound.length ? "Reconnect" : "Connect"}</a>.</p>
${bound.map((a) => controls.get(a.id) ?? "").join("\n")}</section>`;
  });
  const companionCsrf = await csrfToken(env, s, "POST", "/accounts", "companion");
  const version = await companionVersion(env);
  const registrationCsrf = await csrfToken(env, s, "POST", "/accounts", "registration");
  const registrationOpen = await isRegistrationOpen(env.DB, Date.now());
  const body = `${notice ? `<p><strong>${escapeHtml(notice)}</strong></p>` : ""}
${rows.join("\n")}
<section data-account="setup">
<h2>Set up my Mac</h2>
${companion ? "" : "<p><strong>First register the companion client below.</strong></p>"}
<p>1. Open Terminal, paste this line and press Return. It installs the companion, makes the mail folders and connects Claude Code, Codex and Claude Desktop.</p>
<pre>curl -fsSL https://${escapeHtml(env.WORKER_HOSTNAME)}/install.sh | sh</pre>
<p>2. In Claude Desktop or claude.ai, open Settings, then Connectors, then Add custom connector, and paste:</p>
<pre>https://${escapeHtml(env.WORKER_HOSTNAME)}/mcp</pre>
<p>Files you want to send go in <code>Downloads/Mail/To Send</code>. Saved attachments arrive in <code>Downloads/Mail/Received</code>.</p>
<p class="muted">Companion version ${version ? escapeHtml(version) : "not published yet"}. Running the line again updates it.</p>
<p class="muted">One protection is lighter than a compiled helper would give: after saving a file, the companion re-checks the folder it saved into and refuses if that folder changed, rather than locking the folder during the save.</p>
</section>
<section data-account="companion">
<h2>Local companion</h2>
${
  companion
    ? `<p>Client id for <code>zoho-mail-mcp-companion login</code>:</p><pre>${escapeHtml(companion)}</pre>`
    : `<form method="post" action="/accounts"><input type="hidden" name="csrf" value="${escapeHtml(companionCsrf)}"><input type="hidden" name="account" value="companion"><button name="op" value="register_companion">Register the companion client</button></form>`
}
</section>
<section data-account="registration">
<h2>Client registration</h2>
<p>A Claude client enrols itself through this deployment's registration endpoint. It stays closed, so
nobody else can create a client that asks you to approve it. Open it only while you are adding a client.</p>
<form method="post" action="/accounts"><input type="hidden" name="csrf" value="${escapeHtml(registrationCsrf)}"><input type="hidden" name="account" value="registration">${
    registrationOpen
      ? `<p>Open for the next ${Math.ceil(REGISTRATION_WINDOW_MS / 60_000)} minutes or less.</p><button name="op" value="close_registration">Close it now</button>`
      : `<button name="op" value="open_registration">Open for ${Math.ceil(REGISTRATION_WINDOW_MS / 60_000)} minutes</button>`
  }</form>
</section>`;
  return page(env, s, "Accounts", body);
}

export const accountsRoutes: Route[] = [
  {
    method: "GET",
    pattern: /^\/accounts$/,
    handler: async ({ env, request }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      return render(env, s);
    },
  },
  {
    method: "POST",
    pattern: /^\/accounts$/,
    handler: async ({ env, deps, request }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      const form = await readForm(request);
      const objectId = form.get("account") ?? "";
      const refused = await guardPost(env, request, s, form, "/accounts", objectId);
      if (refused) return refused;
      const op = form.get("op") ?? "";
      const bad = (msg: string) => page(env, s, "Not saved", `<p>${escapeHtml(msg)}</p>`, 400);
      const auditTrust = (accountId: string | null) =>
        auditIntent(env.DB, {
          userId: s.userId,
          accountId,
          tool: "accounts_page",
          action: "policy.edit",
          modifiers: [],
          decision: "edited",
          facts: { ids: [op] },
        });

      if (op === "open_registration" || op === "close_registration") {
        if (objectId !== "registration") return bad("wrong object");
        // Same bar as a policy edit: opening registration widens who may ask the owner to approve.
        const recent = await requireRecent(env, s, request);
        if (recent) return recent;
        if (op === "open_registration") await openRegistration(env.DB, Date.now());
        else await closeRegistration(env.DB);
        await auditTrust(null);
        return redirect("/accounts");
      }

      if (op === "register_companion") {
        if (objectId !== "companion") return bad("wrong object");
        const recent = await requireRecent(env, s, request);
        if (recent) return recent;
        await registerCompanionClient(env, env.OAUTH_PROVIDER);
        await auditTrust(null);
        return redirect("/accounts");
      }

      // Ownership in the query, for every per-account op. A wrong id is a 403 rather than a 404 because
      // the CSRF token already bound the form to this account id; a mismatch here is a forged form.
      const acc = await env.DB.prepare("SELECT id, status, send_limit_bytes FROM accounts WHERE id = ? AND user_id = ?")
        .bind(objectId, s.userId)
        .first<{ id: string; status: string; send_limit_bytes: number }>();
      if (!acc) return page(env, s, "Refused", "<p>Not your account.</p>", 403);

      // Anything that widens what a send may do without asking is a trust decision: recent login, audited.
      const widens =
        op === "revoke" ||
        op === "allowlist_add" ||
        op === "allowlist_remove" ||
        (op === "send_limit" && Number(form.get("bytes")) > acc.send_limit_bytes);
      if (widens) {
        const recent = await requireRecent(env, s, request);
        if (recent) return recent;
      }

      switch (op) {
        case "default": {
          if (acc.status !== "active") return bad("only an active account can be the default");
          await env.DB.batch([
            env.DB.prepare("UPDATE accounts SET is_default = 0 WHERE user_id = ? AND is_default = 1").bind(s.userId),
            env.DB.prepare("UPDATE accounts SET is_default = 1 WHERE id = ? AND user_id = ?").bind(acc.id, s.userId),
          ]);
          return redirect("/accounts");
        }
        case "revoke": {
          await revokeAccount(env, deps, s.userId, acc.id);
          await revokeOtherSessions(env.DB, s.userId, s.idHash);
          await auditOutcome(env.DB, {
            userId: s.userId,
            accountId: acc.id,
            tool: "accounts_page",
            action: "account.connect",
            modifiers: [],
            decision: "revoked",
            facts: { ids: [acc.id] },
          });
          await auditTrust(acc.id);
          return redirect("/accounts");
        }
        case "allowlist_add": {
          let pattern: string;
          try {
            pattern = canonicalPattern(form.get("pattern") ?? "");
          } catch {
            return bad("a trusted recipient is an address or @domain");
          }
          await env.DB.prepare(
            "INSERT OR IGNORE INTO contact_allowlist (user_id, account_id, pattern) VALUES (?, ?, ?)",
          )
            .bind(s.userId, acc.id, pattern)
            .run();
          await auditTrust(acc.id);
          return redirect("/accounts");
        }
        case "allowlist_remove": {
          await env.DB.prepare("DELETE FROM contact_allowlist WHERE user_id = ? AND account_id = ? AND pattern = ?")
            .bind(s.userId, acc.id, form.get("pattern") ?? "")
            .run();
          await auditTrust(acc.id);
          return redirect("/accounts");
        }
        case "send_limit": {
          const bytes = Number(form.get("bytes"));
          if (!Number.isInteger(bytes) || bytes < 1 || bytes > MAX_SEND_LIMIT)
            return bad(`send limit must be 1..${MAX_SEND_LIMIT} bytes`);
          await env.DB.prepare("UPDATE accounts SET send_limit_bytes = ? WHERE id = ? AND user_id = ?")
            .bind(bytes, acc.id, s.userId)
            .run();
          if (widens) await auditTrust(acc.id);
          return redirect("/accounts");
        }
        default:
          return bad("unknown operation");
      }
    },
  },
];

/** The version the installer would fetch now, read from the Worker's own static assets (M6). */
async function companionVersion(env: Env): Promise<string | null> {
  try {
    const r = await env.ASSETS.fetch(new Request(`https://${env.WORKER_HOSTNAME}/companion.version`));
    if (!r.ok) {
      await r.body?.cancel();
      return null;
    }
    const v = (await r.text()).trim();
    return /^\d+\.\d+\.\d+$/.test(v) ? v : null;
  } catch {
    return null;
  }
}
