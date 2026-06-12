#!/usr/bin/env bash
# Build the game wasm module into game/pkg/ (committed; Pages serves it as-is).
set -euo pipefail

# Prefer the rustup-managed toolchain (has the wasm32 target) over Homebrew rust.
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO/game-src"

wasm-pack build crates/wasm \
  --target web \
  --release \
  --out-dir "$REPO/game/pkg" \
  --out-name naks_awakening

# wasm-pack drops a .gitignore into the out dir; we commit pkg/, so remove it.
rm -f "$REPO/game/pkg/.gitignore"

SIZE=$(stat -f%z "$REPO/game/pkg/naks_awakening_bg.wasm")
BUDGET=$((1536 * 1024))
echo "wasm size: $((SIZE / 1024)) KB (budget 1536 KB)"
if [ "$SIZE" -gt "$BUDGET" ]; then
  echo "WARNING: wasm exceeds size budget" >&2
fi
