// Calls to Meta's WhatsApp Cloud API (Graph API): send text, show
// "read + typing", and download media. Used only by the real channel.

export interface WhatsAppCredentials {
  accessToken: string;
  phoneNumberId: string;
  apiVersion: string;
}

const GRAPH = 'https://graph.facebook.com';

export class WhatsAppClient {
  constructor(private readonly creds: WhatsAppCredentials) {}

  private async postMessage(body: Record<string, unknown>): Promise<void> {
    const response = await fetch(`${GRAPH}/${this.creds.apiVersion}/${this.creds.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.creds.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
    });
    if (!response.ok) {
      // Log Meta's error text (it contains no message content), then fail.
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`WhatsApp API ${response.status}: ${detail}`);
    }
  }

  async sendText(to: string, text: string): Promise<void> {
    await this.postMessage({
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: text },
    });
  }

  /** Marks the user's message as read (blue ticks) and shows "typing…" until a reply is sent. */
  async markReadAndTyping(messageId: string): Promise<void> {
    await this.postMessage({ status: 'read', message_id: messageId, typing_indicator: { type: 'text' } });
  }

  /**
   * Two steps: look up the media id to get a short-lived URL, then download
   * it with the access token. The URL expires within minutes, which is why
   * files are copied to R2 straight away.
   */
  async downloadMedia(
    mediaId: string,
    accept: (mimeType: string, sizeBytes: number) => boolean,
  ): Promise<{ bytes: ArrayBuffer | null; mimeType: string; sizeBytes: number }> {
    const headers = { authorization: `Bearer ${this.creds.accessToken}` };
    const lookup = await fetch(`${GRAPH}/${this.creds.apiVersion}/${encodeURIComponent(mediaId)}`, { headers });
    if (!lookup.ok) throw new Error(`WhatsApp media lookup failed: ${lookup.status}`);
    const info = (await lookup.json()) as { url?: string; mime_type?: string; file_size?: number | string };
    const mimeType = info.mime_type ?? 'application/octet-stream';
    const sizeBytes = Number(info.file_size ?? 0);
    if (!info.url) throw new Error('WhatsApp media lookup returned no URL');
    if (!accept(mimeType, sizeBytes)) return { bytes: null, mimeType, sizeBytes };

    const download = await fetch(info.url, { headers });
    if (!download.ok) throw new Error(`WhatsApp media download failed: ${download.status}`);
    const bytes = await download.arrayBuffer();
    return { bytes, mimeType, sizeBytes: bytes.byteLength };
  }
}
