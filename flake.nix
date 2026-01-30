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
          tauriBundleType = "appimage"; # Don't need deb or rpm
        });
      }
    );
}
