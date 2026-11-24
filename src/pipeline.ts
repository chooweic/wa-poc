// The shared pipeline behind both channels:
//
//   channel adapter -> ingestInbound() -> queue -> processJob() -> orchestrator -> channel.sendText()
//
// ingestInbound runs inside the HTTP request (fast: one DB write and one
// queue send). processJob runs in the queue consumer, where the slow work
// (media download, Claude, the target app) has time to finish.

import { AnthropicClaudeClient } from './claude/client';
import { createChannel } from './channels';
import { MAX_TEXT_LENGTH, splitText, type InboundMessage, type MessagingChannel, type PendingMedia } from './channels/types';
import {
  getConversation,
  getMessage,
  getOrCreateConversation,
  insertInbound,
  insertOutbound,
  setMessageEvidence,
  setMessageStatus,
  type Conversation,
  type MessageRow,
} from './conversations-repo';
import { getEvidence, setEvidenceMessage, type EvidenceRecord } from './drafts-repo';
import { getConfig, type Env, type QueueJob } from './env';
import { mediaRejection, storeEvidence } from './media';
import { handleTurn, type OrchestratorDeps, type TurnInput } from './orchestrator';
import { resolveSender } from './sender';
import { createTargetClient } from './target';
import { safeJsonParse } from './util';

export type IngestResult = 'queued' | 'duplicate' | 'not_allowed';

/** Stores an inbound message (dropping duplicates) and queues it for processing. */
export async function ingestInbound(env: Env, inbound: InboundMessage, origin: string): Promise<IngestResult> {
  const sender = resolveSender(getConfig(env), inbound.channel, inbound.from);
  if (!sender.allowed) {
    console.log(JSON.stringify({ evt: 'sender_rejected', channel: inbound.channel, reason: sender.reason }));
    return 'not_allowed';
  }
  const conversation = await getOrCreateConversation(env.DB, inbound.channel, sender.phoneNumber);
  const messageId = await insertInbound(env.DB, conversation.id, inbound);
  if (messageId === null) return 'duplicate';
  if (inbound.media?.source === 'stored') await setEvidenceMessage(env.DB, inbound.media.evidenceId, messageId);
  await env.INBOUND_QUEUE.send({ messageId, origin });
  return 'queued';
}

/**
 * Builds the orchestrator's input from what is stored. The same function is
 * used for every channel, so a simulator message and a real WhatsApp message
 * with the same content produce the same input.
 */
export async function buildTurnInput(
  db: D1Database,
  conversation: Conversation,
  message: MessageRow,
  baseUrl: string,
): Promise<TurnInput> {
  const evidence = message.evidence_id ? await getEvidence(db, message.evidence_id) : null;
  return { conversation, message, evidence, baseUrl };
}

export function createOrchestratorDeps(env: Env): OrchestratorDeps {
  const config = getConfig(env);
  return {
    db: env.DB,
    bucket: env.EVIDENCE,
    claude: env.ANTHROPIC_API_KEY
      ? new AnthropicClaudeClient(env.ANTHROPIC_API_KEY, config, env.ANTHROPIC_BASE_URL || undefined)
      : null,
    target: createTargetClient(env),
    config,
  };
}

/** Meta and Twilio: copy the file from the channel's servers into R2. Returns a rejection message when it is not acceptable. */
async function fetchPendingMedia(
  env: Env,
  channel: MessagingChannel,
  conversation: Conversation,
  message: MessageRow,
): Promise<{ evidence: EvidenceRecord } | { rejection: string }> {
  const ref = safeJsonParse<PendingMedia | null>(message.media_ref, null);
  if (!ref || !channel.downloadMedia) return { rejection: "Sorry, I couldn't open that file. Please send it again." };
  const maxBytes = getConfig(env).maxUploadBytes;
  const file = await channel.downloadMedia(ref, (mime, size) => !mediaRejection(mime, size || 1, maxBytes));
  const rejection = mediaRejection(file.mimeType, file.bytes ? file.bytes.byteLength : file.sizeBytes || 1, maxBytes);
  if (rejection || !file.bytes) return { rejection: rejection ?? "Sorry, I couldn't open that file. Please send it again." };
  const evidence = await storeEvidence(env.DB, env.EVIDENCE, {
    conversationId: conversation.id,
    messageId: message.id,
    bytes: file.bytes,
    mimeType: file.mimeType,
    filename: ref.filename,
  });
  await setMessageEvidence(env.DB, message.id, evidence.id);
  return { evidence };
}

/** Processes one queued message end to end. Called by the queue consumer. */
export async function processJob(env: Env, job: QueueJob, deps: OrchestratorDeps = createOrchestratorDeps(env)): Promise<void> {
  const message = await getMessage(env.DB, job.messageId);
  // Queues deliver "at least once": skip anything already handled.
  if (!message || message.status !== 'queued') return;
  const conversation = await getConversation(env.DB, message.conversation_id);
  if (!conversation) return;

  const channel = createChannel(env, conversation.channel);
  const send = async (text: string): Promise<void> => {
    for (const chunk of splitText(text, channel.maxTextLength ?? MAX_TEXT_LENGTH)) await channel.sendText(conversation.phone_number, chunk);
    await insertOutbound(env.DB, conversation.id, text);
  };

  try {
    if (channel.markProcessing && message.channel_message_id) {
      // "Read" + "typing…" is a nicety: never let it break the turn.
      await channel.markProcessing(conversation.phone_number, message.channel_message_id).catch(() => undefined);
    }

    if (message.media_ref && !message.evidence_id) {
      const fetched = await fetchPendingMedia(env, channel, conversation, message);
      if ('rejection' in fetched) {
        await send(fetched.rejection);
        await setMessageStatus(env.DB, message.id, 'done');
        return;
      }
      message.evidence_id = fetched.evidence.id;
      message.media_ref = null;
    }

    const input = await buildTurnInput(env.DB, conversation, message, job.origin ?? '');
    for (const reply of await handleTurn(deps, input)) await send(reply);
    await setMessageStatus(env.DB, message.id, 'done');
  } catch (error) {
    // Log the error message only: never message text or file contents.
    console.error('processJob failed:', (error as Error)?.message ?? error);
    await setMessageStatus(env.DB, message.id, 'failed');
    await send("Sorry, something went wrong on my side. Please try again in a few minutes.").catch(() => undefined);
  }
}
