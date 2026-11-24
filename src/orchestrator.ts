// Runs one conversation turn for one inbound message. Identical for the
// real WhatsApp channel and the /mock-wa simulator.
//
// Order of checks:
//   1. commands (/reset, /cancel)
//   2. the confirmation gate: the user's own "YES" on a draft that is
//      awaiting confirmation is the ONLY thing that submits a request
//   3. otherwise, a Claude turn with tools

import type { ClaudeClient, ClaudeContentBlockParam, ClaudeMessageParam } from './claude/client';
import { ClaudeError } from './claude/client';
import { buildSystemBlocks, buildTurnContext, historyToMessages } from './claude/prompt';
import { buildTools, executeTool, type ToolContext } from './claude/tools';
import { recentHistory, resetHistory, type Conversation, type MessageRow } from './conversations-repo';
import {
  getEvidence,
  getOpenDraft,
  listDraftEvidence,
  listRelevantEvidence,
  saveDraft,
  type Draft,
  type EvidenceRecord,
} from './drafts-repo';
import type { Config } from './env';
import { loadActiveKb, type ActiveKb } from './kb-repo';
import { loadEvidenceBase64, unsupportedMessageReply } from './media';
import { buildConfirmationSummary, buildSubmissionMessage } from './summary';
import type { TargetAppClient } from './target/client';
import { buildPayload } from './target/payload';
import { confirmationBlockers } from './validation';

/** What the orchestrator receives for a turn. Built the same way for every channel. */
export interface TurnInput {
  conversation: Conversation;
  /** The inbound message row being processed. */
  message: MessageRow;
  /** The file that came with this message, already stored in R2, if any. */
  evidence: EvidenceRecord | null;
  /** Public origin of the app, used for evidence links in the payload. */
  baseUrl: string;
}

export interface OrchestratorDeps {
  db: D1Database;
  bucket: R2Bucket;
  /** Null when ANTHROPIC_API_KEY is not configured. */
  claude: ClaudeClient | null;
  target: TargetAppClient;
  config: Config;
  now?: () => Date;
}

/** Safety cap on Claude round-trips per message (each round may run several tools). */
const MAX_ROUNDS = 10;

const NOT_CONFIGURED =
  "The assistant isn't set up yet: the Claude API key (ANTHROPIC_API_KEY) is missing. Please tell the administrator.";
const GENERIC_ERROR = "Sorry, I'm having trouble right now. Please try again in a few minutes.";

/** Returns the replies to send to the user, in order. */
export async function handleTurn(deps: OrchestratorDeps, input: TurnInput): Promise<string[]> {
  const { message, conversation } = input;
  // For unsupported messages the channel has already worked out the friendly reply.
  if (message.type === 'unsupported') return [message.text || unsupportedMessageReply()];

  if (message.type === 'text') {
    // "case-insensitive, trimmed": this is the user's own message, compared in code.
    const command = message.text.trim().toLowerCase();

    if (command === '/reset') {
      const draft = await getOpenDraft(deps.db, conversation.id);
      if (draft) await closeDraft(deps.db, draft, 'cancelled');
      await resetHistory(deps.db, conversation.id);
      return ["Okay, let's start fresh. Any request in progress has been cancelled. How can I help?"];
    }

    if (command === '/cancel') {
      const draft = await getOpenDraft(deps.db, conversation.id);
      if (!draft) return ["There's no request in progress to cancel."];
      await closeDraft(deps.db, draft, 'cancelled');
      return ['Your request has been cancelled. Nothing was submitted.'];
    }

    if (command === 'yes') {
      const draft = await getOpenDraft(deps.db, conversation.id);
      if (draft?.status === 'awaiting_confirmation') return submitDraft(deps, draft, input.baseUrl);
      // "yes" at any other time is just part of the chat and goes to Claude.
    }
  }

  return claudeTurn(deps, input);
}

async function closeDraft(db: D1Database, draft: Draft, status: 'cancelled' | 'failed'): Promise<void> {
  draft.status = status;
  await saveDraft(db, draft);
}

// ------------------------------------------------------------ submission

/**
 * Submits a draft to the target application. Reached only from the YES
 * check above; Claude has no way to call this.
 */
async function submitDraft(deps: OrchestratorDeps, draft: Draft, baseUrl: string): Promise<string[]> {
  const kb = await loadActiveKb(deps.db);
  const type = kb.types.find((t) => t.id === draft.transaction_type_id) ?? null;
  const reason = type?.reasons.find((r) => r.code === draft.reason_code) ?? null;
  const evidence = await listDraftEvidence(deps.db, draft.id);

  // Re-check the gate at the moment of submission: the KB may have changed
  // since the summary was sent (a reason deactivated, a limit lowered).
  const blockers = confirmationBlockers({ draft, type, reason, evidence });
  if (blockers.length || !type || !reason) {
    draft.status = 'collecting';
    draft.error = `Not submitted: ${blockers.join(' ')}`;
    await saveDraft(deps.db, draft);
    return [
      "I couldn't submit your request because something has changed since I sent the summary. Nothing was submitted. Send me a message and we'll sort it out.",
    ];
  }

  const payload = buildPayload({ draft, type, reason, evidence, baseUrl });
  const result = await deps.target.submit(payload);

  if (result.ok || (result.errorCode === 'duplicate_reference' && result.reference)) {
    draft.status = 'submitted';
    draft.target_reference = result.reference ?? null;
    draft.error = null;
  } else if (result.retryable) {
    // Stay in awaiting_confirmation: another YES retries with the same reference.
    draft.error = result.errorMessage ?? 'The target system could not be reached.';
  } else if (result.status === 422) {
    // The target app refused the content (dates, balance...). Reopen so the user can amend it.
    draft.status = 'collecting';
    draft.error = result.errorMessage ?? 'The target system rejected the request.';
  } else {
    draft.status = 'failed';
    draft.error = result.errorMessage ?? `The target system returned status ${result.status}.`;
  }
  await saveDraft(deps.db, draft);
  return [buildSubmissionMessage(result)];
}

// ----------------------------------------------------------- Claude turn

async function claudeTurn(deps: OrchestratorDeps, input: TurnInput): Promise<string[]> {
  if (!deps.claude) return [NOT_CONFIGURED];
  const { conversation, message } = input;
  const now = deps.now ? deps.now() : new Date();

  // Loaded fresh on every message, so KB edits take effect immediately.
  const kb = await loadActiveKb(deps.db);
  const draft = await getOpenDraft(deps.db, conversation.id);
  const history = await recentHistory(deps.db, conversation, message.id, deps.config.historyMessages);
  const evidence = await listRelevantEvidence(deps.db, conversation.id, draft?.id ?? null, conversation.history_reset_at);
  if (input.evidence && !evidence.some((e) => e.id === input.evidence?.id)) evidence.push(input.evidence);

  // Everything that varies per message goes here, AFTER the cached prefix.
  const userContent: ClaudeContentBlockParam[] = [
    {
      type: 'text',
      text: buildTurnContext({
        now,
        timeZone: deps.config.timezone,
        conversation,
        draft,
        kb,
        evidence,
        newEvidenceId: input.evidence?.id ?? null,
      }),
    },
  ];
  if (input.evidence) {
    // The file is sent to Claude only on the turn it arrives.
    const block = await evidenceBlock(deps.bucket, input.evidence);
    userContent.push(block ?? { type: 'text', text: '[The uploaded file could not be loaded. Ask the user to send it again.]' });
  }
  const text = message.text.trim();
  if (text) userContent.push({ type: 'text', text });
  else if (!input.evidence) userContent.push({ type: 'text', text: '(empty message)' });

  const messages: ClaudeMessageParam[] = [...historyToMessages(history), { role: 'user', content: userContent }];
  const system = buildSystemBlocks(kb);
  const tools = buildTools(deps.config.claudeStrictTools);
  const ctx: ToolContext = {
    db: deps.db,
    kb,
    conversation,
    newEvidenceIds: new Set(input.evidence ? [input.evidence.id] : []),
    confirmationRequested: false,
  };

  let reply = '';
  let nudged = false;
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const response = await deps.claude.create({ system, tools, messages });

      if (response.stop_reason === 'refusal') {
        reply = "Sorry, I can't help with that. I can help with leave applications and questions about company processes.";
        break;
      }

      const toolUses = response.content.filter((b) => b.type === 'tool_use');
      if (response.stop_reason === 'tool_use' && toolUses.length) {
        // Pass the assistant turn back unchanged (it includes thinking blocks), then all results in ONE user message.
        messages.push({ role: 'assistant', content: response.content as ClaudeContentBlockParam[] });
        const results: ClaudeContentBlockParam[] = [];
        for (const use of toolUses) {
          // Run in order: the tools change the same draft.
          const result = await executeTool(ctx, use.name, use.input);
          results.push({ type: 'tool_result', tool_use_id: use.id, content: result.content, is_error: result.isError });
        }
        messages.push({ role: 'user', content: results });
        continue;
      }

      if (response.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: response.content as ClaudeContentBlockParam[] });
        continue;
      }

      reply = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();

      // A new file must be recorded on the turn it arrives, because it is
      // never shown to Claude again. Ask once if that was skipped.
      if (input.evidence && !nudged && !(await getEvidence(deps.db, input.evidence.id))?.summary) {
        nudged = true;
        messages.push({ role: 'assistant', content: response.content as ClaudeContentBlockParam[] });
        messages.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text: `<app_context>\nThe file that arrived with this message (evidence_id ${input.evidence.id}) has not been recorded. Call attach_evidence for it now, then write your reply to the user again in full: your previous reply was not sent.\n</app_context>`,
            },
          ],
        });
        continue;
      }
      break;
    }
  } catch (error) {
    if (error instanceof ClaudeError) {
      console.error(error.message);
      return [error.userMessage];
    }
    throw error;
  }

  const replies: string[] = [];
  if (reply) replies.push(reply);

  // The BACKEND sends the confirmation summary, straight from the stored draft.
  if (ctx.confirmationRequested) {
    const summary = await confirmationSummaryFor(deps.db, kb, conversation.id);
    if (summary) replies.push(summary);
  }
  if (!replies.length) replies.push(GENERIC_ERROR);
  return replies;
}

async function confirmationSummaryFor(db: D1Database, kb: ActiveKb, conversationId: number): Promise<string | null> {
  const draft = await getOpenDraft(db, conversationId);
  if (draft?.status !== 'awaiting_confirmation') return null;
  const type = kb.types.find((t) => t.id === draft.transaction_type_id);
  const reason = type?.reasons.find((r) => r.code === draft.reason_code);
  if (!type || !reason) return null;
  return buildConfirmationSummary({ draft, type, reason, evidence: await listDraftEvidence(db, draft.id) });
}

async function evidenceBlock(bucket: R2Bucket, evidence: EvidenceRecord): Promise<ClaudeContentBlockParam | null> {
  const data = await loadEvidenceBase64(bucket, evidence);
  if (!data) return null;
  if (evidence.kind === 'document') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  return {
    type: 'image',
    source: { type: 'base64', media_type: evidence.mime_type as 'image/jpeg' | 'image/png', data },
  };
}
