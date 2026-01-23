{
  description = "Singularity Mod Manager - Nix Flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.05";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay.url = "github:oxalica/rust-overlay";
  };

  outputs = { self, nixpkgs, flake-utils, rust-overlay }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        overlays = [ (import rust-overlay) ];
        pkgs = import nixpkgs { inherit system overlays; };
        nodejs = pkgs.nodejs_20;
        rust = pkgs.rust-bin.stable.latest.default;
        tauri-deps = with pkgs; [
          webkitgtk gtk3 librsvg gdk-pixbuf atk cairo pango gobject-introspection glib dbus openssl pkg-config alsa-lib
          libappindicator-gtk3 libayatana-appindicator libxkbcommon
          xorg.libXrandr xorg.libX11 xorg.libXcomposite xorg.libXdamage xorg.libXfixes xorg.libXext xorg.libXrender xorg.libxcb xorg.libXinerama xorg.libXi xorg.libXtst xorg.libXScrnSaver xorg.libxshmfence xorg.libXau xorg.libXdmcp libdrm
          mesa at-spi2-atk at-spi2-core nss nspr cups expat zlib libsecret libdbusmenu-gtk3 libnotify
          flatpak flatpak-builder patchelf git
        ];
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = [ nodejs rust pkgs.bash ] ++ tauri-deps;
          shellHook = ''
            export PATH=$PATH:./node_modules/.bin
            echo "\nSingularityMM Nix dev shell loaded!\n"
            echo "- Node: $(node --version)"
            echo "- Rust: $(rustc --version)"
            echo "- Flatpak: $(flatpak --version)"
            echo "- Flatpak-builder: $(flatpak-builder --version)"

            # Run npm install if node_modules is missing or outdated
            if [ ! -d "node_modules" ] || [ "$(find node_modules -type f | wc -l)" -lt 10 ]; then
              echo "Running npm install..."
              npm install
            fi

            # Add alias for launching Tauri dev
            alias tauri-dev='npm run tauri dev'
            echo "\nUse 'tauri-dev' to launch the Tauri app in dev mode.\n"
          '';
        };

        packages.singularitymm = pkgs.stdenv.mkDerivation {
          pname = "singularitymm";
          version = "dev";
          src = builtins.filterSource (path: type:
            baseNameOf path == "scripts/prepare-flatpak.sh" ||
            type == "directory" ||
            baseNameOf path != ".git"
          ) (toString ../.);
          buildInputs = [ nodejs rust ] ++ tauri-deps;
          buildPhase = ''
            npm install
            npm run tauri build -- --no-bundle --config '{"bundle":{"createUpdaterArtifacts":false},"plugins":{"updater":{"active":false}}}'
          '';
          installPhase = ''
            mkdir -p $out/bin
            cp src-tauri/target/release/Singularity $out/bin/
          '';
        };

        packages.flatpak-build = pkgs.stdenv.mkDerivation {
          pname = "singularitymm-flatpak";
          version = "dev";
          src = ../.;
          buildInputs = [ nodejs rust ] ++ tauri-deps;
          buildPhase = ''
            npm install
            chmod +x ./scripts/prepare-flatpak.sh
            # Patch the shebang to use Nix bash
            sed -i "1s|.*|#!${pkgs.bash}/bin/bash|" ./scripts/prepare-flatpak.sh
            ./scripts/prepare-flatpak.sh
          '';
          installPhase = ''
            mkdir -p $out
            cp SingularityMM.flatpak $out/
          '';
        };
      }
    );
}
