import { z } from "zod";
import { ACTIONS, MODIFIERS } from "./actions.ts";

export const AccountAlias = z.string().regex(/^[a-z0-9_-]{1,32}$/);
export const StagingHandle = z.string().regex(/^sh_[A-Za-z0-9_-]{43}$/);
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const StagingHandleResponse = z.object({
  handle: StagingHandle,
  account: AccountAlias,
  filename: z.string().min(1).max(255),
  mime: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: Sha256Hex,
  expires_at: z.iso.datetime(),
});
export type StagingHandleResponse = z.infer<typeof StagingHandleResponse>;

export const PendingApprovalResult = z.object({
  status: z.literal("pending_approval"),
  action_id: z.string().regex(/^pa_[A-Za-z0-9_-]{22}$/),
  action: z.enum(ACTIONS),
  modifiers: z.array(z.enum(MODIFIERS)),
  account: AccountAlias,
  summary: z.string(),
  approval: z.object({ mode: z.literal("url"), url: z.url() }),
  expires_at: z.iso.datetime(),
});
export type PendingApprovalResult = z.infer<typeof PendingApprovalResult>;

export const UploadIntent = z.object({
  account: AccountAlias,
  filename: z.string().min(1).max(255),
  size: z
    .number()
    .int()
    .positive()
    .max(25 * 1024 * 1024),
  mime: z.string().min(1),
  sha256: Sha256Hex,
  pending_id: z
    .string()
    .regex(/^pa_[A-Za-z0-9_-]{22}$/)
    .optional(),
});
export type UploadIntent = z.infer<typeof UploadIntent>;

export const MESSAGE_FORMATS = ["MINIMAL", "METADATA_ONLY", "PLAIN_TEXT", "FULL_CONTENT", "RAW"] as const;
export const MessageFormat = z.enum(MESSAGE_FORMATS);
export type MessageFormat = z.infer<typeof MessageFormat>;
/** Zoho message, thread, folder, label and account ids are decimal digits. */
export const ZohoId = z.string().regex(/^\d{1,32}$/);
export const ZohoFolderName = z.string().min(1).max(255);
/**
 * Interim: the id shape of tools still backed by the Gmail API. Every Zoho id also matches it. Each schema moves to
 * ZohoId when its tool is rewritten (M2 Task 2.4 read inputs, M3 compose and send, M4 labels and organise); M4 Task 4.2
 * deletes this.
 */
export const LegacyGmailId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);
export const LabelId = ZohoId;
export const LabelName = z.string().min(1).max(225);
export const LabelOption = z.enum(["TRASH", "SPAM"]);
export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const MessageTargetInput = z.object({ account: AccountAlias, message_id: ZohoId, folder_id: ZohoId.optional() });
export const ThreadTargetInput = z.object({ account: AccountAlias, thread_id: ZohoId });
const LabelIds = z.array(LabelId).min(1).max(100);
export const LabelMessageInput = MessageTargetInput.extend({ label_ids: LabelIds });
export const UnlabelMessageInput = LabelMessageInput;
export const LabelThreadInput = ThreadTargetInput.extend({ label_ids: LabelIds });
export const UnlabelThreadInput = LabelThreadInput;
/** Overlap and emptiness are checked by the tool; the schema stays a plain object so the gate can strip `account`. */
export const UpdateMessageLabelsInput = MessageTargetInput.extend({
  add_label_ids: z.array(LabelId).max(100).default([]),
  remove_label_ids: z.array(LabelId).max(100).default([]),
});
export const ApplySensitiveMessageLabelInput = MessageTargetInput.extend({ label_option: LabelOption });
export const ApplySensitiveThreadLabelInput = ThreadTargetInput.extend({ label_option: LabelOption });
export const FlagMessageInput = MessageTargetInput.extend({
  flag: z.enum(["info", "important", "followup", "flag_not_set"]),
});
export const MoveMessageInput = MessageTargetInput.extend({ folder: ZohoFolderName });
export const MoveThreadInput = ThreadTargetInput.extend({ folder: ZohoFolderName });
/** At least one id; checked by the tool (a refined schema cannot have `account` stripped). */
export const MarkReadInput = z.object({
  account: AccountAlias,
  message_ids: z.array(ZohoId).max(100).default([]),
  thread_ids: z.array(ZohoId).max(100).default([]),
});
export const CreateLabelInput = z.object({
  account: AccountAlias,
  display_name: LabelName,
  color: HexColor.optional(),
});
export const UpdateLabelInput = z.object({
  account: AccountAlias,
  label_id: LabelId,
  display_name: LabelName.optional(),
  color: HexColor.optional(),
});
export const DeleteLabelInput = z.object({ account: AccountAlias, label_id: LabelId });

export const MediaType = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/);
/** 1 MiB decoded is 1 398 104 base64 characters; the cap stops a larger string before any decoder sees it. */
export const INLINE_B64_MAX = 1_400_000;
export const InlineAttachment = z.object({
  filename: z.string().min(1).max(255),
  mime: MediaType,
  content_base64: z.string().min(1).max(INLINE_B64_MAX),
});
export type InlineAttachment = z.infer<typeof InlineAttachment>;
const FormatArg = z.union([MessageFormat, z.literal("MESSAGE_FORMAT_UNSPECIFIED")]).default("PLAIN_TEXT");
const PageLimit = z.number().int().min(1).max(50).default(20);
const PageToken = z.string().min(1).max(512).optional();
const BodyCharLimit = z.number().int().min(1).max(200_000).default(20_000);
export const SearchMessagesInput = z.object({
  account: AccountAlias.optional(),
  query: z.string().min(1).max(2048),
  folder: ZohoFolderName.optional(),
  start: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(200).default(20),
  include_to: z.boolean().default(false),
});
export const ListFoldersInput = z.object({ account: AccountAlias.optional() });
/** page_token is Zoho's 1-based `start`, as a string. */
export const SearchThreadsInput = z.object({
  account: AccountAlias.optional(),
  query: z.string().max(2048).optional(),
  limit: PageLimit,
  page_token: PageToken,
});
export const GetThreadInput = z.object({
  account: AccountAlias.optional(),
  thread_id: ZohoId,
  message_format: FormatArg,
  max_messages: z.number().int().min(1).max(200).default(25),
  /** next_cursor from a previous get_thread: bodies resume at this message. */
  cursor: ZohoId.optional(),
  include_body: z.boolean().default(true),
  body_char_limit: BodyCharLimit,
  total_body_char_limit: z.number().int().min(1).max(2_000_000).default(200_000),
});
export const GetMessageInput = z.object({
  account: AccountAlias.optional(),
  message_id: ZohoId,
  message_format: FormatArg,
  include_body: z.boolean().default(true),
  body_char_limit: BodyCharLimit,
});
export const ListDraftsInput = z.object({
  account: AccountAlias.optional(),
  limit: PageLimit,
  page_token: PageToken,
});
export const GetDraftInput = z.object({
  account: AccountAlias.optional(),
  draft_id: ZohoId,
  message_format: FormatArg,
  body_char_limit: BodyCharLimit,
});
export const ListLabelsInput = z.object({ account: AccountAlias.optional() });
const oneSource = (v: { attachment_id?: string | undefined; part_id?: string | undefined }) =>
  (v.attachment_id === undefined) !== (v.part_id === undefined);
const ONE_SOURCE = { message: "give attachment_id or part_id, not both" };
const DownloadAttachmentFields = {
  message_id: LegacyGmailId,
  attachment_id: z.string().min(1).max(1024).optional(),
  part_id: z.string().min(1).max(64).optional(),
};
export const DownloadAttachmentInput = z
  .object({ account: AccountAlias.optional(), ...DownloadAttachmentFields })
  .refine(oneSource, ONE_SOURCE);
/** The stored payload, which the gate strips of `account` before it journals. A refined object cannot
 * be `.omit()`ed, so the two schemas are built from one field set instead. */
export const DownloadAttachmentPayload = z.object(DownloadAttachmentFields).refine(oneSource, ONE_SOURCE);

export const Recipient = z.string().min(3).max(320);
// Coarse guard only: validateCompose owns the 500 cap and reports it as limit_exceeded.
export const Recipients = z.array(Recipient).max(2000).default([]);
const ComposeFields = {
  to: Recipients,
  cc: Recipients,
  bcc: Recipients,
  subject: z.string().max(4000).optional(),
  body: z.string().max(600_000).optional(),
  html_body: z.string().max(600_000).optional(),
  from: Recipient.optional(),
  attachments: z.array(StagingHandle).max(100).optional(),
  inline_attachments: z.array(InlineAttachment).max(50).optional(),
};
export const CreateDraftInput = z.object({
  account: AccountAlias,
  ...ComposeFields,
  reply_to_message_id: ZohoId.optional(),
  reply_to_folder_id: ZohoId.optional(),
});
export const UpdateDraftInput = z.object({
  account: AccountAlias,
  draft_id: ZohoId,
  ...ComposeFields,
  to: z.array(Recipient).max(2000).optional(),
  cc: z.array(Recipient).max(2000).optional(),
  bcc: z.array(Recipient).max(2000).optional(),
});
export const IdempotencyKey = z.string().min(1).max(128);
/** A file already in the mailbox. Zoho attachment ids are stable, so the reference survives an approval. */
export const CarriedAttachmentRef = z.strictObject({
  message_id: ZohoId,
  folder_id: ZohoId.optional(),
  attachment_id: ZohoId,
});
export const CarryFrom = z.array(CarriedAttachmentRef).max(20).default([]);

export const SendMessageInput = z.object({
  account: AccountAlias,
  ...ComposeFields,
  attach_from_message: CarryFrom,
  idempotency_key: IdempotencyKey.optional(),
});
export const ReplyInput = z
  .object({
    account: AccountAlias,
    message_id: ZohoId,
    folder_id: ZohoId.optional(),
    reply_all: z.boolean().default(false),
    ...ComposeFields,
    attach_from_message: CarryFrom,
    idempotency_key: IdempotencyKey.optional(),
  })
  .omit({ subject: true });
export const ForwardInput = z
  .object({
    account: AccountAlias,
    message_id: ZohoId,
    folder_id: ZohoId.optional(),
    forward_text: z.string().max(600_000).optional(),
    include_original_attachments: z.boolean().default(false),
    /** Pick individual files instead of all originals (at most 10). Ignored when include_original_attachments is true. */
    attach_from_message: CarryFrom,
    ...ComposeFields,
    idempotency_key: IdempotencyKey.optional(),
  })
  // html_body would replace the quoted original (final review of M3, I8); a forward's own text is forward_text.
  .omit({ subject: true, body: true, html_body: true });
export const SendDraftInput = z.object({
  account: AccountAlias,
  draft_id: ZohoId,
  idempotency_key: IdempotencyKey.optional(),
});
