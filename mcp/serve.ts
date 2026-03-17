import worker from "./worker";

const env = {
  HONCHO_BASE_URL: process.env.HONCHO_BASE_URL || "http://api:8000",
  HONCHO_DEFAULT_WORKSPACE: process.env.HONCHO_DEFAULT_WORKSPACE || "facilitator",
  HONCHO_DEFAULT_USER: process.env.HONCHO_DEFAULT_USER || "operator",
  HONCHO_DEFAULT_ASSISTANT: process.env.HONCHO_DEFAULT_ASSISTANT || "facilitator-agent",
  HONCHO_API_KEY: process.env.HONCHO_API_KEY || "local-dev-key",
};

const server = Bun.serve({
  port: 8787,
  hostname: "0.0.0.0",
  fetch: (request: Request) => worker.fetch(request, env),
});

console.log(`Honcho MCP server listening on http://0.0.0.0:${server.port}`);
