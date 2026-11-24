// WhatsApp through Twilio: an alternative to calling Meta's WhatsApp Cloud API
// directly. It sits alongside the Meta channel; both can be on at once.

import { TWILIO_MAX_TEXT_LENGTH, TwilioClient } from '../twilio-client';
import type { MessagingChannel, PendingMedia } from './types';

export class TwilioWhatsAppChannel implements MessagingChannel {
  readonly name = 'twilio' as const;
  readonly maxTextLength = TWILIO_MAX_TEXT_LENGTH;

  constructor(private readonly client: TwilioClient) {}

  sendText(to: string, text: string): Promise<void> {
    return this.client.sendText(to, text);
  }

  markProcessing(_to: string, channelMessageId: string): Promise<void> {
    return this.client.markReadAndTyping(channelMessageId);
  }

  async downloadMedia(media: PendingMedia, accept: (mimeType: string, sizeBytes: number) => boolean) {
    if (media.source !== 'twilio') throw new Error(`Twilio channel cannot download ${media.source} media`);
    return this.client.downloadMedia(media.url, media.mimeType, accept);
  }
}
