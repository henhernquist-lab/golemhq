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
#   npx vercel login                  # once — see the note on device auth below
#   npx vercel link                   # once, pick the golemhq project
#   bash scripts/pull-vercel-env.sh   # safe to re-run
#
# Or with a token from https://vercel.com/account/tokens, no browser at all:
#   VERCEL_TOKEN=xxx bash scripts/pull-vercel-env.sh
#
# ─── Device auth works fine from a headless Codespace ──────────────────
# `vercel login` (and `vercel whoami` when logged out) uses the OAuth DEVICE
# flow: it prints https://vercel.com/oauth/device?user_code=XXXX-XXXX and waits.
# There is no localhost callback, so approving it from a browser on any other
# machine — phone included — completes the login here. The command must stay
# running while you approve; the code expires in minutes if it does not.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

TARGET=".env.local"
TMP="$(mktemp -d)/vercel.env"
trap 'rm -rf "$(dirname "$TMP")"' EXIT

TOKEN_ARG=()
[ -n "${VERCEL_TOKEN:-}" ] && TOKEN_ARG=(--token "$VERCEL_TOKEN")

# Production, not development. Variables added through the Vercel dashboard
# default to Preview+Production, so a development pull silently returns nothing
# for them and the run reports a cheerful "0 added".
ENVIRONMENT="${VERCEL_ENV_TARGET:-production}"
echo "→ pulling $ENVIRONMENT environment from Vercel…"
npx vercel env pull "$TMP" --environment="$ENVIRONMENT" --yes "${TOKEN_ARG[@]}" >/dev/null

[ -s "$TMP" ] || { echo "✗ Vercel returned an empty env file — is the project linked?"; exit 1; }

# Back up before touching anything. Cheap, and the alternative is unrecoverable.
cp "$TARGET" "$TARGET.bak.$(date +%s)"

# A value that is not a credential must never be written. Two ways that happens:
# Vercel returns the literal "[SENSITIVE]" for variables marked Sensitive (they
# are write-only by design and CANNOT be pulled), and capturing a CLI's stdout
# instead of its output writes a status line like "Loaded env from …" as the
# value. Both look present to every later check while breaking whatever reads
# them — a garbage GITHUB_PAT is worse than no GITHUB_PAT, because the code
# prefers it over the working fallback.
is_bogus() {
  case "$1" in
    ''|'[SENSITIVE]'|'Loaded env from '*|'Downloading'*|'Retrieving'*|'> '*) return 0 ;;
    *) return 1 ;;
  esac
}

# Vercel's runtime markers describe a DEPLOYMENT, not the project's config, and
# the platform injects them itself. Pinning them locally is actively harmful:
# eight call sites branch on process.env.VERCEL, including backend(), which
# would route every builder and terminal run to the Fly Sprite instead of local
# node-pty. VERCEL_TOKEN is not in this list — that one is a real credential.
is_runtime_marker() {
  case "$1" in
    VERCEL|VERCEL_ENV|VERCEL_TARGET_ENV|VERCEL_URL|VERCEL_REGION|VERCEL_BRANCH_URL|\
    VERCEL_PROJECT_PRODUCTION_URL|VERCEL_DEPLOYMENT_ID|VERCEL_SKEW_PROTECTION_ENABLED|\
    VERCEL_AUTOMATION_BYPASS_SECRET|VERCEL_GIT_*|CI|NOW_REGION) return 0 ;;
    *) return 1 ;;
  esac
}

added=0 conflicted=0 rejected=0
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue ;; esac
  key="${line%%=*}"
  case "$key" in *[!A-Za-z0-9_]*|'') continue ;; esac

  # Strip one layer of quotes before judging the value.
  value="${line#*=}"
  value="${value%\"}"; value="${value#\"}"
  if is_runtime_marker "$key"; then
    rejected=$((rejected + 1))
    continue
  fi
  if is_bogus "$value"; then
    echo "  ! $key came back as '${value:-<empty>}' — not a real value, skipped"
    rejected=$((rejected + 1))
    continue
  fi

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

echo "→ $added added, $conflicted conflicts (local kept), $rejected rejected as non-values"
echo "  backup at $TARGET.bak.*"

# "Present" is not the bar — a key holding a log line passes a grep and fails at
# runtime. Judge the value.
echo "→ checking the keys this batch needs:"
for k in GITHUB_PAT TRIPO_API_KEY TRIPO3D_API_KEY E2E_EMAIL E2E_PASSWORD; do
  if ! grep -q "^${k}=" "$TARGET" 2>/dev/null; then
    echo "  ✗ $k missing"
    continue
  fi
  v="$(grep -m1 "^${k}=" "$TARGET")"; v="${v#*=}"; v="${v%\"}"; v="${v#\"}"
  if is_bogus "$v"; then
    echo "  ✗ $k present but holds '${v:-<empty>}' — NOT a usable credential"
  else
    echo "  ✓ $k (${#v} chars)"
  fi
done

cat <<'NOTE'

Note: variables marked "Sensitive" in Vercel can never be pulled — the API
returns [SENSITIVE] instead of the value, on purpose. Check with
`npx vercel env ls`; anything Sensitive has to be copied from wherever it was
originally issued, not from Vercel.
NOTE
