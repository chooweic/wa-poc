// Calls to the Telegram Bot API: send text, "typing…", download files, and
// the one-off webhook setup. Used only by the Telegram channel.

const API = 'https://api.telegram.org';

/** Telegram rejects message texts longer than this. */
export const TELEGRAM_MAX_TEXT_LENGTH = 4096;
/** Bots can download files up to this size. */
export const TELEGRAM_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly description: string,
  ) {
    super(`Telegram ${method} ${status}: ${description}`);
  }
}

/**
 * The agent writes WhatsApp-style formatting (*bold*, _italic_). Telegram
 * shows those characters literally, so convert to Telegram's HTML mode,
 * escaping everything else.
 */
export function toTelegramHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?])/g, '$1<i>$2</i>');
}

export class TelegramClient {
  constructor(private readonly token: string) {}

  /** Calls a Bot API method and returns its `result`. Errors never include the token. */
  async call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${API}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    const body = (await response.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null;
    if (!response.ok || !body?.ok) {
      throw new TelegramApiError(method, response.status, (body?.description ?? 'request failed').slice(0, 300));
    }
    return body.result as T;
  }

  /** Sends text with the agent's formatting converted; falls back to plain text if Telegram rejects the formatting. */
  async sendText(chatId: string, text: string, extra: Record<string, unknown> = {}): Promise<void> {
    try {
      await this.call('sendMessage', { chat_id: chatId, text: toTelegramHtml(text), parse_mode: 'HTML', ...extra });
    } catch (error) {
      if (!(error instanceof TelegramApiError) || error.status !== 400 || !/parse|entit/i.test(error.description)) throw error;
      await this.call('sendMessage', { chat_id: chatId, text, ...extra });
    }
  }

  /** Shows "typing…" for about 5 seconds, or until the next message arrives. */
  async sendTyping(chatId: string): Promise<void> {
    await this.call('sendChatAction', { chat_id: chatId, action: 'typing' });
  }

  /** Two steps: getFile gives a path and size, then the file is downloaded from the file endpoint. */
  async downloadFile(
    fileId: string,
    mimeType: string,
    accept: (mimeType: string, sizeBytes: number) => boolean,
  ): Promise<{ bytes: ArrayBuffer | null; mimeType: string; sizeBytes: number }> {
    const file = await this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId });
    const size = file.file_size ?? 0;
    if (!accept(mimeType, size) || size > TELEGRAM_MAX_DOWNLOAD_BYTES || !file.file_path) {
      return { bytes: null, mimeType, sizeBytes: size };
    }
    const response = await fetch(`${API}/file/bot${this.token}/${file.file_path}`);
    if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
    const bytes = await response.arrayBuffer();
    return { bytes, mimeType, sizeBytes: bytes.byteLength };
  }
}
