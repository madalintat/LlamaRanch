#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
install -Dm644 src-tauri/icons/128x128.png ~/.local/share/icons/hicolor/128x128/apps/llamaranch.png
install -Dm644 scripts/llamaranch.desktop ~/.local/share/applications/llamaranch.desktop
update-desktop-database ~/.local/share/applications 2>/dev/null || true
echo "Installed. Launch 'LlamaRanch' from your app launcher or run the binary directly."
