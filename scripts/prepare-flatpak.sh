#!/usr/bin/env bash
set -e

# Determine the project root (directory containing this script)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/.."
cd "$PROJECT_ROOT"


# Clean previous build artifacts
echo "Cleaning previous build artifacts..."
rm -rf flatpak-build flatpak-repo .flatpak-builder flatpak-source

# 1. Build the Tauri project (Rust binary + resources)
scripts/build-binary.sh

# 2. Prepare flatpak-source directory and copy all resources
scripts/flatpak/copy-resources.sh

# 3. Build the Flatpak bundle
scripts/flatpak/build-flatpak.sh
