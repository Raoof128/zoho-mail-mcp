import { ACTIONS } from "@zoho-mail-mcp/shared/actions";
import { AccountAlias } from "@zoho-mail-mcp/shared/schemas";
import { escapeHtml } from "../html";
import { auditOutcome } from "../../audit/log";
import { csrfToken } from "../csrf";
import { type Route, guardPost, page, readForm, requireSession } from "../router";

type Row = {
  ts: number;
  alias: string | null;
  tool: string | null;
  action: string | null;
  modifiers: string | null;
  phase: string;
  decision: string | null;
  pending_id: string | null;
  operation_id: string | null;
  summary: string | null;
};

/**
 * Spec 5.5: a send whose outcome is unknown is settled as sent only by positive evidence (the Sent probe). The owner,
 * who can check the recipient or the Sent folder, is the only one who can close it as not sent.
 */
async function unknownSection(
  env: Parameters<Route["handler"]>[0]["env"],
  s: { userId: string } & Parameters<typeof csrfToken>[1],
): Promise<string> {
  const ops = (
    await env.DB.prepare(
      `SELECT o.id, o.action, o.updated_at, a.alias FROM operations o LEFT JOIN accounts a ON a.id = o.account_id AND a.user_id = o.user_id
       WHERE o.user_id = ? AND o.state = 'delivery_unknown' ORDER BY o.updated_at DESC LIMIT 50`,
    )
      .bind(s.userId)
      .all<{ id: string; action: string; updated_at: number; alias: string | null }>()
  ).results;
  if (ops.length === 0) return "";
  const rows = await Promise.all(
    ops.map(async (o) => {
      const csrf = await csrfToken(env, s, "POST", "/audit/close", o.id);
      return `<tr><td>${escapeHtml(new Date(o.updated_at).toISOString())}</td><td>${escapeHtml(o.alias ?? "")}</td><td>${escapeHtml(o.action)}</td><td>${escapeHtml(o.id)}</td><td><form method="post" action="/audit/close"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="operation_id" value="${escapeHtml(o.id)}"><button>Close as not sent</button></form></td></tr>`;
    }),
  );
  return `<h2>Outcome unknown</h2><p>These sends may or may not have gone out. Check the recipient or the Sent folder in Zoho Mail first: closing one as not sent means it is treated as never sent.</p>
<table><tr><th>Since</th><th>Account</th><th>Action</th><th>Operation</th><th></th></tr>${rows.join("")}</table>`;
}

export const auditRoutes: Route[] = [
  {
    method: "GET",
    pattern: /^\/audit$/,
    handler: async ({ env, request, url }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      const alias = AccountAlias.safeParse(url.searchParams.get("account"));
      const action = url.searchParams.get("action");
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 90));
      const where = ["l.user_id = ?", "l.ts >= ?"];
      const binds: unknown[] = [s.userId, Date.now() - days * 86_400_000];
      if (alias.success) {
        where.push("a.alias = ?");
        binds.push(alias.data);
      }
      if (action && (ACTIONS as readonly string[]).includes(action)) {
        where.push("l.action = ?");
        binds.push(action);
      }
      const rows = (
        await env.DB.prepare(
          `SELECT l.ts, a.alias, l.tool, l.action, l.modifiers, l.phase, l.decision, l.pending_id, l.operation_id, l.summary
           FROM audit_log l LEFT JOIN accounts a ON a.id = l.account_id AND a.user_id = l.user_id
           WHERE ${where.join(" AND ")} ORDER BY l.id DESC LIMIT 200`,
        )
          .bind(...binds)
          .all<Row>()
      ).results;
      const cell = (v: string | number | null) => `<td>${v === null ? "" : escapeHtml(String(v))}</td>`;
      const body = `<form method="get" action="/audit" class="inline">
<label>Account <input name="account" value="${alias.success ? escapeHtml(alias.data) : ""}"></label>
<label>Action <select name="action"><option value="">any</option>${ACTIONS.map((a) => `<option${a === action ? " selected" : ""}>${a}</option>`).join("")}</select></label>
<label>Days <input name="days" type="number" min="1" max="90" value="${days}"></label>
<button>Filter</button></form>
<table><tr><th>Time</th><th>Account</th><th>Tool</th><th>Action</th><th>Modifiers</th><th>Phase</th><th>Decision</th><th>Pending</th><th>Operation</th><th>Summary</th></tr>
${rows.map((r) => `<tr>${cell(new Date(r.ts).toISOString())}${cell(r.alias)}${cell(r.tool)}${cell(r.action)}${cell(r.modifiers)}${cell(r.phase)}${cell(r.decision)}${cell(r.pending_id)}${cell(r.operation_id)}${cell(r.summary)}</tr>`).join("")}
</table>
<p class="muted">Metadata only, kept 90 days. Bodies, subjects and tokens are never stored here.</p>${await unknownSection(env, s)}`;
      return page(env, s, "Audit", body);
    },
  },
  {
    method: "POST",
    pattern: /^\/audit\/close$/,
    handler: async ({ env, request }) => {
      const s = await requireSession(env, request);
      if (s instanceof Response) return s;
      const form = await readForm(request);
      const opId = form.get("operation_id") ?? "";
      const refused = await guardPost(env, request, s, form, "/audit/close", opId);
      if (refused) return refused;
      const row = await env.DB.prepare(
        "SELECT account_id, action FROM operations WHERE id = ? AND user_id = ? AND state = 'delivery_unknown'",
      )
        .bind(opId, s.userId)
        .first<{ account_id: string; action: string }>();
      if (!row) return page(env, s, "Not closed", "<p>That operation is not waiting on an unknown outcome.</p>", 404);
      const res = await env.DB.prepare(
        "UPDATE operations SET state = 'failed_safe', updated_at = ? WHERE id = ? AND user_id = ? AND state = 'delivery_unknown'",
      )
        .bind(Date.now(), opId, s.userId)
        .run();
      if ((res.meta.changes ?? 0) === 1)
        await auditOutcome(env.DB, {
          userId: s.userId,
          accountId: row.account_id,
          tool: "audit_page",
          action: row.action,
          modifiers: [],
          decision: "closed_not_sent",
          operationId: opId,
          facts: { ids: [opId] },
        });
      return new Response(null, { status: 303, headers: { location: "/audit", "cache-control": "no-store" } });
    },
  },
];
