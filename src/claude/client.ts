// Thin wrapper around the official Anthropic SDK. The orchestrator talks to
// the `ClaudeClient` interface so tests can swap in a scripted fake.

import Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../env';

export type ClaudeMessage = Anthropic.Beta.BetaMessage;
export type ClaudeMessageParam = Anthropic.Beta.BetaMessageParam;
export type ClaudeContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
export type ClaudeTool = Anthropic.Beta.BetaTool;
export type ClaudeSystemBlock = Anthropic.Beta.BetaTextBlockParam;

export interface ClaudeRequest {
  system: ClaudeSystemBlock[];
  tools: ClaudeTool[];
  messages: ClaudeMessageParam[];
}

export interface ClaudeClient {
  create(request: ClaudeRequest): Promise<ClaudeMessage>;
}

/** An API failure, with a message that is safe to show to the WhatsApp user. */
export class ClaudeError extends Error {
  constructor(
    message: string,
    public readonly userMessage: string,
  ) {
    super(message);
  }
}

export class AnthropicClaudeClient implements ClaudeClient {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly config: Config,
    baseURL?: string,
  ) {
    this.client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  }

  async create(request: ClaudeRequest): Promise<ClaudeMessage> {
    const model = this.config.claudeModel;
    // If a safety classifier declines a request, let the API retry it on the
    // fallback model Anthropic recommends. Haiku has no server-side fallback.
    const useFallback = !model.startsWith('claude-haiku');
    try {
      const response = await this.client.beta.messages.create({
        model,
        max_tokens: this.config.claudeMaxTokens,
        // Thinking is adaptive on current models (and cannot be disabled on
        // claude-opus-5-5), so `thinking` is left out and effort is the control.
        output_config: { effort: this.config.claudeEffort },
        system: request.system,
        tools: request.tools,
        messages: request.messages,
        ...(useFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      });
      // Token usage only: never message content. Watch it with `wrangler tail`.
      console.log(
        JSON.stringify({
          evt: 'claude_usage',
          model: response.model,
          stop_reason: response.stop_reason,
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          cache_read_input_tokens: response.usage.cache_read_input_tokens,
          cache_creation_input_tokens: response.usage.cache_creation_input_tokens,
        }),
      );
      return response;
    } catch (error) {
      throw toClaudeError(error);
    }
  }
}

function toClaudeError(error: unknown): ClaudeError {
  const generic = "Sorry, I'm having trouble right now. Please try again in a few minutes.";
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new ClaudeError(
      `Claude API rejected the API key (${error.status})`,
      "Sorry, the assistant isn't set up correctly (the Claude API key was rejected). Please tell the administrator.",
    );
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ClaudeError('Claude API rate limit', "I'm a bit busy right now. Please send that again in a minute.");
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new ClaudeError(
      `Claude API 404: ${error.message}`,
      "Sorry, the assistant isn't set up correctly (unknown Claude model). Please tell the administrator.",
    );
  }
  if (error instanceof Anthropic.BadRequestError) {
    return new ClaudeError(`Claude API 400: ${error.message}`, generic);
  }
  if (error instanceof Anthropic.APIError) {
    return new ClaudeError(`Claude API error ${error.status ?? 'network'}: ${error.message}`, generic);
  }
  return new ClaudeError(`Claude call failed: ${(error as Error)?.message ?? error}`, generic);
}
