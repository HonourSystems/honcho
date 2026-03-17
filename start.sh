#!/bin/bash
# Start all Honcho services for local development
# Prerequisites: op signin, direnv allowed, Ollama running

set -e
cd "$(dirname "$0")"

echo "Loading secrets via direnv..."
eval "$(direnv export bash)"

echo "Starting Docker services..."
docker compose up -d

echo "Waiting for API health..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:8000/openapi.json > /dev/null 2>&1; then
    echo ""
    echo "Honcho is ready:"
    echo "  API:     http://localhost:8000"
    echo "  MCP:     http://localhost:8787"
    echo "  Grafana: http://localhost:3000"
    echo "  Docs:    http://localhost:8000/docs"
    exit 0
  fi
  sleep 1
done

echo "ERROR: API did not become healthy"
exit 1
