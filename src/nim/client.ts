import OpenAI from 'openai'
import type { Config } from '../config'
import { RateLimiter } from './queue'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_call_id?: string
  tool_calls?: unknown
}

export interface ToolCall { id: string; name: string; arguments: string }

export interface ChatResult {
  content: string | null
  toolCalls: ToolCall[]
  assistantMessage: ChatMessage
  usage: { promptTokens: number; completionTokens: number }
}

export interface ChatParams {
  model: string
  messages: ChatMessage[]
  tools?: unknown[]
  maxTokens?: number
}

export interface ChatApi {
  chat: { completions: { create(body: unknown): Promise<unknown> } }
}

export class NimError extends Error {
  constructor(message: string, public status?: number) { super(message) }
}

const MAX_429_RETRIES = 3

export class NimClient {
  constructor(
    cfg: Config,
    private limiter: RateLimiter = new RateLimiter(cfg.requestsPerMinute),
    private api: ChatApi = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl }),
  ) {}

  async chat(params: ChatParams): Promise<ChatResult> {
    for (let attempt = 0; ; attempt++) {
      await this.limiter.acquire(params.model)
      try {
        const raw = await this.api.chat.completions.create({
          model: params.model,
          messages: params.messages,
          tools: params.tools,
          max_tokens: params.maxTokens ?? 8192,
        })
        return normalize(raw)
      } catch (err) {
        const status = (err as { status?: number }).status
        if (status === 404) {
          throw new NimError(
            `Model "${params.model}" not found on NVIDIA NIM — it may have been removed `
            + 'from the catalog. Call list_models and pick another model.', 404,
          )
        }
        if (status === 429 && attempt < MAX_429_RETRIES) {
          await new Promise((r) => setTimeout(r, 2 ** attempt * 1000))
          continue
        }
        if (err instanceof NimError) throw err
        throw new NimError(
          `NIM request to "${params.model}" failed${status ? ` (HTTP ${status})` : ''}: `
          + `${(err as Error).message}`, status,
        )
      }
    }
  }
}

function normalize(raw: unknown): ChatResult {
  const res = raw as {
    choices?: Array<{ message?: { role: string; content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const message = res.choices?.[0]?.message
  if (!message) throw new NimError('NIM response had no choices[0].message')
  return {
    content: message.content ?? null,
    toolCalls: (message.tool_calls ?? []).map((tc) => ({
      id: tc.id, name: tc.function.name, arguments: tc.function.arguments,
    })),
    assistantMessage: message as unknown as ChatMessage,
    usage: {
      promptTokens: res.usage?.prompt_tokens ?? 0,
      completionTokens: res.usage?.completion_tokens ?? 0,
    },
  }
}
