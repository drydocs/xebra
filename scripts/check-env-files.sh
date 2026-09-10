#!/usr/bin/env bash
#
# Guards the local `.env.production` and its committed example.
#
# `.env.production` is deliberately NOT committed — a .env in a repository reads as a mistake
# regardless of its contents, and the authoritative constants live in packages/network-config
# as typed, validated presets. `.env.production.example` is tracked so a checkout can run
# `cp .env.production.example .env.production` and go.
#
# Both files are checked, because:
#
#   1. No secret ever lands in it.
#   2. Its contents stay coherent — checked by packages/network-config's own validator, so the
#      rules live in one place and are unit-tested rather than duplicated in shell.
#
# This build is mainnet-only. `.env.local` and the testnet presets were removed, which also
# removed the Next.js precedence hazard (next loads `.env.local` in every environment and it
# outranks `.env.production`) — there is no longer a second file to shadow the first.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

FAILED=0
fail() { echo "FAIL: $*" >&2; FAILED=1; }

ENV_FILE=".env.production"
EXAMPLE_FILE=".env.production.example"

# --- 1. No secrets ----------------------------------------------------------
SECRET_ANYWHERE='(SECRET|PRIVATE_KEY|KEYPAIR|MNEMONIC|SEED_PHRASE|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|CREDENTIAL)'
# "TOKEN" is only a secret as a SUFFIX (AUTH_TOKEN, API_TOKEN). Matching it anywhere would
# flag STELLAR_TOKEN_MESSENGER_ADDRESS, a public Circle contract address — a false positive
# that would teach everyone to ignore this check.
SECRET_SUFFIX='_TOKEN'

# CI has no .env.production and is not supposed to: the file is git-ignored, and the workflow
# supplies the same values through the environment the way a hosting platform does. Demanding
# the file there fails a build for doing the right thing, so the reminder is for humans only.
for f in "$ENV_FILE" "$EXAMPLE_FILE"; do
if [ ! -f "$f" ]; then
  if [ "$f" = "$ENV_FILE" ] && [ -z "${CI:-}" ]; then
    fail "$ENV_FILE is missing — run: cp $EXAMPLE_FILE $ENV_FILE"
  fi
else
  {
    grep -nEi "^[[:space:]]*[A-Z0-9_]*${SECRET_ANYWHERE}[A-Z0-9_]*[[:space:]]*=[[:space:]]*[^[:space:]]" "$f" || true
    grep -nEi "^[[:space:]]*[A-Z0-9_]*${SECRET_SUFFIX}[[:space:]]*=[[:space:]]*[^[:space:]]" "$f" || true
  } > /tmp/_secretcheck 2>/dev/null
  if [ -s /tmp/_secretcheck ]; then
    fail "$f contains secret-shaped keys with values:"
    sed 's/^/    /' /tmp/_secretcheck >&2
  fi
  rm -f /tmp/_secretcheck

  if grep -nE '\bS[A-Z2-7]{55}\b' "$f" >/dev/null 2>&1; then
    fail "$f contains what looks like a Stellar secret seed (S...)"
  fi
  if grep -nEi '(BEGIN [A-Z ]*PRIVATE KEY|\bsk_live_|\bghp_[A-Za-z0-9]{36})' "$f" >/dev/null 2>&1; then
    fail "$f contains what looks like a private key or API token"
  fi
  if grep -nE '://[^:/@[:space:]]+:[^@[:space:]]+@' "$f" >/dev/null 2>&1; then
    fail "$f contains a URL with inline credentials (user:pass@host)"
  fi
fi
done

# --- 2. Tracking is the right way round --------------------------------------
# The live file must stay OUT of git; the example must stay IN it. Getting either backwards is
# the failure: a committed .env invites secrets into it, and an ignored example means a fresh
# checkout has nothing to copy.
if ! git check-ignore -q "$ENV_FILE" 2>/dev/null; then
  fail "$ENV_FILE is NOT git-ignored — it must never be committed."
fi
if git check-ignore -q "$EXAMPLE_FILE" 2>/dev/null; then
  fail "$EXAMPLE_FILE is git-ignored — it must be tracked so a checkout has something to copy."
fi
if [ ! -f "$EXAMPLE_FILE" ]; then
  fail "$EXAMPLE_FILE is missing."
fi

# --- 3. No leftover testnet configuration ------------------------------------
if [ -f .env.local ]; then
  fail ".env.local exists. This is a mainnet-only build, and Next loads .env.local in every environment where it outranks .env.production. Remove it."
fi

# --- 4. Coherence, via the real validator ------------------------------------
# Whatever supplies the configuration gets validated: the file when there is one, and otherwise
# the process environment, which is what CI and every hosting platform actually hand the app.
if [ -d node_modules ] && [ -f packages/network-config/dist/index.js ]; then
  node --input-type=module -e "
    import { existsSync, readFileSync } from 'node:fs';
    import { assertNetwork, describeNetworkConfig } from './packages/network-config/dist/index.js';
    const file = '$ENV_FILE';
    const fromFile = existsSync(file);
    const env = {};
    if (fromFile) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\$/);
        if (m && m[2] !== '') env[m[1]] = m[2];
      }
    } else {
      Object.assign(env, process.env);
    }
    const source = fromFile ? file : 'the environment';
    try {
      console.log('  OK ' + source + ' ->', describeNetworkConfig(assertNetwork('mainnet', env)));
    } catch (e) {
      console.error('FAIL ' + source + ':', e.message);
      process.exit(1);
    }
  " || FAILED=1
else
  echo "  (skipping coherence check — run 'pnpm install && pnpm build' to enable it)"
fi

# --- 5. Client-bundle hygiene ------------------------------------------------
# Webpack's NEXT_PUBLIC_* substitution is purely textual: it only fires for a literal member
# expression. A dynamic `process.env[name]` cannot be statically analyzed, so in the CLIENT
# bundle it yields undefined for everything — while working perfectly on the server.
if grep -nE 'process\.env\[' apps/web/lib/env.ts apps/web/app/*.tsx 2>/dev/null \
   | grep -vE ':[[:space:]]*(\*|//|/\*)' > /tmp/_dynenv; then
  fail "dynamic process.env[...] access in client-bundled code — webpack cannot inline it:"
  sed 's/^/    /' /tmp/_dynenv >&2
fi
rm -f /tmp/_dynenv

# Importing @xebra/network-config into lib/env.ts drags its PRESETS table into the client
# bundle. Match a real import statement, not a mention in a doc comment.
if grep -qE "^[[:space:]]*(import|export).*from[[:space:]]+[\"']@xebra/network-config" apps/web/lib/env.ts 2>/dev/null; then
  fail "apps/web/lib/env.ts must NOT import @xebra/network-config — it ships config constants to the browser"
else
  echo "  OK apps/web/lib/env.ts keeps network-config out of the client bundle"
fi

# Must be chained into "build" itself, not a "prebuild" hook — pnpm leaves
# enable-pre-post-scripts false by default, so a hook would never run.
# Matches the guard being chained ahead of `next build`, tolerating env assignments in
# between (NEXT_DIST_DIR=... keeps builds off the dev server's .next). An exact-string match
# broke the moment that was added — a guard that fails on a benign edit gets deleted.
if grep -qE 'check-build-network\.mjs[[:space:]]*&&[^"]*next build' apps/web/package.json 2>/dev/null \
   && [ -f apps/web/scripts/check-build-network.mjs ]; then
  echo "  OK apps/web chains the network guard into its build script"
else
  fail "apps/web build must be: node scripts/check-build-network.mjs && next build"
fi

if [ "$FAILED" -eq 0 ]; then
  echo "env OK"
else
  echo >&2
  echo "Secrets belong in AWS Secrets Manager, injected at runtime — never in a tracked file." >&2
  exit 1
fi
