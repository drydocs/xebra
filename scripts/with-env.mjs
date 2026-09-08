#!/usr/bin/env node
/**
 * Loads an env file into the environment, then execs the rest of the command line.
 *
 *   node scripts/with-env.mjs .env.local turbo run dev
 *
 * # Why this exists rather than `dotenv-cli` or a shell `source`
 *
 * There is no dotenv dependency anywhere in this repo — only `apps/web` ever saw the env
 * files, because Next.js loads them itself. Every Node service reads bare `process.env`, so
 * under `pnpm dev` they started with nothing set. Now that config is strict (no silent
 * fallbacks), that is a hard failure rather than a quiet fallback to localhost.
 *
 * A shell `source .env.local` cannot be used: the Stellar network passphrase contains a
 * semicolon —
 *
 *     STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
 *
 * — which `sh` treats as a command separator, so sourcing the file raw would both truncate
 * the passphrase and execute `September 2015` as a command. A parser is required, and the
 * passphrase is the one value that must survive intact: it is what the network-coherence
 * check keys on.
 *
 * Existing environment variables always win, so a one-off override still works:
 *
 *   NETWORK=mainnet pnpm dev     # uses mainnet even though .env.local says testnet
 */

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [envFile, ...command] = process.argv.slice(2);

if (!envFile || command.length === 0) {
  console.error("usage: node scripts/with-env.mjs <env-file> <command> [args...]");
  process.exit(2);
}

let contents;
try {
  contents = readFileSync(resolve(repoRoot, envFile), "utf8");
} catch (err) {
  console.error(`FAIL: cannot read ${envFile}: ${err.message}`);
  console.error("  Fresh checkout? Run: cp .env.production.example .env.production");
  process.exit(1);
}

const loaded = {};
for (const rawLine of contents.split("\n")) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;

  const eq = line.indexOf("=");
  if (eq === -1) continue;

  const key = line.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

  // Everything after the first `=` is the value, verbatim. No shell interpretation, so
  // semicolons, spaces and `#` inside a value are preserved.
  let value = line.slice(eq + 1).trim();

  // Strip one layer of matching quotes if the whole value is wrapped.
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
    (value.startsWith("'") && value.endsWith("'") && value.length > 1)
  ) {
    value = value.slice(1, -1);
  }

  if (value === "") continue; // an empty assignment means "not set", not "set to empty"
  loaded[key] = value;
}

// Real environment wins over the file, so ad-hoc overrides keep working.
const env = { ...loaded, ...process.env };

const count = Object.keys(loaded).length;
console.error(
  `with-env: loaded ${count} vars from ${envFile} (NETWORK=${env.NETWORK ?? "unset"})`,
);

// Inherit the caller's cwd. Forcing repoRoot here would break per-app usage: `next dev`
// invoked from apps/web must actually run in apps/web. The env FILE is still resolved
// relative to repoRoot, so `../../scripts/with-env.mjs .env.local` works from any package.
const child = spawn(command[0], command.slice(1), {
  stdio: "inherit",
  env,
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on("error", (err) => {
  console.error(`FAIL: could not run ${command[0]}: ${err.message}`);
  process.exit(1);
});
