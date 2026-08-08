#!/usr/bin/env bash
# Runs once after the Codespace container is created (postCreateCommand).
# Keeps the persistent tmux workspace working across rebuilds without any
# manual setup. Intentionally does NOT start tmux — launching the session is
# a deliberate action via the "Open Enry Workspace" VS Code task.
set -euo pipefail

# tmux is not part of the default universal image; install it.
if ! command -v tmux >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tmux
fi

# Use the repo-tracked config as the user's global tmux config so mouse
# support, keybindings, and the status bar are consistent everywhere. A
# symlink means edits to .tmux.conf in the repo take effect immediately.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ln -sf "$REPO_ROOT/.tmux.conf" "$HOME/.tmux.conf"

echo "postCreate: tmux $(tmux -V | awk '{print $2}') ready; ~/.tmux.conf -> $REPO_ROOT/.tmux.conf"

# ─── Terminal CLIs for Drive's PTY panes ────────────────────────────────
# These are what the real-shell terminal panes (Drive UI) and the tmux free
# terminals are meant to run. They live in the ephemeral overlay FS (nvm's
# global bin), NOT under /workspaces — so they survive a Codespace stop/start
# but are WIPED on a container rebuild/recreate. Installing them here makes
# them permanent: every rebuild restores them (including the rebuild that
# first applies this devcontainer). All three ship a binary via an npm global
# (opencode's npm package is `opencode-ai`), so no curl|bash installer needed.
# A single flaky install must not abort postCreate, so each is non-fatal.
install_cli() {
  local pkg="$1" bin="$2"
  if command -v "$bin" >/dev/null 2>&1; then
    echo "postCreate: $bin already present ($(command -v "$bin"))"
    return 0
  fi
  echo "postCreate: installing $pkg (provides '$bin')…"
  npm install -g "$pkg" >/dev/null 2>&1 \
    && echo "postCreate: $bin ready ($(command -v "$bin" 2>/dev/null || echo 'installed'))" \
    || echo "postCreate: WARN could not install $pkg — install it manually with 'npm i -g $pkg'"
}
install_cli "@google/gemini-cli" "gemini"
install_cli "freebuff"           "freebuff"
install_cli "opencode-ai"        "opencode"

# ─── Blender (headless 3D asset generation) ─────────────────────────────
# Same durability problem as the CLIs above, same fix — but not an npm global,
# so it gets its own installer. Blender ships no Linux package worth using; the
# portable tarball extracted under ~/.local/opt is the supported way.
#
# Versioned directory + a stable `blender` symlink, so BLENDER_BIN
# (=~/.local/opt/blender/blender) survives an upgrade and a rebuild alike. The
# ~/.local/bin symlink means a bare `blender` also resolves, which is what
# src/lib/assets/blender.ts falls back to when BLENDER_BIN is unset.
#
# ~1.2GB extracted. If a rebuild ever fails here for space, that is the reason.
BLENDER_VERSION="5.2.0"
BLENDER_SHA256="96f6c181a30f4950607839dc84d42a354b250d8a0231b098b59b7bc69c351c48"
install_blender() {
  local prefix="$HOME/.local/opt"
  local versioned="$prefix/blender-$BLENDER_VERSION"
  if [ -x "$versioned/blender" ]; then
    echo "postCreate: blender $BLENDER_VERSION already present"
    ln -sfn "$versioned" "$prefix/blender"
    ln -sfn "$prefix/blender/blender" "$HOME/.local/bin/blender"
    return 0
  fi

  local series="${BLENDER_VERSION%.*}"
  local tarball="blender-$BLENDER_VERSION-linux-x64.tar.xz"
  # Staged on /tmp deliberately: it is a different, larger device than the
  # overlay, and holding the 384MB archive next to the 1.2GB extraction would
  # need headroom the overlay does not reliably have.
  local stage="/tmp/blender-download"

  echo "postCreate: installing blender $BLENDER_VERSION (~384MB download)…"
  mkdir -p "$stage" "$prefix" "$HOME/.local/bin"
  curl -fsSL -o "$stage/$tarball" \
    "https://download.blender.org/release/Blender$series/$tarball" || {
      echo "postCreate: WARN blender download failed — run scripts/install-blender.mjs manually"
      return 0
    }
  # An unattended binary gets its checksum checked before it is ever executed.
  echo "$BLENDER_SHA256  $stage/$tarball" | sha256sum -c - >/dev/null 2>&1 || {
      echo "postCreate: WARN blender checksum MISMATCH — refusing to install"
      rm -f "$stage/$tarball"
      return 0
    }
  rm -rf "$versioned" && mkdir -p "$versioned"
  tar -xf "$stage/$tarball" -C "$versioned" --strip-components=1
  ln -sfn "$versioned" "$prefix/blender"
  ln -sfn "$prefix/blender/blender" "$HOME/.local/bin/blender"
  rm -f "$stage/$tarball"
  echo "postCreate: $("$prefix/blender/blender" --version | head -1) ready"
}
install_blender
