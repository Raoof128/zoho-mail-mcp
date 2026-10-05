import { z } from "zod";

/** What the executor expects Sent to show for an operation; stored in operations.settlement_context_json (spec 5.5). Task 3.5 adds the probe. */
export const ExpectedSend = z.object({
  from: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string(),
  startedAt: z.number(),
  attachmentCount: z.number(),
  attachmentNames: z.array(z.string()),
  bodySha256: z.string().nullable(),
});
export type ExpectedSend = z.infer<typeof ExpectedSend>;
