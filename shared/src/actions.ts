export const ACTIONS = [
  "read.search",
  "read.message",
  "read.attachment",
  "draft.write",
  "send.message",
  "send.draft",
  "send.forward",
  "label.manage",
  "label.apply",
  "folder.move",
  "flag.set",
  "read.mark",
  "archive.set",
  "spam.mark",
  "spam.unmark",
  "trash.move",
  "trash.restore",
  "attachment.stage_upload",
  "fs.save",
  "account.read",
  "account.connect",
  "policy.read",
  "policy.edit",
] as const;
export type Action = (typeof ACTIONS)[number];

export const MODIFIERS = [
  "+attachment",
  "+external",
  "+bulk",
  "+sensitive",
  "+overwrite",
  "+destructive",
  "+outside_outbox",
] as const;
export type Modifier = (typeof MODIFIERS)[number];

export const LEVELS = ["allow", "ask", "deny"] as const;
export type Level = (typeof LEVELS)[number];

export const DEFAULT_POLICY: Record<Action, Level | "browser"> = {
  "read.search": "allow",
  "read.message": "allow",
  "read.attachment": "allow",
  "draft.write": "allow",
  "send.message": "allow",
  "send.draft": "allow",
  "send.forward": "ask",
  // ask until M4 Task 4.1 adds +destructive on delete_label (security review of M0 Task 0.4).
  "label.manage": "ask",
  "label.apply": "allow",
  "folder.move": "allow",
  "flag.set": "allow",
  "read.mark": "allow",
  "archive.set": "allow",
  "spam.mark": "ask",
  "spam.unmark": "allow",
  "trash.move": "ask",
  "trash.restore": "allow",
  // ask until M5 Task 5.3 adds +outside_outbox (security review of M0 Task 0.4).
  "attachment.stage_upload": "ask",
  "fs.save": "allow",
  "account.read": "allow",
  "account.connect": "ask",
  "policy.read": "allow",
  "policy.edit": "browser",
};

/** Modifiers only raise. allow -> ask; ask and deny unchanged. `decide` applies this to defaults only. */
export function raise(level: Level): Level {
  return level === "allow" ? "ask" : level;
}

/**
 * Documentation only, and deliberately not the rule the gate reads. Plan 3 finding B5 established that
 * an action cannot express journaling, because `label.manage` covers `create_label`, which opens an
 * operation, alongside `update_label` and `delete_label`, which do not. The gate reads `ToolSpec.journal`
 * per tool, and the seven tools that journal are the four sends, both drafts and `create_label`.
 * Nothing imports this set; it records the original spec 3.5 grouping and must not be mistaken for
 * enforcement.
 */
export const JOURNALED_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  "send.message",
  "send.draft",
  "send.forward",
  "draft.write",
  "label.manage",
]);
