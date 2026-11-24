// Telegram as a channel. Replies go to the private chat the message came
// from; the phone number is the user's ID inside the app, as on WhatsApp.

import { chatIdForPhone } from '../telegram-links';
import { TELEGRAM_MAX_TEXT_LENGTH, TelegramClient } from '../telegram-client';
import type { MessagingChannel, PendingMedia } from './types';

export class TelegramChannel implements MessagingChannel {
  readonly name = 'telegram' as const;
  readonly maxTextLength = TELEGRAM_MAX_TEXT_LENGTH;

  /** `chatId` is the chat the message being answered came from, when known. */
  constructor(
    private readonly client: TelegramClient,
    private readonly db: D1Database,
    private readonly chatId?: string | null,
  ) {}

  private async chatFor(phone: string): Promise<string> {
    const chat = this.chatId || (await chatIdForPhone(this.db, phone));
    if (!chat) throw new Error('No Telegram chat is linked to this phone number');
    return chat;
  }

  async sendText(to: string, text: string): Promise<void> {
    await this.client.sendText(await this.chatFor(to), text);
  }

  async markProcessing(to: string): Promise<void> {
    await this.client.sendTyping(await this.chatFor(to));
  }

  async downloadMedia(media: PendingMedia, accept: (mimeType: string, sizeBytes: number) => boolean) {
    if (media.source !== 'telegram') throw new Error(`Telegram channel cannot download ${media.source} media`);
    return this.client.downloadFile(media.fileId, media.mimeType, accept);
  }
}
