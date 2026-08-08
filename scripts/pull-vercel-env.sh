#!/usr/bin/env bash
# Merge Vercel's environment variables into .env.local without destroying it.
#
# ─── Why this exists rather than just `vercel env pull .env.local` ──────
# That command OVERWRITES the target file with only what Vercel knows about.
# This Codespace's .env.local holds keys Vercel has never seen — BLENDER_BIN,
# SPRITES_TOKEN, SPRITE_NAME, the NIM per-model keys — and every one of them
# would be silently deleted. The damage would not show up until something
# unrelated broke later.
#
# So: pull to a temp file, then add only keys that are genuinely new, and report
# conflicts instead of resolving them silently.
#
# Usage:
#   vercel login                      # once, interactive
#   vercel link                       # once, pick the golemhq project
#   bash scripts/pull-vercel-env.sh   # safe to re-run
#
# Or without an interactive login, using a token from
# https://vercel.com/account/tokens :
#   VERCEL_TOKEN=xxx bash scripts/pull-vercel-env.sh

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

TARGET=".env.local"
TMP="$(mktemp -d)/vercel.env"
trap 'rm -rf "$(dirname "$TMP")"' EXIT

TOKEN_ARG=()
[ -n "${VERCEL_TOKEN:-}" ] && TOKEN_ARG=(--token "$VERCEL_TOKEN")

echo "→ pulling development environment from Vercel…"
npx vercel env pull "$TMP" --environment=development --yes "${TOKEN_ARG[@]}" >/dev/null

[ -s "$TMP" ] || { echo "✗ Vercel returned an empty env file — is the project linked?"; exit 1; }

# Back up before touching anything. Cheap, and the alternative is unrecoverable.
cp "$TARGET" "$TARGET.bak.$(date +%s)"

added=0 conflicted=0
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue ;; esac
  key="${line%%=*}"
  case "$key" in *[!A-Za-z0-9_]*|'') continue ;; esac

  if grep -q "^${key}=" "$TARGET" 2>/dev/null; then
    existing="$(grep -m1 "^${key}=" "$TARGET")"
    if [ "$existing" != "$line" ]; then
      echo "  ! $key differs between Vercel and $TARGET — left the local value alone"
      conflicted=$((conflicted + 1))
    fi
  else
    printf '%s\n' "$line" >> "$TARGET"
    echo "  + $key"
    added=$((added + 1))
  fi
done < "$TMP"

echo "→ $added added, $conflicted conflicts (local kept), backup at $TARGET.bak.*"

echo "→ checking the keys this batch needs:"
for k in GITHUB_PAT TRIPO_API_KEY TRIPO3D_API_KEY E2E_EMAIL E2E_PASSWORD; do
  if grep -q "^${k}=" "$TARGET" 2>/dev/null; then echo "  ✓ $k"; else echo "  ✗ $k still missing"; fi
done
