# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

The source of truth for which RPC nodes QvaPay's self-custody wallets talk to. There is no app here: the deliverable is `registry.json`, a single versioned JSON that wallets download from raw.githubusercontent.com (primary) and jsDelivr (mirror). Everything else exists to keep that file valid and its endpoints alive.

Docs, code comments, commit messages and PR text are written in **Spanish**. Keep that convention. Commits follow conventional-commit prefixes: `feat(registry):`, `fix(check):`, `chore:`, `docs:`, `ci:`.

## Commands

Requires Node >= 22. There are no tests or linters; the check script is the whole toolchain.

```bash
npm ci
npm run check                          # schema + business rules + network probe of every enabled endpoint (tolerant mode)
npm run check -- --strict              # any down/lagging endpoint is an error
npm run check -- --strict --baseline=/path/to/main/registry.json   # what CI runs on PRs: only NEW endpoints must be healthy
npm run check -- --chain=polygon       # probe a single chain (combine with --strict as needed)
npm run check:schema                   # schema + business rules only, no network
```

To reproduce the PR check locally: `git show origin/main:registry.json > /tmp/base.json && npm run check -- --strict --baseline=/tmp/base.json`.

## Architecture

Three files and one workflow:

- `registry.json` — `{ version, updated_at, chains: { <id>: { kind, chainId?, name, native, explorer, tokens[], rpcs[] } } }`. Chain ids are lowercase (`ethereum`, `bsc`, `polygon`, `base`, `tron`, `bitcoin`, `stacks`, `solana`).
- `schema.json` — JSON Schema draft 2020-12, `additionalProperties: false` everywhere. The `kind` enum (`evm|tron|btc|stacks|solana`) and the `api` enum (`jsonrpc|trongrid|esplora|hiro|solana`) live here.
- `scripts/check.mjs` — single script, three stages that each exit on failure: (1) Ajv schema validation, (2) business rules the schema can't express, (3) network probes. Stages 1–2 are what `--no-network` runs.
- `.github/workflows/ci.yml` — same script, three triggers with different semantics (see below).

### Business rules enforced by check.mjs (not by the schema)

- Every chain has at least one `owner: "qvapay"` endpoint, and all of them have `priority: 0`. These are our own nodes; they usually ship with `enabled: false` and get flipped on by a commit when the hardware is ready.
- At least 2 **enabled public** (non-qvapay) endpoints per chain, from at least 2 distinct `owner` values.
- No embedded API keys: URLs with `?api_key=`/`?token=`/`?key=`, a 32-hex segment after `/vN/`, or a UUID in the path are rejected. HTTPS only (schema).
- No duplicate URLs within a chain.

### How the health probe works

- `priority` lower wins; wallets fail over in that order. `enabled: false` endpoints are skipped by the probe.
- Probe dialect comes from `rpc.api`, defaulting per chain `kind` via `DEFAULT_API`. Each dialect has its own branch in `probe()`: `jsonrpc` = `eth_chainId` + `eth_blockNumber` (chainId must match), `trongrid` = `/wallet/getnowblock`, `esplora` = `/blocks/tip/height` **and** `/address/<addr>/utxo` (address index is mandatory for a wallet), `hiro` = `/v2/info`, `solana` = `getHealth` + `getSlot`.
- Probes run through a pool of 6, 3 attempts each, 8 s timeout, and send `User-Agent: okhttp/4.12.0` so Cloudflare treats the probe like the mobile app rather than a bot. Don't remove the UA; without it half of Base showed as blocked.
- A node that answers but is more than 20 blocks behind the **median** height of its chain counts as down (stale balances are worse than no answer).
- HTTP 429 and Cloudflare challenges (403/503 + `server: cloudflare` + HTML or `cf-mitigated`) are "soft" failures (`⏳`/`🛡️`): the node is alive but rejects this IP. They don't count as healthy and never break `--strict`.
- Exit semantics: any chain with < 2 healthy endpoints always fails. `--strict` without baseline fails on any down/lagging endpoint. `--strict --baseline=<file>` fails only on down/lagging endpoints whose URL is **not** in the baseline; pre-existing failures are warned and left to the cron.

### CI semantics

- **pull_request / push to main**: `--strict --baseline=<registry.json from base branch or HEAD~1>`. New endpoints must respond; old ones that fail only warn.
- **schedule (every 6 h)**: tolerant mode. If a chain drops below 2 healthy public RPCs, the workflow opens (or comments on) an issue labelled `rpc-down`.

## Editing the registry

- Every change to `registry.json` bumps `version` by exactly 1 and sets `updated_at` to the current ISO timestamp. Clients ignore registries with a lower version than the one they cached, so never lower it.
- TRON endpoints with `api: "jsonrpc"` are read-only (no `eth_sendRawTransaction`); they must keep `priority >= 100`.
- Before proposing a provider, check the "Proveedores ya evaluados y descartados" table in the README. When removing an endpoint for a persistent reason, add it to that table with the reason.
- The README's badge counts (`chains-N`, `endpoints-N`) and the per-chain table (RPC and operator counts) are maintained by hand; update them when endpoints or chains change.

## Adding a new chain kind or API dialect

All of these must change together: the `kind` and/or `api` enums in `schema.json`, the `DEFAULT_API` map and a new `probe()` branch in `scripts/check.mjs`, an `owner: "qvapay"` entry (may be disabled) in `registry.json`, and the README chain table/badges. The `chainId` field is required only for `kind: "evm"`.
