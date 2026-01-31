#!/usr/bin/env bash
set -e


# Ensure required Flatpak runtimes are installed
REQUIRED_SDK="org.gnome.Sdk//49"
REQUIRED_PLATFORM="org.gnome.Platform//49"

if ! flatpak info $REQUIRED_SDK > /dev/null 2>&1; then
	echo "Flatpak runtime $REQUIRED_SDK not found. Installing from flathub..."
	flatpak install -y flathub $REQUIRED_SDK
fi
if ! flatpak info $REQUIRED_PLATFORM > /dev/null 2>&1; then
	echo "Flatpak platform $REQUIRED_PLATFORM not found. Installing from flathub..."
	flatpak install -y flathub $REQUIRED_PLATFORM
fi

echo "Running flatpak-builder..."
flatpak-builder --repo=flatpak-repo --force-clean --disable-updates flatpak-build flatpak/com.syzzle.Singularity.json
echo "Creating Flatpak bundle..."
flatpak build-bundle flatpak-repo SingularityMM.flatpak com.syzzle.Singularity
echo "Flatpak build and bundle complete. Output: SingularityMM.flatpak"
