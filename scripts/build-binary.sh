#!/usr/bin/env bash
set -e

# Build the Tauri binary (Rust + frontend)
echo "Building Tauri binary..."
export PATH="$PATH:$(pwd)/node_modules/.bin"
npm run tauri build -- --no-bundle --config '{"bundle":{"createUpdaterArtifacts":false},"plugins":{"updater":{"active":false}}}'
