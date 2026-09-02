# MiMoCode

MiMoCode is a rename/fork of OpenCode (sst/opencode) that ships the same
Drizzle `session`/`message`/`part` schema under its own data directory and
db filename prefix. It used to be reachable only through OpenCode's
`OPENCODE_DATA_DIR`/`OPENCODE_DB_PREFIX` escape hatch; it is its own provider
now so its cache section, env-var fingerprint, and `codeburn doctor` probe
stay independent of OpenCode's (see `docs/providers/NEW_PROVIDER.md`, "one
provider, one product").

- **Source:** `src/providers/mimocode.ts`
- **Loading:** lazy (`src/providers/index.ts`)
- **Test:** `tests/providers/mimocode.test.ts`

## Where it reads from

Default `~/.local/share/mimocode/` or `$XDG_DATA_HOME/mimocode/`. The
discovery walk picks up `mimocode*.db` files (matching the folder name —
verified against a real install), plus any file-based JSON sessions under
`storage/` (OpenCode 1.1+-style builds).

Two env vars override discovery, mirroring OpenCode's:

- `MIMOCODE_DATA_DIR` — the **exact** data directory (no `mimocode` suffix is
  appended). Relocates both file-based and SQLite storage.
- `MIMOCODE_DB_PREFIX` — the SQLite filename prefix (default `mimocode`,
  matching `mimocode*.db`). Affects SQLite discovery only; file-based storage
  under `<MIMOCODE_DATA_DIR>/storage/` is found regardless.

Precedence when no `dataDir` argument is passed (the production path):
`MIMOCODE_DATA_DIR` → `$XDG_DATA_HOME/mimocode` → `~/.local/share/mimocode`.

## Storage format

SQLite (older builds) or file-based JSON (newer builds), under `storage/`.
Identical shape to OpenCode's — both storage backends are read through the
same shared `sqlite-session-parser.ts` / `opencode-file-parser.ts` modules,
parameterized with `providerName: 'mimocode'`.

## Caching

None.

## Deduplication

Per `<sessionId>:<messageId>`.

## Quirks

- Same quirks as OpenCode (`docs/providers/opencode.md`): loud schema
  validation on a missing table, `<dbPath>:<sessionId>` source-path encoding,
  root-session-only discovery with child/grandchild agent sessions folded in
  via the `parent_id` subtree walk, and MCP tool names normalized from
  `<server>_<tool>` to `mcp__<server>__<tool>`.
- The on-disk db filename (`mimocode.db`) matches the folder name. An earlier
  version of this provider assumed a `mimicode.db` spelling (from a stale
  comment elsewhere in the codebase) and silently discovered zero sessions as
  a result — verify any future default against a real install before trusting
  a written description of one. `MIMOCODE_DB_PREFIX` exists to repoint
  discovery if a future build renames the file.
- A second, unrelated `mimocode.db` lives under `<dataDir>/memory/` (the
  client's separate long-term-memory store, not session history). Discovery
  only reads direct children of `dataDir`, so this nested file is never
  picked up — do not widen the scan to recurse into subdirectories, or this
  memory DB gets swept in as if it were a channel database.

## When fixing a bug here

1. Check whether the bug also affects OpenCode — the parsing logic is shared.
   If so, fix it in `sqlite-session-parser.ts` / `opencode-file-parser.ts` /
   `session-message.ts` and re-run both `tests/providers/opencode.test.ts` and
   `tests/providers/mimocode.test.ts`.
2. If the bug is MiMoCode-specific (default paths, env var names, filename
   prefix), it lives in `src/providers/mimocode.ts` itself.
