-- The business address an inbound message was sent TO (for Twilio, e.g.
-- "whatsapp:+14155238886"). Replies go out from that same address, so they
-- land in the conversation the user opened. Replying from any other number
-- counts as the business starting a new conversation, which WhatsApp only
-- allows with a pre-approved template (Twilio error 21654).
ALTER TABLE messages ADD COLUMN received_on TEXT;
