import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { AppConfig } from '../config/app-config.js';

export interface LlmStatus {
  configured: boolean;
  provider: 'anthropic' | 'openai';
  model: string;
}

/**
 * Chooses the chat model for the Request Assistant (§6: `LLM_PROVIDER`, `LLM_MODEL`).
 * Tests replace this provider with one returning the AI SDK's mock model.
 */
@Injectable()
export class LlmProvider {
  private cached: LanguageModel | null = null;

  constructor(private readonly config: AppConfig) {}

  status(): LlmStatus {
    return {
      configured: this.config.llmApiKey !== undefined,
      provider: this.config.env.LLM_PROVIDER,
      model: this.config.env.LLM_MODEL,
    };
  }

  /** The configured model; 503 when no API key is set (never a fake answer). */
  model(): LanguageModel {
    if (this.cached) return this.cached;
    const apiKey = this.config.llmApiKey;
    if (!apiKey) {
      throw new ServiceUnavailableException(
        `The AI assistant is not configured: set ${
          this.config.env.LLM_PROVIDER === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'
        } in the server environment`,
      );
    }
    const modelId = this.config.env.LLM_MODEL;
    this.cached =
      this.config.env.LLM_PROVIDER === 'anthropic'
        ? createAnthropic({ apiKey })(modelId)
        : createOpenAI({ apiKey })(modelId);
    return this.cached;
  }
}
