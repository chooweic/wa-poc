// The channel boundary. Everything on the far side of this interface
// (queue, orchestrator, Claude, drafts, confirm gate, target app) is identical
// for every channel: Meta's WhatsApp Cloud API, WhatsApp through Twilio,
// and the /mock-wa simulator.

export type ChannelName = 'meta' | 'twilio' | 'mock';

/** Media that arrived with a message. */
export type InboundMedia =
  /** Already stored in R2 (the simulator uploads straight to R2). */
  | { source: 'stored'; evidenceId: string }
  | PendingMedia;

/** Media still on the channel's servers; the queue consumer downloads it into R2. */
export type PendingMedia =
  /** Meta: look the id up to get a short-lived URL, then download. */
  | { source: 'meta'; mediaId: string; mimeType: string; filename?: string }
  /** Twilio: download the URL from the webhook with the account credentials. */
  | { source: 'twilio'; url: string; mimeType: string; filename?: string };

/** A message from a user, in a channel-neutral shape. */
export interface InboundMessage {
  channel: ChannelName;
  /** The channel's own message id, used to drop duplicate deliveries. */
  channelMessageId: string;
  /** Sender's phone number: international format, digits only. This is the user's ID. */
  from: string;
  type: 'text' | 'image' | 'document' | 'unsupported';
  /**
   * Message body, or the caption of an image/document ('' when there is none).
   * For `unsupported` it holds the friendly reply to send back instead.
   */
  text: string;
  media?: InboundMedia;
}

export interface MessagingChannel {
  readonly name: ChannelName;
  /** The longest text one message may carry on this channel (default MAX_TEXT_LENGTH). */
  readonly maxTextLength?: number;
  /** Sends one text message (already split to the channel's size limit). */
  sendText(to: string, text: string): Promise<void>;
  /** Shows "read" / "typing…" for the message being processed, where the channel supports it. */
  markProcessing?(to: string, channelMessageId: string): Promise<void>;
  /**
   * Downloads media that is not yet in R2 (only the Meta channel needs this).
   * `bytes` is null when the file was not downloaded because its type or
   * size is not acceptable; `mimeType` and `sizeBytes` are still reported.
   */
  downloadMedia?(
    media: PendingMedia,
    accept: (mimeType: string, sizeBytes: number) => boolean,
  ): Promise<{ bytes: ArrayBuffer | null; mimeType: string; sizeBytes: number }>;
}

/** Meta's WhatsApp API rejects text bodies longer than this. */
export const MAX_TEXT_LENGTH = 4096;

/**
 * Splits a long reply into chunks of at most `limit` characters, preferring
 * to break at a blank line, then a line break, then a space.
 */
export function splitText(text: string, limit = MAX_TEXT_LENGTH): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf('\n\n');
    if (cut < limit * 0.5) cut = window.lastIndexOf('\n');
    if (cut < limit * 0.5) cut = window.lastIndexOf(' ');
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
