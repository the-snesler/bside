#!/usr/bin/env node
// Create a deterministic ZIP from reviewed, tracked source only. --verify
// rebuilds its extracted contents and compares every production file by hash.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, NO_COLOR: "1" } });
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const top = new Set(["AGENTS.md", "README.md", "LICENSE", "LICENSE.md", "package.json", "pnpm-lock.yaml", "tsconfig.json", "vitest.config.ts", "wxt.config.ts"]);
const roots = new Set(["entrypoints", "lib", "styles", "public", "scripts", "docs", "tests"]);
const allowed = (path) => {
  const parts = path.split("/");
  // Deny before reading: local configuration, secrets, generated output,
  // dependencies, and source maps cannot enter the submission.
  if (parts.some((part) => part.startsWith(".") || /^(node_modules|coverage|benchmark-results|research)$/.test(part) || /(?:^local(?:\.|$)|\.local\.|\.map$|\.zip$|\.pem$|\.key$)/i.test(part))) return false;
  return top.has(path) || (parts.length > 1 && roots.has(parts[0]));
};

function hashTree(directory) {
  if (!existsSync(directory)) throw new Error(`Missing build: ${directory}`);
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        if (!entry.isFile()) throw new Error(`Unexpected non-file in build: ${path}`);
        files.push([relative(directory, path), createHash("sha256").update(readFileSync(path)).digest("hex")]);
      }
    }
  }
  walk(directory);
  return JSON.stringify(files.sort(([a], [b]) => a.localeCompare(b)));
}

try {
  const verify = process.argv.includes("--verify");
  if (process.argv.slice(2).some((arg) => arg !== "--verify")) throw new Error("Usage: source-submission.mjs [--verify]");
  if (git("status", "--porcelain", "--untracked-files=no").trim()) throw new Error("Commit tracked changes before making the release source archive.");
  const files = git("ls-files", "-z").split("\0").filter((path) => path && allowed(path)).sort();
  for (const required of ["package.json", "pnpm-lock.yaml", "wxt.config.ts", "docs/source-build.md", "scripts/manifest-snapshot.json"]) {
    if (!files.includes(required)) throw new Error(`Required source file is not tracked: ${required}`);
  }
  for (const path of files) if (!lstatSync(join(root, path)).isFile()) throw new Error(`Source must be a regular file: ${path}`);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error("Unexpected package version");
  const output = join(root, ".output", `bside-${pkg.version}-source.zip`);
  mkdirSync(dirname(output), { recursive: true });
  // Git reads committed blobs, so untracked files and local data are never
  // copied. Paths are separate argv entries, never interpreted by a shell.
  run("git", ["archive", "--format=zip", `--output=${output}`, "HEAD", "--", ...files]);
  const entries = execFileSync("unzip", ["-Z1", output], { encoding: "utf8" }).trim().split("\n");
  const actual = entries.filter((path) => !path.endsWith("/"));
  if (actual.length !== files.length || actual.some((path) => !files.includes(path) || !allowed(path))) throw new Error("Source archive file list differs from the allowlist");
  console.log(`Source archive: ${relative(root, output)} (${files.length} files)`);
  console.log(`Source commit: ${git("rev-parse", "HEAD").trim()}`);
  console.log(`SHA-256: ${createHash("sha256").update(readFileSync(output)).digest("hex")}`);
  if (verify) {
    const expected = hashTree(join(root, ".output", "firefox-mv2"));
    const temporary = mkdtempSync(join(tmpdir(), "bside-source-verify-"));
    try {
      run("unzip", ["-q", output, "-d", temporary]);
      // Install only locked registry dependencies. No dependency lifecycle
      // scripts, browser downloads, bootstrap curl, or upload is performed.
      run("corepack", ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"], temporary);
      run("corepack", ["pnpm", "exec", "wxt", "prepare"], temporary);
      run("corepack", ["pnpm", "typecheck"], temporary);
      run("corepack", ["pnpm", "build"], temporary);
      run("corepack", ["pnpm", "check:manifest"], temporary);
      if (hashTree(join(temporary, ".output", "firefox-mv2")) !== expected) throw new Error("Extracted source rebuild differs from the current production build");
      console.log("Verified: extracted source rebuild matches every production file byte for byte.");
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
} catch (error) {
  console.error(`source-submission: ${error.message}`);
  process.exitCode = 1;
}
