#!/usr/bin/env node
// Guards the production manifest against permission/CSP drift and checks that
// the build ships no source maps. Run after `pnpm build`.
//
//   node scripts/check-manifest.mjs           compare against the snapshot
//   node scripts/check-manifest.mjs --update  rewrite the snapshot from the build

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(root, ".output", "firefox-mv2");
const manifestPath = join(buildDir, "manifest.json");
const snapshotPath = join(root, "scripts", "manifest-snapshot.json");
const update = process.argv.includes("--update");

const sorted = (values) => [...(values ?? [])].sort();

function normalize(manifest) {
  const csp = manifest.content_security_policy;
  const splitCsp = (policy) =>
    policy
      .split(";")
      .map((directive) => directive.trim().replace(/\s+/g, " "))
      .filter(Boolean);
  return {
    manifest_version: manifest.manifest_version,
    gecko_id: manifest.browser_specific_settings?.gecko?.id ?? null,
    gecko_min_version: manifest.browser_specific_settings?.gecko?.strict_min_version ?? null,
    gecko_android_min_version: manifest.browser_specific_settings?.gecko_android?.strict_min_version ?? null,
    data_collection_permissions: manifest.browser_specific_settings?.gecko?.data_collection_permissions ?? null,
    background_persistent: manifest.background?.persistent ?? null,
    permissions: sorted(manifest.permissions),
    optional_permissions: sorted(manifest.optional_permissions),
    content_security_policy:
      typeof csp === "string"
        ? splitCsp(csp)
        : csp && typeof csp === "object"
          ? Object.fromEntries(
              Object.keys(csp)
                .sort()
                .map((key) => [key, splitCsp(csp[key])]),
            )
          : null,
    content_scripts_matches: (manifest.content_scripts ?? []).map((script) =>
      sorted(script.matches),
    ),
    // Which frames each content script runs in: subframes widen its reach.
    content_scripts_frames: (manifest.content_scripts ?? []).map((script) => ({
      all_frames: script.all_frames ?? false,
      match_about_blank: script.match_about_blank ?? false,
    })),
    web_accessible_resources: sorted(manifest.web_accessible_resources),
  };
}

function findSourceMaps(dir) {
  const hits = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      hits.push(...findSourceMaps(path));
    } else if (entry.name.endsWith(".map")) {
      hits.push(relative(root, path));
    } else if (
      /\.(js|css)$/.test(entry.name) &&
      /[#@] sourceMappingURL=/.test(readFileSync(path, "utf8"))
    ) {
      hits.push(`${relative(root, path)} (sourceMappingURL comment)`);
    }
  }
  return hits;
}

function isPrimitiveArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item !== "object" || item === null);
}

function diff(expected, actual) {
  const lines = [];
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])];
  for (const key of keys) {
    const before = expected[key];
    const after = actual[key];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    lines.push(`  ${key}:`);
    if (isPrimitiveArray(before) && isPrimitiveArray(after)) {
      for (const item of before) if (!after.includes(item)) lines.push(`    - ${JSON.stringify(item)}`);
      for (const item of after) if (!before.includes(item)) lines.push(`    + ${JSON.stringify(item)}`);
      if (lines.at(-1) === `  ${key}:`) lines.push("    (order changed)");
    } else {
      lines.push(`    - ${JSON.stringify(before)}`, `    + ${JSON.stringify(after)}`);
    }
  }
  return lines;
}

if (!existsSync(manifestPath)) {
  console.error(`check-manifest: ${relative(root, manifestPath)} not found. Run \`pnpm build\` first.`);
  process.exit(1);
}

let failed = false;
const actual = normalize(JSON.parse(readFileSync(manifestPath, "utf8")));

if (update) {
  writeFileSync(snapshotPath, `${JSON.stringify(actual, null, 2)}\n`);
  console.log(`check-manifest: wrote ${relative(root, snapshotPath)}`);
} else if (!existsSync(snapshotPath)) {
  console.error(`check-manifest: ${relative(root, snapshotPath)} missing. Run with --update to create it.`);
  failed = true;
} else {
  const expected = JSON.parse(readFileSync(snapshotPath, "utf8"));
  const changes = diff(expected, actual);
  if (changes.length > 0) {
    console.error("check-manifest: built manifest differs from the committed snapshot");
    console.error(`  (- ${relative(root, snapshotPath)}, + ${relative(root, manifestPath)})\n`);
    console.error(changes.join("\n"));
    console.error(
      "\nIf this change is intentional, review it and run `pnpm check:manifest --update`.",
    );
    failed = true;
  } else {
    console.log("check-manifest: manifest matches snapshot");
  }
}

const maps = findSourceMaps(buildDir);
if (maps.length > 0) {
  console.error(`check-manifest: production build contains source maps:\n  ${maps.join("\n  ")}`);
  failed = true;
} else {
  console.log("check-manifest: no source maps in build");
}

process.exit(failed ? 1 : 0);
