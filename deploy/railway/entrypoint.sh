#!/bin/sh
# Railway entrypoint for the OpenClaw Gateway image (see Dockerfile.railway).
#
# Runs once as root to hand the Railway volume to the unprivileged `node` user
# (Railway mounts volumes root-owned), keeps legacy auth-profile key material on
# that volume, then drops privileges, runs the first-boot bootstrap, and execs
# the Gateway. Extra arguments are passed through to `openclaw gateway`.
set -eu

VOLUME_ROOT="${OPENCLAW_RAILWAY_VOLUME_ROOT:-/data}"
STATE_DIR="${OPENCLAW_STATE_DIR:-$VOLUME_ROOT/.openclaw}"
WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$VOLUME_ROOT/workspace}"
# The official image keeps the legacy encrypted-sidecar recovery key here; a
# fresh container would otherwise lose it on every redeploy.
LEGACY_SECRET_DIR="/home/node/.config/openclaw"
PERSISTED_SECRET_DIR="$VOLUME_ROOT/.openclaw-auth-profile-secrets"
# gog (Google Workspace CLI) state: OAuth client, refresh tokens, file keyring.
GOG_HOME="${GOG_HOME:-$VOLUME_ROOT/gogcli}"
export GOG_HOME

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$STATE_DIR" "$WORKSPACE_DIR" "$PERSISTED_SECRET_DIR" "$GOG_HOME"
  chown node:node "$VOLUME_ROOT" "$STATE_DIR" "$WORKSPACE_DIR" "$PERSISTED_SECRET_DIR" "$GOG_HOME"
  # `railway ssh` opens a root shell, so CLI edits made there can leave files
  # the Gateway (running as node) cannot rewrite. Repair ownership only when a
  # mismatch exists: `find -quit` stops at the first foreign file, so a healthy
  # tree costs one directory walk that ends immediately.
  for dir in "$STATE_DIR" "$WORKSPACE_DIR" "$PERSISTED_SECRET_DIR" "$GOG_HOME"; do
    if [ -n "$(find "$dir" ! -user node -print -quit 2>/dev/null)" ]; then
      chown -R node:node "$dir"
    fi
  done
  chmod 700 "$STATE_DIR" "$PERSISTED_SECRET_DIR" "$GOG_HOME"

  if [ ! -L "$LEGACY_SECRET_DIR" ]; then
    if [ -d "$LEGACY_SECRET_DIR" ]; then
      # Never clobber key material already on the volume.
      cp -an "$LEGACY_SECRET_DIR"/. "$PERSISTED_SECRET_DIR"/ 2>/dev/null || true
      rm -rf "$LEGACY_SECRET_DIR"
    fi
    mkdir -p "$(dirname "$LEGACY_SECRET_DIR")"
    ln -s "$PERSISTED_SECRET_DIR" "$LEGACY_SECRET_DIR"
    chown -h node:node "$LEGACY_SECRET_DIR"
  fi

  # The Gateway keeps its fallback temp dir under ~/.cache. The -browser image
  # variant ships that directory root-owned, so make sure node can write there.
  install -d -m 0755 -o node -g node /home/node/.cache
  if [ "$(stat -c %u /home/node)" != "$(id -u node)" ]; then
    chown node:node /home/node
  fi

  # The base image pre-creates an empty ~/.openclaw for its default volume
  # layout. On Railway the state lives on /data, and the leftover directory
  # makes `openclaw doctor` warn about split state directories, so drop it
  # while it is empty (rmdir refuses to remove anything that holds data).
  if [ "$STATE_DIR" != "/home/node/.openclaw" ]; then
    rmdir /home/node/.openclaw/workspace /home/node/.openclaw 2>/dev/null || true
  fi

  # A Railway volume attaches to exactly one container, and this container has
  # just started, so any gateway lock left on it belongs to a previous container
  # that Railway stopped without a clean shutdown. PIDs restart in every
  # container, so the stale lock can name a PID that is alive here (the Gateway
  # itself), which makes the runtime's owner check refuse to start.
  for lock in "$STATE_DIR"/tmp/openclaw-*/gateway.*.lock; do
    [ -e "$lock" ] || continue
    echo "railway-entrypoint: removing stale gateway lock $lock"
    rm -f "$lock"
  done

  exec setpriv --reuid=node --regid=node --init-groups --inh-caps=-all "$0" "$@"
fi

# Unprivileged from here on.

# gog encrypts its refresh tokens with a file keyring. The password comes from
# the GOG_KEYRING_PASSWORD variable when set; otherwise one is generated once
# and kept on the volume, so Google access survives redeploys without anyone
# re-authorizing. Setting the variable in Railway keeps the password off disk.
if [ -z "${GOG_KEYRING_PASSWORD:-}" ] && command -v gog >/dev/null 2>&1; then
  GOG_PASSWORD_FILE="$GOG_HOME/.keyring-password"
  if [ ! -s "$GOG_PASSWORD_FILE" ]; then
    umask 077
    node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$GOG_PASSWORD_FILE"
    umask 022
  fi
  GOG_KEYRING_PASSWORD="$(cat "$GOG_PASSWORD_FILE")"
  export GOG_KEYRING_PASSWORD
fi

# A Google OAuth client can be supplied as the GOG_CLIENT_SECRET_JSON variable
# (the downloaded Desktop-client JSON). It is stored for gog at every boot, so a
# rotated client takes effect on the next deploy.
if [ -n "${GOG_CLIENT_SECRET_JSON:-}" ] && command -v gog >/dev/null 2>&1; then
  umask 077
  printf '%s' "$GOG_CLIENT_SECRET_JSON" > "$GOG_HOME/client_secret.json"
  umask 022
  if gog auth credentials "$GOG_HOME/client_secret.json" --no-input >/dev/null 2>&1; then
    echo "railway-entrypoint: stored Google OAuth client for gog"
  else
    echo "railway-entrypoint: gog could not store GOG_CLIENT_SECRET_JSON; check that it is the Desktop OAuth client JSON" >&2
  fi
fi

node /app/deploy/railway/bootstrap.mjs

# The listening port is owned by Railway networking (target port / PORT), not by
# openclaw.json, so it is passed explicitly and defaults to 8080.
GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-${PORT:-8080}}"
exec node /app/openclaw.mjs gateway --port "$GATEWAY_PORT" --allow-unconfigured "$@"
