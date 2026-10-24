# Rebuilding the AMO source submission

Use Linux (tested on this release branch), Node **22.22.3**, Corepack, **pnpm 11.22.0** as pinned with integrity in `package.json`, Git, and Info-ZIP `unzip` 6.0. Node's supported floor is 22.19; use the exact tested version when comparing release bytes. Obtain Node/Corepack through your normal trusted package source. This project does not bootstrap executables or download a browser for the build.

The source ZIP contains source, static assets, tests, this guide, build configuration, and the pnpm lockfile. It omits Git metadata, `.env` and other dotfiles, dependencies, build artifacts, local configuration, benchmark/research output, and source maps. `source:archive` requires tracked changes to be committed; it archives only an explicit allowlist of committed regular files. New source must be tracked before making a release. No external upload is performed.

From the extracted source directory, with the tools above already installed:

```sh
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm exec wxt prepare
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm lint:ext
corepack pnpm check:manifest
```

The install needs access to the npm registry and may need to obtain the exact pinned pnpm release through Corepack. All package versions and integrity hashes come from the lockfile. Dependency lifecycle scripts are disabled; `wxt prepare` is the explicit local type-generation step. No API key, account, `.env`, local file, network service, or Firefox installation is needed to build or run the deterministic fake-provider tests. WXT/Vitest need a usable local port in the build environment.

The production extension is `.output/firefox-mv2/`. WXT bundles Preact/TypeScript, Pi, and the other lockfile dependencies. On a stack that includes PDF support, PDF.js and its worker are bundled locally as well. The runtime CSP forbids remote executable code, eval, and Function construction; no remote worker is fetched. `check:manifest` checks the reviewed permissions, CSP, content-script frames, minimum Firefox version, and data-transmission declaration, and rejects source maps and sourceMappingURL comments.

For maintainers, from the **clean release checkout** after the production build:

```sh
corepack pnpm source:archive
corepack pnpm source:verify
corepack pnpm zip
```

The source archive is `.output/bside-<version>-source.zip`. WXT's automatic working-tree source ZIP is disabled; `pnpm zip` creates only the extension ZIP. Use the allowlisted source archive for submission. `source:verify` regenerates it, extracts it to a temporary directory, installs locked dependencies with scripts disabled, prepares types, typechecks, builds, checks the manifest, and SHA-256 compares **every production file** to the current build. A mismatch fails verification. The temporary tree is removed in either case. Repeated source archives from the same commit are deterministic; the command prints their SHA-256 and source commit. Production ZIP metadata need not match the source archive's metadata; the packaged production file bytes must match. Submit the source ZIP and this guide alongside the matching extension ZIP manually.

After a rebase or any code/dependency/manifest change, rerun the complete checks and source verification. Neither a successful build nor linter success proves native Firefox behavior or AMO approval; use [the release checklist](release-checklist.md).
