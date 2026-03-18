#!/bin/bash
set -euo pipefail

# setup-claude-token.sh — Generate a Claude Code OAuth token and store in 1Password
# Run this INTERACTIVELY in your terminal (not through Claude Code).
#
# Prerequisites:
#   - op CLI signed in
#   - claude CLI authenticated

VAULT="HonourSystems"
ITEM_NAME="Claude Code OAuth Token"

echo "=== Claude Code Token Setup ==="
echo ""

# Check prerequisites
if ! op whoami &>/dev/null; then
  echo "ERROR: Not signed in to 1Password. Run: op signin"
  exit 1
fi

echo "Generating token (browser will open)..."
echo ""

# Capture raw output and strip ANSI escape codes + terminal control sequences
RAW_OUTPUT=$(claude setup-token 2>/dev/null | sed 's/\x1b\[[0-9;]*[a-zA-Z]//g' | sed 's/\x1b\[[?][0-9]*[a-zA-Z]//g' | tr -d '\r')

# Extract the token (starts with sk-ant-oat01-)
TOKEN=$(echo "$RAW_OUTPUT" | grep -oE 'sk-ant-oat01-[A-Za-z0-9_-]+' | head -1)

if [ -z "$TOKEN" ]; then
  echo "ERROR: Could not extract token from output"
  echo "Raw output saved for debugging (check for sk-ant-oat01- prefix)"
  exit 1
fi

echo ""
echo "Token extracted successfully (${#TOKEN} chars)"
echo "Storing in 1Password..."

if op item get "$ITEM_NAME" --vault "$VAULT" &>/dev/null; then
  op item edit "$ITEM_NAME" --vault "$VAULT" \
    "credential=$TOKEN" &>/dev/null
  echo "Updated: $ITEM_NAME"
else
  op item create --category=password --vault "$VAULT" \
    --title "$ITEM_NAME" \
    "credential=$TOKEN" &>/dev/null
  echo "Created: $ITEM_NAME"
fi

unset TOKEN RAW_OUTPUT

echo ""
echo "Done. Token stored in 1Password ($VAULT / $ITEM_NAME)"
