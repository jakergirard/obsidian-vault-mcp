#!/bin/bash
set -uo pipefail

VAULT_DIR="${VAULT_DIR:-/vault}"
DATA_DIR="${DATA_DIR:-/data}"
OB_VERSION="${OBSIDIAN_HEADLESS_VERSION:-latest}"

log() { echo "[entrypoint] $*"; }

mkdir -p "$VAULT_DIR" "$DATA_DIR"

# 1. Install obsidian-headless on first start.
#    It is NOT bundled in this image because its npm package is UNLICENSED;
#    it is fetched from npm by the end user at runtime instead. It installs
#    under /data (NPM_CONFIG_PREFIX) so it survives container recreation.
if ! command -v ob >/dev/null 2>&1; then
  log "Installing obsidian-headless@${OB_VERSION} from npm (first start)"
  npm install -g "obsidian-headless@${OB_VERSION}"
fi

# 2. Authenticate to Obsidian Sync.
until ob sync-list-remote >/dev/null 2>&1; do
  if [[ -n "${OBSIDIAN_EMAIL:-}" && -n "${OBSIDIAN_PASSWORD:-}" ]]; then
    log "Logging in to Obsidian Sync as ${OBSIDIAN_EMAIL}"
    if [[ -n "${OBSIDIAN_TOTP_SECRET:-}" ]]; then
      ob login --email "$OBSIDIAN_EMAIL" --password "$OBSIDIAN_PASSWORD" \
        --mfa "$(oathtool --totp -b "$OBSIDIAN_TOTP_SECRET")" && continue
    else
      ob login --email "$OBSIDIAN_EMAIL" --password "$OBSIDIAN_PASSWORD" && continue
    fi
    log "Login failed, retrying in 30s"
  else
    log "Not logged in and no OBSIDIAN_EMAIL/OBSIDIAN_PASSWORD set."
    log "Run: docker exec -it <container> ob login    (checked again in 30s)"
  fi
  sleep 30
done
log "Obsidian Sync: authenticated"

# 3. Link the remote vault (one time).
cd "$VAULT_DIR"
if [[ ! -f "$DATA_DIR/.vault_linked" ]]; then
  until [[ -n "${OBSIDIAN_VAULT:-}" ]]; do
    log "OBSIDIAN_VAULT is not set. Remote vaults on this account:"
    ob sync-list-remote || true
    sleep 60
  done
  SETUP_ARGS=(--vault "$OBSIDIAN_VAULT")
  if [[ -n "${OBSIDIAN_VAULT_PASSWORD:-}" ]]; then
    SETUP_ARGS+=(--password "$OBSIDIAN_VAULT_PASSWORD")
  fi
  log "Linking remote vault '${OBSIDIAN_VAULT}' and running initial pull (can take a while on a large vault)"
  until ob sync-setup "${SETUP_ARGS[@]}" < /dev/null && ob sync; do
    log "Vault link or initial sync failed. If this vault is end-to-end encrypted, set"
    log "OBSIDIAN_VAULT_PASSWORD to the vault encryption password (NOT the account password)."
    log "Retrying in 60s"
    sleep 60
  done
  touch "$DATA_DIR/.vault_linked"
fi

# 4. Run continuous sync + MCP server; exit if either dies so Docker restarts us.
log "Starting: ob sync --continuous + MCP server"
ob sync --continuous &
SYNC_PID=$!
node /app/server.js &
MCP_PID=$!

trap 'kill "$SYNC_PID" "$MCP_PID" 2>/dev/null' TERM INT
wait -n "$SYNC_PID" "$MCP_PID"
CODE=$?
log "A child process exited (code ${CODE}); stopping container"
kill "$SYNC_PID" "$MCP_PID" 2>/dev/null
exit "$CODE"
