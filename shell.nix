{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  buildInputs = with pkgs; [
    nodejs_20
    (rust-bin.stable.latest.default)
    webkitgtk gtk3 librsvg gdk-pixbuf atk cairo pango gobject-introspection glib dbus openssl pkg-config alsa-lib
    libappindicator-gtk3 libayatana-appindicator libxkbcommon libxrandr libx11 libxcomposite libxdamage libxfixes libxext libxrender libxcb libxinerama libxi libxtst libxss libxshmfence libxau libxdmcp libdrm mesa at-spi2-atk at-spi2-core nss nspr cups expat zlib libsecret libdbusmenu-gtk3 libnotify
    flatpak flatpak-builder patchelf git
  ];
  shellHook = ''
    export PATH=$PATH:./node_modules/.bin
    echo "\nSingularityMM Nix dev shell loaded!\n"
    echo "- Node: $(node --version)"
    echo "- Rust: $(rustc --version)"
    echo "- Flatpak: $(flatpak --version)"
  '';
}
