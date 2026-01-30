#!/usr/bin/env bash
set -e

echo "Running flatpak-builder..."
flatpak-builder --repo=flatpak-repo --force-clean flatpak-build flatpak/com.syzzle.Singularity.json
echo "Creating Flatpak bundle..."
flatpak build-bundle flatpak-repo SingularityMM.flatpak com.syzzle.Singularity
echo "Flatpak build and bundle complete. Output: SingularityMM.flatpak"
