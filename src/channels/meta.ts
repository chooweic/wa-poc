// The real WhatsApp channel (Meta WhatsApp Cloud API).

import { WhatsAppClient } from '../whatsapp-client';
import type { MessagingChannel } from './types';

export class MetaWhatsAppChannel implements MessagingChannel {
  readonly name = 'meta' as const;

  constructor(private readonly client: WhatsAppClient) {}

  sendText(to: string, text: string): Promise<void> {
    return this.client.sendText(to, text);
  }

  markProcessing(_to: string, channelMessageId: string): Promise<void> {
    return this.client.markReadAndTyping(channelMessageId);
  }

  downloadMedia(mediaId: string, accept: (mimeType: string, sizeBytes: number) => boolean) {
    return this.client.downloadMedia(mediaId, accept);
  }
}
