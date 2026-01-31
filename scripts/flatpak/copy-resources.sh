#!/usr/bin/env bash
set -e

# Prepare flatpak-source directory and copy all required resources

mkdir -p flatpak-source

# Copy binary
cp src-tauri/target/release/Singularity flatpak-source/Singularity

# Copy locales if present
if [ -d src-tauri/target/release/locales ]; then
    cp -r src-tauri/target/release/locales flatpak-source/locales
fi

# Copy icon
if [ -f src-tauri/icons/128x128.png ]; then
    cp src-tauri/icons/128x128.png flatpak-source/singularity.png
fi

# Copy metainfo.xml
cp flatpak/com.syzzle.Singularity.metainfo.xml flatpak-source/singularity.metainfo.xml

# Copy screenshots
mkdir -p flatpak-source/screenshots
cp screenshots/Screenshot*.png flatpak-source/screenshots/ 2>/dev/null || true

# Copy wrapper script
cp flatpak/singularity-wrapper flatpak-source/singularity-wrapper
chmod +x flatpak-source/singularity-wrapper

# Copy desktop file
cp flatpak/singularity-mm.desktop.template flatpak-source/singularity.desktop
