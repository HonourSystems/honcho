#!/usr/bin/env bun
/**
 * Claude Code Proxy — OpenAI-compatible API server
 *
 * Routes Honcho's LLM calls (deriver, dialectic, summary) through
 * Claude Code's CLI, using its existing subscription auth instead
 * of a separate Anthropic API key.
 *
 * Each request spawns `claude -p` with no tools, no session persistence,
 * and a system prompt instructing plain text output (no markdown fences).
 *
 * Runs on the host (not in Docker) because Claude Code's auth
 * lives in macOS Electron storage. Docker containers reach it
 * via host.docker.internal:8800.
 *
 * Usage:
 *   bun run proxy/server.ts              # default port 8800
 *   PORT=9000 bun run proxy/server.ts    # custom port
 *
 * Honcho .env config:
 *   DERIVER_PROVIDER=vllm
 *   DIALECTIC_LEVELS__*__PROVIDER=vllm
 *   SUMMARY_PROVIDER=vllm
 *   LLM_VLLM_BASE_URL=http://host.docker.internal:8800/v1
 *   LLM_VLLM_API_KEY=local
 */

const PORT = parseInt(process.env.PORT || "8800", 10);

// Map model names to Claude CLI aliases
const MODEL_MAP: Record<string, string> = {
  "claude-haiku-4-5": "haiku",
  "claude-sonnet-4-6": "sonnet",
  "claude-opus-4-6": "opus",
  haiku: "haiku",
  sonnet: "sonnet",
  opus: "opus",
};

function resolveModel(requested: string | undefined): string {
  if (!requested) return "haiku";
  return MODEL_MAP[requested] ?? "haiku";
}

/** Convert OpenAI messages array to a single prompt string */
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

/** Extract system prompt from messages */
function extractSystemPrompt(messages: Array<{ role: string; content: string }>): {
  systemPrompt: string | null;
  remainingMessages: Array<{ role: string; content: string }>;
} {
  const systemMessages = messages.filter((m) => m.role === "system");
  const remaining = messages.filter((m) => m.role !== "system");
  if (systemMessages.length === 0) {
    return { systemPrompt: null, remainingMessages: remaining };
  }
  return {
    systemPrompt: systemMessages.map((m) => m.content).join("\n\n"),
    remainingMessages: remaining,
  };
}

// Instruct Claude to return raw text, no markdown formatting
const PROXY_SYSTEM_SUFFIX =
  "IMPORTANT: Return plain text only. Never wrap output in markdown code fences (```). Never use ``` blocks. Output raw content directly.";

/** Call claude CLI in print mode and return the result */
async function callClaude(
  prompt: string,
  model: string,
  systemPrompt: string | null,
): Promise<string> {
  const fullSystem = systemPrompt
    ? `${systemPrompt}\n\n${PROXY_SYSTEM_SUFFIX}`
    : PROXY_SYSTEM_SUFFIX;

  const args = [
    "-p",
    "--output-format", "text",
    "--model", model,
    "--no-session-persistence",
    "--system-prompt", fullSystem,
    "--allowedTools", "",
    "--disable-slash-commands",
  ];

  const proc = Bun.spawn(["claude", ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  proc.stdin.write(prompt);
  proc.stdin.end();

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error(`[proxy] claude exited ${exitCode}: ${stderr}`);
    throw new Error(`Claude CLI error: ${stderr.trim() || "unknown error"}`);
  }

  // Strip any markdown code fences that snuck through
  let result = stdout.trim();
  result = result.replace(/^```(?:json|text)?\s*\n?/gm, "").replace(/\n?```\s*$/gm, "");
  return result.trim();
}

/** Build an OpenAI-compatible chat completion response */
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
      return Response.json({ status: "ok", proxy: "claude-code" });
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
      try {
        const body = await req.json();
        const model = resolveModel(body.model);
        const messages = body.messages ?? [];
        const { systemPrompt, remainingMessages } = extractSystemPrompt(messages);
        const prompt = messagesToPrompt(remainingMessages);

        console.log(
          `[proxy] ${new Date().toISOString()} model=${model} messages=${messages.length} prompt_len=${prompt.length}`,
        );

        const result = await callClaude(prompt, model, systemPrompt);

        console.log(
          `[proxy] ${new Date().toISOString()} response_len=${result.length}`,
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
console.log(`[claude-code-proxy] models: haiku, sonnet, opus`);
