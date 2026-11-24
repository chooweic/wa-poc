// "Who is the sender, and may they use the assistant?" is decided here and
// nowhere else.
//
// In the prototype the WhatsApp phone number IS the user's ID, and the only
// check is a simple allowlist for the real channel. The planned
// authorisation step (map the number to an identity in the target system,
// check which transactions they may start, log every decision) replaces the
// body of this one function.

import { normalizePhone, type Config } from './env';
import type { ChannelName } from './channels/types';

export interface SenderDecision {
  allowed: boolean;
  /** Normalised phone number: international format, digits only. */
  phoneNumber: string;
  reason?: string;
}

export function resolveSender(config: Config, channel: ChannelName, rawFrom: string): SenderDecision {
  const phoneNumber = normalizePhone(rawFrom);
  if (phoneNumber.length < 6 || phoneNumber.length > 15) {
    return { allowed: false, phoneNumber, reason: 'invalid_number' };
  }
  // The simulator sits behind admin login, so any number may be used there
  // (including unknown ones, to test how the target app rejects them).
  if (channel === 'mock') return { allowed: true, phoneNumber };
  // ALLOWED_WHATSAPP_NUMBERS applies to the real WhatsApp channels (Meta and Twilio).
  if (config.allowedNumbers.has(phoneNumber)) return { allowed: true, phoneNumber };
  return { allowed: false, phoneNumber, reason: 'not_in_allowlist' };
}
