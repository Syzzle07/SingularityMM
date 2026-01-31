{
  description = "Singularity Mod Manager - Nix Flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        pname = "singularitymm";
        version = "dev";
        src = ./.;
        cargoHash = "sha256-WZ8J4tq3ksnx+7beTGYCjho0MXAD6XIoj3r31O6AIcI=";
        npmDeps = pkgs.fetchNpmDeps {
          name = "${pname}-${version}-npm-deps";
          inherit src;
          hash = "sha256-kerJjj8fg6nPcJHvqcz8jWBbYkvc61pY8TR7wJ77tc0=";
        };
      in
      {
        packages.default = pkgs.rustPlatform.buildRustPackage (finalAttrs: {
          inherit pname version src cargoHash npmDeps;
          nativeBuildInputs = [
            pkgs.cargo-tauri.hook
            pkgs.nodejs
            pkgs.npmHooks.npmConfigHook
            pkgs.pkg-config
          ] ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.wrapGAppsHook4 ];
          buildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [
            pkgs.glib-networking
            pkgs.openssl
            pkgs.webkitgtk_4_1
          ];
          cargoRoot = "src-tauri";
          buildAndTestSubdir = "src-tauri";
          tauriBuildFlags = [ "--config" src-tauri/tauri.conf.json ];
          tauriBundleType = null; # Build all targets from tauri.conf.json
        });

        # Use `nix run .#flatpakBundle` to build the flatpak bundle.
        # This runs outside the sandbox since flatpak-builder needs network
        # access and system flatpak runtimes.
        packages.flatpakBundle = let
          builtPackage = self.packages.${system}.default;
        in pkgs.writeShellApplication {
          name = "build-flatpak-bundle";
          runtimeInputs = [
            pkgs.flatpak
            pkgs.flatpak-builder
            pkgs.coreutils
            pkgs.gawk
            pkgs.findutils
            pkgs.gnused
            pkgs.gnutar
            pkgs.gzip
            pkgs.jq
            pkgs.which
          ];
          text = ''
            set -e
            REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
            cd "$REPO_ROOT"

            echo "Cleaning previous build artifacts..."
            rm -rf flatpak-build flatpak-repo .flatpak-builder flatpak-source

            # Prepare flatpak-source directory
            mkdir -p flatpak-source

            # Copy binary from Nix-built package
            cp "${builtPackage}/bin/Singularity" flatpak-source/Singularity
            chmod +x flatpak-source/Singularity

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
          '';
        };
      }
    );
}
