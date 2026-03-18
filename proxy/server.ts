#!/usr/bin/env bun
/**
 * Claude Code Proxy — OpenAI-compatible API server
 *
 * Routes Honcho's LLM calls through a rotating pool of Claude Code
 * sessions using the Agent SDK. Each model gets POOL_SIZE warm sessions.
 * Each request takes a session from the pool, uses it for a single
 * prompt, then discards it and starts a fresh replacement in the
 * background — ensuring clean context between requests.
 *
 * Runs on the host (not in Docker) because Claude Code's auth
 * lives in macOS Electron storage. Docker containers reach it
 * via host.docker.internal:8800.
 *
 * Usage:
 *   bun run proxy/server.ts
 *
 * Honcho .env config:
 *   DERIVER_PROVIDER=vllm
 *   DIALECTIC_LEVELS__*__PROVIDER=vllm
 *   SUMMARY_PROVIDER=vllm
 *   LLM_VLLM_BASE_URL=http://host.docker.internal:8800/v1
 *   LLM_VLLM_API_KEY=local
 */

import {
  unstable_v2_createSession,
  unstable_v2_prompt,
  type SDKSession,
  type SDKResultMessage,
  type SDKSessionOptions,
} from "@anthropic-ai/claude-agent-sdk";

const PORT = parseInt(process.env.PORT || "8800", 10);
const POOL_SIZE = parseInt(process.env.POOL_SIZE || "3", 10);

const MODEL_MAP: Record<string, string> = {
  "claude-haiku-4-5": "claude-haiku-4-5",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-opus-4-6": "claude-opus-4-6",
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6",
};

function resolveModel(requested: string | undefined): string {
  if (!requested) return "claude-haiku-4-5";
  return MODEL_MAP[requested] ?? "claude-haiku-4-5";
}

// ---------------------------------------------------------------------------
// Session options — no tools, plan mode only
// ---------------------------------------------------------------------------

const SESSION_OPTIONS: Omit<SDKSessionOptions, "model"> = {
  permissionMode: "plan",
  disallowedTools: [
    "Bash", "Read", "Write", "Edit", "Glob", "Grep",
    "Agent", "Skill", "WebFetch", "WebSearch",
    "NotebookEdit", "TodoWrite",
  ],
};

// ---------------------------------------------------------------------------
// Session pool — POOL_SIZE ready sessions per model, use-once-and-replace
// ---------------------------------------------------------------------------

// Ready sessions waiting to serve a request
const ready = new Map<string, SDKSession[]>();
// Callers waiting for a session
const waiters = new Map<string, Array<(session: SDKSession) => void>>();
// Track how many sessions are being created (to avoid over-provisioning)
const creating = new Map<string, number>();

function spawnSession(model: string): void {
  const count = creating.get(model) ?? 0;
  creating.set(model, count + 1);
  console.log(`[pool] spawning session for ${model} (creating: ${count + 1})`);

  const session = unstable_v2_createSession({ model, ...SESSION_OPTIONS });

  // The session is ready immediately (process spawned, waiting for first message)
  creating.set(model, (creating.get(model) ?? 1) - 1);

  // Check if someone is waiting
  const w = waiters.get(model);
  if (w && w.length > 0) {
    const resolve = w.shift()!;
    resolve(session);
  } else {
    const pool = ready.get(model) ?? [];
    pool.push(session);
    ready.set(model, pool);
  }
}

function warmPool(model: string): void {
  const readyCount = (ready.get(model) ?? []).length;
  const creatingCount = creating.get(model) ?? 0;
  const needed = POOL_SIZE - readyCount - creatingCount;
  for (let i = 0; i < needed; i++) {
    spawnSession(model);
  }
}

async function acquireSession(model: string): Promise<SDKSession> {
  // Ensure pool is being filled
  warmPool(model);

  const pool = ready.get(model) ?? [];
  if (pool.length > 0) {
    return pool.shift()!;
  }

  // No session ready — wait for one
  return new Promise<SDKSession>((resolve) => {
    const w = waiters.get(model) ?? [];
    w.push(resolve);
    waiters.set(model, w);
  });
}

function recycleSession(model: string, session: SDKSession): void {
  // Close the used session (context is dirty)
  try {
    session.close();
  } catch {}
  // Spawn a fresh replacement
  spawnSession(model);
}

// ---------------------------------------------------------------------------
// Execute a prompt on a clean session
// ---------------------------------------------------------------------------

async function executePrompt(model: string, prompt: string): Promise<string> {
  const session = await acquireSession(model);

  try {
    await session.send(prompt);

    let resultText = "";
    for await (const message of session.stream()) {
      if (message.type === "result") {
        const result = message as SDKResultMessage;
        if (result.subtype === "success") {
          resultText = result.result;
        } else {
          throw new Error(`Claude error: ${result.subtype}`);
        }
        break;
      }
    }

    return resultText;
  } finally {
    // Always recycle — session context is now dirty
    recycleSession(model, session);
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible HTTP server
// ---------------------------------------------------------------------------

function messagesToPrompt(messages: Array<{ role: string; content: string }>): string {
  if (messages.length === 1) {
    return messages[0].content;
  }
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      parts.push(`[System]\n${msg.content}`);
    } else if (msg.role === "user") {
      parts.push(`[User]\n${msg.content}`);
    } else if (msg.role === "assistant") {
      parts.push(`[Assistant]\n${msg.content}`);
    }
  }
  return parts.join("\n\n");
}

function buildResponse(content: string, model: string): object {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

const server = Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health" || url.pathname === "/") {
      const status: Record<string, any> = {
        status: "ok",
        proxy: "claude-code-sdk",
        poolSize: POOL_SIZE,
      };
      for (const [model, sessions] of ready) {
        status[model] = {
          ready: sessions.length,
          creating: creating.get(model) ?? 0,
          waiting: (waiters.get(model) ?? []).length,
        };
      }
      return Response.json(status);
    }

    if (url.pathname === "/v1/models") {
      return Response.json({
        object: "list",
        data: [
          { id: "claude-haiku-4-5", object: "model", owned_by: "anthropic" },
          { id: "claude-sonnet-4-6", object: "model", owned_by: "anthropic" },
          { id: "claude-opus-4-6", object: "model", owned_by: "anthropic" },
        ],
      });
    }

    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      const start = Date.now();
      try {
        const body = await req.json();
        const model = resolveModel(body.model);
        const messages = body.messages ?? [];
        const prompt = messagesToPrompt(messages);

        console.log(
          `[proxy] ${new Date().toISOString()} model=${model} messages=${messages.length} prompt_len=${prompt.length}`,
        );

        const result = await executePrompt(model, prompt);
        const elapsed = Date.now() - start;

        console.log(
          `[proxy] ${new Date().toISOString()} done in ${elapsed}ms result_len=${result.length}`,
        );

        return Response.json(buildResponse(result, body.model ?? model));
      } catch (err: any) {
        console.error(`[proxy] error:`, err.message);
        return Response.json(
          { error: { message: err.message, type: "server_error", code: "internal_error" } },
          { status: 500 },
        );
      }
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
});

console.log(`[claude-code-proxy] listening on http://localhost:${server.port}/v1`);
console.log(`[claude-code-proxy] pool: ${POOL_SIZE} sessions per model, use-once-and-replace`);

// Eagerly warm the default model pool at startup
warmPool("claude-haiku-4-5");
console.log(`[claude-code-proxy] warming ${POOL_SIZE} haiku sessions`);
