# Zoho conformance probe (Task 0 of the plan)

Run once with a READ-scoped token for the Sarabi mailbox before any tool code is trusted, and again
after the Zoho org move. It makes two writes: a draft (moved to Trash) and a one-byte upload (never sent).

    ENV_FILE=../Haji/.env node scripts/probe/zoho-probe.mjs

Then paste the sections of `scripts/probe/out/<date>.md` into the spec, section 4, with the date,
and update: search syntax, list and header field names, Archive folder presence, draft attachments
field acceptance, moveMessage on a draft, upload store lifetime, rate-limit headers, the DELETE refusal.
