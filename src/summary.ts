// Messages written by the BACKEND (not by Claude): the confirmation summary
// the user must answer YES to, and the result of a submission.

import type { Draft, EvidenceRecord } from './drafts-repo';
import type { KbReason, KbTransactionType } from './kb-repo';
import type { SubmitResult } from './target/client';
import { effectiveFields } from './validation';

const STEP_ICON: Record<string, string> = { done: '✅', not_applicable: '➖', not_done: '❌', unknown: '❔' };

function prettyValue(value: unknown, isDate: boolean): string {
  if (isDate && typeof value === 'string') {
    const d = new Date(`${value}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) {
      const weekday = d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
      return `${value} (${weekday})`;
    }
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** The structured summary sent when a draft moves to `awaiting_confirmation`. */
export function buildConfirmationSummary(args: {
  draft: Draft;
  type: KbTransactionType;
  reason: KbReason;
  evidence: EvidenceRecord[];
}): string {
  const { draft, type, reason, evidence } = args;
  const lines: string[] = ['*Please check your request*', '', `*${type.name}*: ${reason.label}`];
  if (draft.user_wording) lines.push(`Your reason: "${draft.user_wording}"`);

  lines.push('');
  for (const spec of effectiveFields(type, reason)) {
    const entry = draft.fields[spec.name];
    if (entry?.status === 'confirmed') {
      lines.push(`• ${spec.title}: ${prettyValue(entry.value, spec.schema.format === 'date')}`);
    }
  }

  lines.push('', '*Checklist*');
  for (const step of draft.steps) {
    const note = step.note ? ` (${step.status === 'not_applicable' ? 'not applicable: ' : ''}${step.note})` : '';
    lines.push(`${STEP_ICON[step.status] ?? '•'} ${step.text}${note}`);
  }

  lines.push('', '*Evidence*');
  if (evidence.length) {
    for (const ev of evidence) {
      lines.push(`📎 ${ev.kind === 'image' ? 'Photo' : 'PDF'}${ev.summary ? `: ${ev.summary}` : ''}`);
    }
  } else {
    lines.push('None');
  }

  lines.push('', 'Reply *YES* to submit, or tell me what to change.');
  return lines.join('\n');
}

/** Plain-language message for the user after a submission attempt. */
export function buildSubmissionMessage(result: SubmitResult): string {
  if (result.ok) {
    const status =
      result.recordStatus === 'pending_review'
        ? 'It is now *pending review* and will be checked by a person before it is approved.'
        : result.recordStatus
          ? `Status: *${result.recordStatus.replace(/_/g, ' ')}*.`
          : '';
    return `✅ Submitted. Your reference number is *${result.reference ?? 'not provided'}*.${status ? `\n${status}` : ''}`;
  }
  switch (result.errorCode) {
    case 'duplicate_reference':
      return `This request was already submitted${result.reference ? `. Your reference number is *${result.reference}*` : ''}.`;
    case 'user_not_found':
      return "I couldn't submit this: your phone number isn't registered in the system. Please ask your administrator to add it, then start a new request.";
    case 'insufficient_balance':
      return `I couldn't submit this. ${result.errorMessage} Tell me if you'd like to change the request, or speak to your supervisor.`;
    case 'invalid_dates':
    case 'invalid_days':
      return `I couldn't submit this because the system didn't accept the dates or number of days (${result.errorMessage}). Let's correct them and try again.`;
    default:
      if (result.retryable) {
        return "I couldn't reach the system just now, so nothing was submitted. Reply *YES* to try again.";
      }
      return `I couldn't submit this. The system said: ${result.errorMessage ?? 'the request was not accepted'}. Please check with your supervisor, then start a new request.`;
  }
}
