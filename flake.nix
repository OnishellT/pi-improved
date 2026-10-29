{
  description = "pi with the tools pi-improved needs on its PATH (node, git, tmux, gh)";

  # The rev here is the single pin: flake.lock records it and src/nix.ts reads it from there for the helper binaries.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/d3b13ad75cc492690728f9307e443dec9ef9a20e";

  outputs = { self, nixpkgs }:
    let
      # nixpkgs dropped x86_64-darwin, and its headless Chromium has no other build.
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
    in
    {
      packages = nixpkgs.lib.genAttrs systems (system:
        let pkgs = nixpkgs.legacyPackages.${system}; in
        {
          # pi alone cannot `pi install` a package: it shells out to npm and git.
          default = pkgs.symlinkJoin {
            name = "pi-improved-env";
            paths = [ pkgs.pi-coding-agent ];
            nativeBuildInputs = [ pkgs.makeWrapper ];
            postBuild = ''
              wrapProgram $out/bin/pi --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.nodejs_22 pkgs.git pkgs.tmux pkgs.gh ]}
            '';
            meta.mainProgram = "pi";
          };
        });
    };
}
