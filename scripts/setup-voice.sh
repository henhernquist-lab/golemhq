#!/usr/bin/env bash
# Build the Python environment voice mode needs: Whisper for speech→text,
# Kokoro for text→speech.
#
# ─── Where this lives, and why it is not $HOME ────────────────────────
# Measured, not assumed:
#
#   /            survives a Codespace restart, ~500MB free   (99% full)
#   /tmp         wiped on restart, 40GB free
#
# The only volume with room is the only one that does not persist. There is no
# third option, so the venv goes on /tmp and this script exists to rebuild it.
# A Codespace RESTART wipes /tmp without re-running postCreate, so this cannot
# be a create-time-only step — voice mode probes for the venv and points the
# user here when it is missing, rather than failing with an import error.
#
# ─── Why CPU-only torch ───────────────────────────────────────────────
# The previous ad-hoc install pulled torch 2.13+cu130 and cost 4.9GB for a
# machine with no GPU. The CPU wheels are a fraction of that and neither model
# can use CUDA here anyway. Kokoro is 82M params and Whisper base is 74M —
# both are comfortable on CPU.
#
# Model weights are NOT in the venv: Kokoro's live in ~/.cache/huggingface and
# Whisper's in ~/.cache/whisper, both on the persistent volume. Only the
# packages need rebuilding, which is what makes this cheap to re-run.
#
# Usage:  bash scripts/setup-voice.sh [--force]

set -euo pipefail

# pip's wheel cache lands in $HOME on the 99%-full root volume and grew to
# 582MB during one run of this script, taking the filesystem to 45MB free.
# That is not a tidiness issue: the last time / hit 100%, a concurrent write
# truncated .env.local to zero bytes. The venv is disposable, so caching the
# wheels that build it buys nothing worth that risk.
export PIP_NO_CACHE_DIR=1

VENV="${GOLEM_VOICE_VENV:-/tmp/golem-voice-venv}"
PY="$VENV/bin/python"

if [ "${1:-}" = "--force" ]; then
  echo "removing $VENV"
  rm -rf "$VENV"
fi

# espeak-ng is a system package, not a pip one: Kokoro shells out to it for
# phonemisation and fails at synthesis time without it. It lives on / and so
# survives restarts — checked rather than blindly reinstalled.
if ! command -v espeak-ng >/dev/null 2>&1; then
  echo "installing espeak-ng (required by Kokoro for phonemisation)…"
  sudo apt-get update -qq
  sudo apt-get install -y espeak-ng
fi
echo "espeak-ng: $(espeak-ng --version 2>&1 | head -1)"

# Kokoro fetches a voice pack from Hugging Face the first time each voice is
# used. That cache lives on / and so survives the /tmp wipes this whole script
# exists to recover from — but an un-warmed pack means the first "preview" click
# in the UI is a network round trip that fails outright on a host with no
# egress. Pulled ahead of time, and never fatal: a missing pack costs a slow
# first play, not a broken install.
#
# Kept in sync by hand with DEFAULT_ROTATION in src/lib/voice/voices.ts — these
# are the voices an agent gets without anyone choosing one.
warm_voices() {
  echo "warming default voice packs…"
  "$PY" - <<'PYWARM' || echo "  (could not pre-fetch voice packs — first playback will download them)"
from huggingface_hub import hf_hub_download
for voice in ("bm_george", "af_heart", "am_adam", "bf_emma"):
    try:
        hf_hub_download("hexgrad/Kokoro-82M", f"voices/{voice}.pt")
        print(f"  {voice}")
    except Exception as err:
        print(f"  {voice}: {err}")
PYWARM
}

if [ -x "$PY" ] && "$PY" -c "import whisper, kokoro, soundfile" >/dev/null 2>&1; then
  echo "voice venv already complete at $VENV"
  "$PY" -c "import whisper, torch; print(f'whisper {whisper.__version__}, torch {torch.__version__}')"
  warm_voices
  exit 0
fi

echo "building voice venv at $VENV …"
python3 -m venv "$VENV"
"$PY" -m pip install -q --upgrade pip

# CPU wheels explicitly. Without the index override pip resolves the CUDA
# build, which is several gigabytes of driver payload this host cannot use.
echo "installing torch (CPU wheels)…"
"$PY" -m pip install -q torch --index-url https://download.pytorch.org/whl/cpu

echo "installing whisper + kokoro…"
"$PY" -m pip install -q openai-whisper "kokoro>=0.9.4" soundfile

"$PY" -c "import whisper, kokoro, soundfile, torch; print(f'ok — whisper {whisper.__version__}, torch {torch.__version__}')"
warm_voices
echo "done. venv: $VENV"
