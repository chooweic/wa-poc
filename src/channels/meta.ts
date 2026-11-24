// The real WhatsApp channel (Meta WhatsApp Cloud API).

import { WhatsAppClient } from '../whatsapp-client';
import type { MessagingChannel, PendingMedia } from './types';

export class MetaWhatsAppChannel implements MessagingChannel {
  readonly name = 'meta' as const;

  constructor(private readonly client: WhatsAppClient) {}

  sendText(to: string, text: string): Promise<void> {
    return this.client.sendText(to, text);
  }

  markProcessing(_to: string, channelMessageId: string): Promise<void> {
    return this.client.markReadAndTyping(channelMessageId);
  }

  async downloadMedia(media: PendingMedia, accept: (mimeType: string, sizeBytes: number) => boolean) {
    if (media.source !== 'meta') throw new Error(`Meta channel cannot download ${media.source} media`);
    return this.client.downloadMedia(media.mediaId, accept);
  }
}
