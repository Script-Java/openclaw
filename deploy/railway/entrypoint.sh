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

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$STATE_DIR" "$WORKSPACE_DIR" "$PERSISTED_SECRET_DIR"
  chown node:node "$VOLUME_ROOT" "$STATE_DIR" "$WORKSPACE_DIR" "$PERSISTED_SECRET_DIR"
  # `railway ssh` opens a root shell, so CLI edits made there can leave files
  # the Gateway (running as node) cannot rewrite. Repair ownership only when a
  # mismatch exists: `find -quit` stops at the first foreign file, so a healthy
  # tree costs one directory walk that ends immediately.
  for dir in "$STATE_DIR" "$WORKSPACE_DIR" "$PERSISTED_SECRET_DIR"; do
    if [ -n "$(find "$dir" ! -user node -print -quit 2>/dev/null)" ]; then
      chown -R node:node "$dir"
    fi
  done
  chmod 700 "$STATE_DIR" "$PERSISTED_SECRET_DIR"

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
node /app/deploy/railway/bootstrap.mjs

# The listening port is owned by Railway networking (target port / PORT), not by
# openclaw.json, so it is passed explicitly and defaults to 8080.
GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-${PORT:-8080}}"
exec node /app/openclaw.mjs gateway --port "$GATEWAY_PORT" --allow-unconfigured "$@"
