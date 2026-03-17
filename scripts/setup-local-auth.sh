#!/usr/bin/env bash
set -euo pipefail

# setup-local-auth.sh — Generate fresh Honcho auth credentials,
# store them in 1Password, and configure the local environment.
#
# Prerequisites:
#   - op CLI signed in (`op signin`)
#   - Docker Compose running the Honcho stack
#   - pip: pyjwt (`pip3 install pyjwt`)
#
# What it does:
#   1. Generates a fresh JWT secret
#   2. Creates an admin JWT signed with that secret
#   3. Stores both in 1Password (HonourSystems vault)
#   4. Updates .env with AUTH_USE_AUTH=true and the JWT secret
#   5. Restarts the API + deriver containers
#   6. Waits for healthy API
#   7. Updates ~/.honcho/config.json with the admin key

VAULT="HonourSystems"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env"
HONCHO_CONFIG="$HOME/.honcho/config.json"

echo "=== Honcho Local Auth Setup ==="
echo ""

# Check prerequisites
if ! command -v op &>/dev/null; then
  echo "ERROR: 1Password CLI (op) not found. Install: brew install --cask 1password-cli"
  exit 1
fi

if ! op whoami &>/dev/null; then
  echo "ERROR: Not signed in to 1Password. Run: op signin"
  exit 1
fi

if ! python3 -c "import jwt" &>/dev/null; then
  echo "ERROR: pyjwt not installed. Run: pip3 install pyjwt"
  exit 1
fi

echo "[1/7] Generating fresh JWT secret..."
JWT_SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")

echo "[2/7] Creating admin JWT..."
ADMIN_KEY=$(python3 -c "
import jwt
token = jwt.encode(
    {'t': '', 'ad': True},
    '${JWT_SECRET}'.encode('utf-8'),
    algorithm='HS256'
)
print(token)
")

echo "[3/7] Storing in 1Password (vault: $VAULT)..."

# Create or update JWT Secret item
if op item get "Honcho JWT Secret" --vault "$VAULT" &>/dev/null; then
  op item edit "Honcho JWT Secret" --vault "$VAULT" \
    "credential=$JWT_SECRET" &>/dev/null
  echo "  Updated: Honcho JWT Secret"
else
  op item create --category=password --vault "$VAULT" \
    --title "Honcho JWT Secret" \
    "credential=$JWT_SECRET" &>/dev/null
  echo "  Created: Honcho JWT Secret"
fi

# Create or update Admin API Key item
if op item get "Honcho Admin API Key" --vault "$VAULT" &>/dev/null; then
  op item edit "Honcho Admin API Key" --vault "$VAULT" \
    "credential=$ADMIN_KEY" &>/dev/null
  echo "  Updated: Honcho Admin API Key"
else
  op item create --category=password --vault "$VAULT" \
    --title "Honcho Admin API Key" \
    "credential=$ADMIN_KEY" &>/dev/null
  echo "  Created: Honcho Admin API Key"
fi

echo "[4/7] Updating .env..."

# Set AUTH_USE_AUTH=true
if grep -q "^AUTH_USE_AUTH=" "$ENV_FILE" 2>/dev/null; then
  sed -i '' "s|^AUTH_USE_AUTH=.*|AUTH_USE_AUTH=true|" "$ENV_FILE"
else
  echo "AUTH_USE_AUTH=true" >> "$ENV_FILE"
fi

# Set AUTH_JWT_SECRET
if grep -q "^AUTH_JWT_SECRET=" "$ENV_FILE" 2>/dev/null; then
  sed -i '' "s|^AUTH_JWT_SECRET=.*|AUTH_JWT_SECRET=${JWT_SECRET}|" "$ENV_FILE"
else
  # Replace the commented placeholder if it exists
  if grep -q "^# AUTH_JWT_SECRET=" "$ENV_FILE" 2>/dev/null; then
    sed -i '' "s|^# AUTH_JWT_SECRET=.*|AUTH_JWT_SECRET=${JWT_SECRET}|" "$ENV_FILE"
  else
    echo "AUTH_JWT_SECRET=${JWT_SECRET}" >> "$ENV_FILE"
  fi
fi

echo "[5/7] Restarting Honcho containers..."
cd "$PROJECT_DIR"
docker compose restart api deriver 2>&1 | sed 's/^/  /'

echo "[6/7] Waiting for API to be healthy..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:8000/docs &>/dev/null; then
    echo "  API is ready."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "  WARNING: API not responding after 30s. Check docker compose logs."
    exit 1
  fi
  sleep 1
done

echo "[7/7] Updating ~/.honcho/config.json..."
mkdir -p "$(dirname "$HONCHO_CONFIG")"

# Write config with the admin key
python3 -c "
import json, os

config_path = os.path.expanduser('$HONCHO_CONFIG')
config = {}
if os.path.exists(config_path):
    with open(config_path) as f:
        config = json.load(f)

config['apiKey'] = '$ADMIN_KEY'
config.setdefault('peerName', 'tackling')
config.setdefault('workspace', 'facilitator')
config.setdefault('endpoint', {'environment': 'local'})

with open(config_path, 'w') as f:
    json.dump(config, f, indent=2)
    f.write('\n')
"

echo ""
echo "=== Done ==="
echo ""
echo "Credentials stored in 1Password ($VAULT vault):"
echo "  - Honcho JWT Secret"
echo "  - Honcho Admin API Key"
echo ""
echo "Restart Claude Code to pick up the new API key."
echo ""
echo "To rotate credentials later, just re-run this script."
