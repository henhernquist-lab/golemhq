#!/usr/bin/env bash
# Runs on EVERY container start, unlike postCreate.
#
# ─── Why this file has to exist ───────────────────────────────────────
# postCreateCommand fires once, when the container is created. Stopping and
# resuming a Codespace RESTARTS the container — postCreate does not run again.
# And /tmp comes back as a fresh disk on resume (the device name changes,
# sdb1 → sdc1), taking the voice venv with it.
#
# The two facts together meant voice mode was broken after every single resume,
# with the setup wired to a hook that would never fire again. Rebuilding it is
# a start-time job, not a create-time one.
#
# ─── Why it must not block ────────────────────────────────────────────
# Installing torch is minutes of download. postStartCommand runs before the
# workspace is handed over, so doing that inline would make every resume feel
# broken. The work is detached; voice reports itself unavailable until it
# finishes, which is exactly what that status field is for.

set -uo pipefail

REPO="/workspaces/enry.agent"
SETUP="$REPO/scripts/setup-voice.sh"
LOG="/tmp/golem-voice-setup.log"
PY="${GOLEM_VOICE_VENV:-/tmp/golem-voice-venv}/bin/python"

[ -f "$SETUP" ] || { echo "postStart: no setup-voice.sh — skipping voice"; exit 0; }

# Nothing is checked here on purpose. The obvious version — "is the venv
# usable?" before deciding — costs 30 seconds on every single start, because
# answering it means importing torch. setup-voice.sh asks exactly that question
# itself and exits in seconds when the answer is yes, so asking it twice buys
# nothing and the one that blocks the workspace is the one to drop.
if [ -x "$PY" ]; then
  echo "postStart: checking the voice venv in the background, log at $LOG"
else
  echo "postStart: voice venv missing — rebuilding in the background, log at $LOG"
fi
# setsid so it survives this script's process group being torn down when the
# start hook finishes. Without it the install dies partway and leaves a venv
# that exists but cannot import, which is worse than no venv at all.
setsid nohup bash "$SETUP" >"$LOG" 2>&1 &

exit 0
