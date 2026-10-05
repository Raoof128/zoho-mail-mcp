-- One live account per slot per owner (spec section 3.3; carried from the M0 Task 0.2 ruling to M3 Task 3.6).
-- A revoked row may stay as history beside the live one; connect reuses the slot's row.
CREATE UNIQUE INDEX accounts_user_slot_live ON accounts(user_id, slot) WHERE status != 'revoked';
