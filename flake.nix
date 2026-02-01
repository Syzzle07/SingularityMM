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

        # Only include files needed for the build — excludes .github, screenshots,
        # flatpak, scripts, build artifacts, etc.
        src = pkgs.lib.fileset.toSource {
          root = ./.;
          fileset = pkgs.lib.fileset.unions [
            ./src            # Frontend source
            ./src-tauri       # Rust source, Cargo.toml, tauri.conf.json, icons
            ./index.html      # Frontend entry point
            ./package.json
            ./package-lock.json
            ./vite.config.js  # Vite build config
          ];
        };

        cargoHash = "sha256-WZ8J4tq3ksnx+7beTGYCjho0MXAD6XIoj3r31O6AIcI=";
        npmDeps = pkgs.fetchNpmDeps {
          name = "${pname}-${version}-npm-deps";
          inherit src;
          hash = "sha256-kerJjj8fg6nPcJHvqcz8jWBbYkvc61pY8TR7wJ77tc0=";
        };

        # Shared build config — all packages reuse this derivation
        singularity = pkgs.rustPlatform.buildRustPackage (finalAttrs: {
          inherit pname version src cargoHash npmDeps;
          nativeBuildInputs = [
            pkgs.cargo-tauri.hook
            pkgs.nodejs
            pkgs.npmHooks.npmConfigHook
            pkgs.pkg-config
          ] ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.wrapGAppsHook4 ];
          buildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [
            pkgs.fribidi
            pkgs.glib-networking
            pkgs.harfbuzz
            pkgs.openssl
            pkgs.webkitgtk_4_1
          ];
          cargoRoot = "src-tauri";
          buildAndTestSubdir = "src-tauri";
          tauriBuildFlags = [ "--config" ''{"bundle":{"createUpdaterArtifacts":false},"plugins":{"updater":{"active":false}}}'' ];
          tauriBundleType = "deb"; # Required — install hook extracts binary from deb bundle
        });

        # Build scripts — shared between build and run apps
        buildFlatpakScript = pkgs.writeShellApplication {
          name = "build-flatpak-bundle";
          runtimeInputs = [
            pkgs.appstream
            pkgs.flatpak
            pkgs.flatpak-builder
            pkgs.coreutils
            pkgs.gawk
            pkgs.findutils
            pkgs.gnused
            pkgs.gnutar
            pkgs.gzip
            pkgs.jq
            pkgs.patchelf
            pkgs.which
          ];
          text = ''
            set -e
            REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
            cd "$REPO_ROOT"

            echo "Cleaning previous build artifacts..."
            rm -rf flatpak-build flatpak-repo .flatpak-builder flatpak-source

            # Copy resources using the unwrapped binary (skip the Nix GApps wrapper
            # since the flatpak runtime provides GTK/GIO libraries)
            SINGULARITY_BIN="${singularity}/bin/.Singularity-wrapped" flatpak/copy-resources.sh

            # Patch the binary for the flatpak runtime (replace Nix interpreter/rpath)
            echo "Patching binary for flatpak runtime..."
            chmod +w flatpak-source/Singularity
            patchelf --set-interpreter /lib64/ld-linux-x86-64.so.2 --remove-rpath flatpak-source/Singularity

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
            flatpak-builder --repo=flatpak-repo --force-clean --disable-updates --disable-rofiles-fuse flatpak-build flatpak/com.syzzle.Singularity.json
            echo "Creating Flatpak bundle..."
            flatpak build-bundle flatpak-repo SingularityMM.flatpak com.syzzle.Singularity
            echo "Flatpak build and bundle complete. Output: SingularityMM.flatpak"
          '';
        };

        buildAppimageScript = pkgs.writeShellApplication {
          name = "build-appimage";
          runtimeInputs = [
            pkgs.appstream
            pkgs.coreutils
            pkgs.file
            pkgs.findutils
            pkgs.gnused
            pkgs.patchelf
            pkgs.wget
            pkgs.zsync
          ];
          text = ''
            set -e
            REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
            cd "$REPO_ROOT"

            APPDIR="SingularityMM.AppDir"
            echo "Preparing AppDir..."
            rm -rf "$APPDIR" SingularityMM-Linux.AppImage

            mkdir -p "$APPDIR/usr/bin"
            mkdir -p "$APPDIR/usr/lib"
            mkdir -p "$APPDIR/usr/share/icons/hicolor/128x128/apps"
            mkdir -p "$APPDIR/usr/share/applications"
            mkdir -p "$APPDIR/usr/share/metainfo"

            # Copy the unwrapped binary (skip the Nix GApps wrapper which
            # hardcodes /nix/store paths for GIO/GTK/XDG_DATA_DIRS)
            cp "${singularity}/bin/.Singularity-wrapped" "$APPDIR/usr/bin/Singularity"
            chmod +wx "$APPDIR/usr/bin/Singularity"

            # Copy icon (use reverse-DNS name to match component ID)
            if [ -f src-tauri/icons/128x128.png ]; then
              cp src-tauri/icons/128x128.png "$APPDIR/usr/share/icons/hicolor/128x128/apps/com.syzzle.Singularity.png"
              cp src-tauri/icons/128x128.png "$APPDIR/com.syzzle.Singularity.png"
            fi

            # Create desktop file from template (adapt Exec/Icon for AppImage)
            sed -e 's|^Exec=.*|Exec=Singularity|' \
                -e 's|^Icon=.*|Icon=com.syzzle.Singularity|' \
                packaging/singularity.desktop.template > "$APPDIR/com.syzzle.Singularity.desktop"
            cp "$APPDIR/com.syzzle.Singularity.desktop" "$APPDIR/usr/share/applications/"

            # Copy AppStream metadata
            cp packaging/singularity.metainfo.xml "$APPDIR/usr/share/metainfo/com.syzzle.Singularity.appdata.xml"

            # Create AppRun
            cat > "$APPDIR/AppRun" <<'APPRUN'
            #!/bin/bash
            HERE="$(dirname "$(readlink -f "$0")")"
            export LD_LIBRARY_PATH="$HERE/usr/lib:$LD_LIBRARY_PATH"
            export GDK_BACKEND=x11
            exec "$HERE/usr/bin/Singularity" "$@"
            APPRUN
            chmod +x "$APPDIR/AppRun"

            # Bundle shared libraries from the Nix-built binary
            echo "Bundling shared libraries..."
            ldd "$APPDIR/usr/bin/Singularity" 2>/dev/null | grep -oP '/nix/store/\S+' | sort -u | while read -r LIB; do
              LIB_NAME=$(basename "$LIB")
              if [[ "$LIB_NAME" != "ld-linux"* ]] && [[ "$LIB_NAME" != "libc.so"* ]] && [[ "$LIB_NAME" != "libpthread"* ]] && [[ "$LIB_NAME" != "libdl"* ]] && [[ "$LIB_NAME" != "libm.so"* ]] && [[ "$LIB_NAME" != "librt"* ]]; then
                cp "$LIB" "$APPDIR/usr/lib/"
              fi
            done

            # Also bundle transitive deps of bundled libs
            echo "Bundling transitive dependencies..."
            for _pass in 1 2 3; do
              FOUND_NEW=false
              find "$APPDIR/usr/lib" -name '*.so*' -exec ldd {} \; 2>/dev/null | grep -oP '/nix/store/\S+' | sort -u | while read -r LIB; do
                LIB_NAME=$(basename "$LIB")
                if ! [ -f "$APPDIR/usr/lib/$LIB_NAME" ]; then
                  if [[ "$LIB_NAME" != "ld-linux"* ]] && [[ "$LIB_NAME" != "libc.so"* ]] && [[ "$LIB_NAME" != "libpthread"* ]] && [[ "$LIB_NAME" != "libdl"* ]] && [[ "$LIB_NAME" != "libm.so"* ]] && [[ "$LIB_NAME" != "librt"* ]]; then
                    cp "$LIB" "$APPDIR/usr/lib/"
                    FOUND_NEW=true
                  fi
                fi
              done
              if [ "$FOUND_NEW" = false ]; then
                break
              fi
            done

            echo "Bundled $(find "$APPDIR/usr/lib" -name '*.so*' | wc -l) libraries"

            # Download appimagetool and build
            TOOL="appimagetool-x86_64.AppImage"
            if [ ! -f "$TOOL" ]; then
              echo "Downloading appimagetool..."
              wget -q "https://github.com/AppImage/appimagetool/releases/download/continuous/$TOOL"
              chmod +x "$TOOL"
            fi

            echo "Building AppImage..."
            ARCH=x86_64 ./"$TOOL" "$APPDIR" SingularityMM-Linux.AppImage
            echo "AppImage built: SingularityMM-Linux.AppImage ($(du -h SingularityMM-Linux.AppImage | cut -f1))"
          '';
        };
      in
      {
        # nix build — compile check only, produces the binary
        packages.default = singularity;

        # nix run — launch the app directly
        apps.default = {
          type = "app";
          program = "${singularity}/bin/Singularity";
        };

        # nix run .#flatpak — build flatpak bundle (requires host flatpak runtimes)
        apps.flatpak = {
          type = "app";
          program = "${buildFlatpakScript}/bin/build-flatpak-bundle";
        };

        # nix run .#run-flatpak — build, install, and run the flatpak
        apps.run-flatpak = let
          script = pkgs.writeShellApplication {
            name = "run-flatpak";
            runtimeInputs = [ pkgs.flatpak ];
            text = ''
              set -e

              # Build the flatpak first
              echo "=== Building Flatpak ==="
              ${buildFlatpakScript}/bin/build-flatpak-bundle

              REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
              FLATPAK="$REPO_ROOT/SingularityMM.flatpak"

              echo "=== Installing Flatpak ==="
              flatpak install -y --user "$FLATPAK"
              echo "=== Launching Singularity ==="
              flatpak run com.syzzle.Singularity
            '';
          };
        in {
          type = "app";
          program = "${script}/bin/run-flatpak";
        };

        # nix run .#appimage — build AppImage (runs outside sandbox, needs linuxdeploy)
        apps.appimage = {
          type = "app";
          program = "${buildAppimageScript}/bin/build-appimage";
        };

        # nix run .#run-appimage — build and run the AppImage
        apps.run-appimage = let
          script = pkgs.writeShellApplication {
            name = "run-appimage";
            runtimeInputs = [ pkgs.coreutils ];
            text = ''
              set -e

              # Build the AppImage first
              echo "=== Building AppImage ==="
              ${buildAppimageScript}/bin/build-appimage

              REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
              APPIMAGE="$REPO_ROOT/SingularityMM-Linux.AppImage"

              chmod +x "$APPIMAGE"
              echo "=== Launching AppImage ==="
              exec "$APPIMAGE"
            '';
          };
        in {
          type = "app";
          program = "${script}/bin/run-appimage";
        };
      }
    );
}
