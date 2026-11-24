// Calls to Twilio for WhatsApp: send text, show "read + typing", download media.
// Used only by the Twilio channel. Authentication is HTTP Basic with the
// account SID and auth token.

import { Buffer } from 'node:buffer';
import { normalizePhone } from './env';

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
  /** The WhatsApp sender, e.g. "whatsapp:+14155238886" (the sandbox number) or "+14155238886". */
  from: string;
}

/** "+65 9123 4567", "6591234567" or "whatsapp:+6591234567" -> "whatsapp:+6591234567". */
export function toWhatsAppAddress(number: string): string {
  return `whatsapp:+${normalizePhone(number)}`;
}

/** Twilio limits a message body to 1,600 characters. */
export const TWILIO_MAX_TEXT_LENGTH = 1600;

export class TwilioClient {
  constructor(private readonly creds: TwilioCredentials) {}

  private get authHeader(): string {
    return `Basic ${Buffer.from(`${this.creds.accountSid}:${this.creds.authToken}`).toString('base64')}`;
  }

  private async postForm(url: string, fields: Record<string, string>): Promise<void> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: this.authHeader, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
    if (!response.ok) {
      // Twilio's error text contains no message content.
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Twilio API ${response.status}: ${detail}`);
    }
  }

  async sendText(to: string, text: string): Promise<void> {
    await this.postForm(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.creds.accountSid)}/Messages.json`, {
      From: toWhatsAppAddress(this.creds.from),
      To: toWhatsAppAddress(to),
      Body: text,
    });
  }

  /**
   * Shows "typing…" for the incoming message (and marks it read). Twilio's
   * WhatsApp typing indicator is in public beta; it disappears after about
   * 25 seconds or when the reply arrives.
   */
  async markReadAndTyping(messageSid: string): Promise<void> {
    await this.postForm('https://messaging.twilio.com/v2/Indicators/Typing.json', { messageId: messageSid, channel: 'whatsapp' });
  }

  /**
   * Downloads a media file from the URL in the webhook. Twilio may redirect to
   * a storage URL; fetch follows that. The type is checked before downloading,
   * the size after (the webhook does not give it).
   */
  async downloadMedia(
    url: string,
    declaredMimeType: string,
    accept: (mimeType: string, sizeBytes: number) => boolean,
  ): Promise<{ bytes: ArrayBuffer | null; mimeType: string; sizeBytes: number }> {
    if (!/^https:\/\/([a-z0-9-]+\.)*twilio\.com\//i.test(url)) throw new Error('Twilio media URL is not on twilio.com');
    if (!accept(declaredMimeType, 0)) return { bytes: null, mimeType: declaredMimeType, sizeBytes: 0 };
    const response = await fetch(url, { headers: { authorization: this.authHeader } });
    if (!response.ok) throw new Error(`Twilio media download failed: ${response.status}`);
    const bytes = await response.arrayBuffer();
    const mimeType = response.headers.get('content-type') || declaredMimeType;
    return { bytes, mimeType, sizeBytes: bytes.byteLength };
  }
}
