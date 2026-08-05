{
  description = "Prime Agent";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    nixpkgs-darwin.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";
  };

  outputs =
    { nixpkgs, nixpkgs-darwin, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forEachSystem = nixpkgs.lib.genAttrs systems;
      nixpkgsFor =
        system:
        if
          builtins.elem system [
            "x86_64-darwin"
            "aarch64-darwin"
          ]
        then
          nixpkgs-darwin
        else
          nixpkgs;

      mkSystem =
        system:
        let
          pkgs = (nixpkgsFor system).legacyPackages.${system};
          nodejs = pkgs.nodejs_26;
          isLinux = pkgs.stdenv.hostPlatform.isLinux;
          runtimePath = [
            nodejs
            pkgs.bash
            pkgs.fd
            pkgs.git
            pkgs.ripgrep
            pkgs.gnutar
            pkgs.uv
            pkgs.python311
          ]
          ++ pkgs.lib.optionals isLinux [ pkgs.xdg-utils ];

          libraryPathArgs = pkgs.lib.optionalString isLinux "--prefix LD_LIBRARY_PATH : ${pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ]}";

          linuxCleanupPhase = if isLinux then ''
            case "${system}" in
              x86_64-linux)
                    zeroMqArch=x64
                ;;
              aarch64-linux)
                    zeroMqArch=arm64
                ;;
            esac

                find "$packageDir/node_modules/zeromq/build" \
              -mindepth 1 -maxdepth 1 -type d ! -name linux \
              -exec rm -rf {} +
            find "$packageDir/node_modules/zeromq/build/linux" \
              -mindepth 1 -maxdepth 1 -type d ! -name "$zeroMqArch" \
              -exec rm -rf {} +
            find "$packageDir/node_modules/zeromq/build/linux/$zeroMqArch/node" \
              -mindepth 1 -maxdepth 1 -type d -name 'musl-*' \
              -exec rm -rf {} +
          '' else "";

          prime-agent = pkgs.buildNpmPackage (finalAttrs: {
            pname = "prime-agent";
            version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
            src = ./.;

            inherit nodejs;
            npmDepsFetcherVersion = 2;
            npmDepsHash = "sha256-P6jX/qRm/Uk1Vmj/MzAUc9Oax91SJAbUkB7Q8qhH0qA=";
            # The upstream lockfile omits registry metadata for workspace dependencies.
            npmDeps = pkgs.fetchNpmDeps {
              name = "prime-agent-npm-deps";
              src = ./.;
              fetcherVersion = 2;
              hash = finalAttrs.npmDepsHash;
              nativeBuildInputs = [ pkgs.npm-lockfile-fix ];
              postPatch = "npm-lockfile-fix package-lock.json";
            };

            nativeBuildInputs = [
              pkgs.makeWrapper
              pkgs.pkg-config
            ] ++ pkgs.lib.optionals isLinux [ pkgs.autoPatchelfHook ];
            buildInputs = [
              pkgs.cairo
              pkgs.pango
            ];

            postPatch = ''
              cp ${finalAttrs.npmDeps}/package-lock.json package-lock.json
            '';
            dontConfigure = true;
            dontNpmBuild = true;
            buildPhase = ''
              runHook preBuild

              export PATH="$PWD/node_modules/.bin:$PATH"
              npm --workspace packages/tui run build
              (cd packages/ai && tsgo -p tsconfig.build.json)
              npm --workspace packages/agent run build
              npm --workspace packages/coding-agent run build

              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              npm prune --omit=dev --ignore-scripts
              packageDir=$out/lib/prime-agent
              mkdir -p "$packageDir" $out/bin
              cp -R node_modules "$packageDir/node_modules"
              rm -rf "$packageDir/node_modules/koffi"
              cp packages/coding-agent/package.json "$packageDir/package.json"
              cp -R packages/coding-agent/dist "$packageDir/dist"
              for path in README.md CHANGELOG.md docs examples skills; do
                cp -R "packages/coding-agent/$path" "$packageDir/$path"
              done

              mkdir -p "$packageDir/packages"
              for workspace in ai agent tui coding-agent; do
                mkdir -p "$packageDir/packages/$workspace"
                cp "packages/$workspace/package.json" "$packageDir/packages/$workspace/package.json"
                cp -R "packages/$workspace/dist" "$packageDir/packages/$workspace/dist"
              done
              for path in docs examples skills; do
                cp -R "packages/coding-agent/$path" "$packageDir/packages/coding-agent/$path"
              done

              ${linuxCleanupPhase}

              makeWrapper ${nodejs}/bin/node $out/bin/prime-agent \
                --add-flags "$packageDir/dist/bundle/cli.js" \
                --set PI_PACKAGE_DIR "$packageDir" \
                --set PI_SKIP_VERSION_CHECK 1 \
                --set UV_PYTHON_PREFERENCE system \
                --set UV_PYTHON_DOWNLOADS never \
                ${libraryPathArgs} \
                --prefix PATH : ${pkgs.lib.makeBinPath runtimePath}

              runHook postInstall
            '';

            doInstallCheck = true;
            nativeInstallCheckInputs = [ pkgs.versionCheckHook ];
            versionCheckProgramArg = "--version";

            meta = {
              description = "self-improving RLM coding and research agent";
              homepage = "https://github.com/PrimeIntellect-ai/prime-agent";
              license = pkgs.lib.licenses.mit;
              mainProgram = "prime-agent";
              platforms = systems;
            };
          });
        in
        {
          package = prime-agent;
        };
      perSystem = forEachSystem mkSystem;
    in
    {
      packages = forEachSystem (system: {
        default = perSystem.${system}.package;
      });
      apps = forEachSystem (system: {
        default = {
          type = "app";
          program = "${perSystem.${system}.package}/bin/prime-agent";
          meta.description = "self-improving RLM coding and research agent";
        };
      });
      checks = forEachSystem (system: {
        default = perSystem.${system}.package;
      });
    };
}
