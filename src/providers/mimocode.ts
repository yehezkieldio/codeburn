import { join } from 'path'
import { homedir } from 'os'

import { getShortModelName } from '../models.js'
import { discoverSqliteSessions, createSqliteSessionParser, type SqliteProviderConfig } from './sqlite-session-parser.js'
import { discoverOpenCodeFileSessions, createOpenCodeFileSessionParser } from './opencode-file-parser.js'
import type { Provider, ProbeRoot, SessionSource, SessionParser } from './types.js'

// MiMoCode is an OpenCode-compatible rename/fork: same session/message/part
// Drizzle schema (SQLite or, on 1.1+ builds, file-based JSON under storage/),
// just under its own data directory and db filename prefix. It used to be
// reached only through opencode's OPENCODE_DATA_DIR/OPENCODE_DB_PREFIX escape
// hatch; it gets its own provider now so its cache section, env-var
// fingerprint, and `codeburn doctor` probe are independent of opencode's
// (see docs/providers/NEW_PROVIDER.md, "one provider, one product").

const toolNameMap: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  glob: 'Glob',
  grep: 'Grep',
  task: 'Agent',
  fetch: 'WebFetch',
  search: 'WebSearch',
  todo: 'TodoWrite',
  skill: 'Skill',
  patch: 'Patch',
}

function getDataDir(dataDir?: string): string {
  // Test seam: createMiMoCodeProvider(tmpDir) points at a base dir that still
  // gets the 'mimocode' subdirectory appended.
  if (dataDir) return join(dataDir, 'mimocode')

  // This is the EXACT data directory - no 'mimocode' suffix - so a build
  // writing straight into an already-namespaced override dir is found
  // instead of silently yielding zero sessions.
  const override = process.env['MIMOCODE_DATA_DIR']
  if (override) return override

  // Default: $XDG_DATA_HOME/mimocode or ~/.local/share/mimocode.
  const base = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share')
  return join(base, 'mimocode')
}

function getSqliteConfig(dataDir?: string): SqliteProviderConfig {
  return {
    providerName: 'mimocode',
    displayName: 'MiMoCode',
    dbDir: getDataDir(dataDir),
    // Truthy check (not `??`): an empty-string MIMOCODE_DB_PREFIX must fall
    // back to 'mimocode', not match every '*.db' file in the dir. Verified
    // against a real ~460MB install: the on-disk file is
    // <dataDir>/mimocode.db (matching the folder name), not 'mimicode.db' —
    // an earlier version of this provider assumed the latter from a stale
    // docs comment and silently discovered zero sessions as a result.
    dbFilePrefix: process.env['MIMOCODE_DB_PREFIX'] || 'mimocode',
  }
}

export function createMiMoCodeProvider(dataDir?: string): Provider {
  const sqliteConfig = getSqliteConfig(dataDir)
  const resolvedDataDir = getDataDir(dataDir)

  return {
    name: 'mimocode',
    displayName: 'MiMoCode',

    modelDisplayName(model: string): string {
      const stripped = model.replace(/^[^/]+\//, '')
      return getShortModelName(stripped)
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    // Both the legacy JSON store (storage/session/*.json) and the SQLite DB
    // (mimicode*.db) live under this one data dir.
    async probeRoots(): Promise<ProbeRoot[]> {
      return [{ path: resolvedDataDir, label: 'data' }]
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const fileSessions = await discoverOpenCodeFileSessions(resolvedDataDir, 'mimocode')
      const sqliteSessions = await discoverSqliteSessions(sqliteConfig)
      return [...fileSessions, ...sqliteSessions]
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      if (source.path.endsWith('.json')) {
        return createOpenCodeFileSessionParser(source, seenKeys, resolvedDataDir, 'mimocode')
      }
      return createSqliteSessionParser(source, seenKeys, sqliteConfig)
    },
  }
}

export const mimocode = createMiMoCodeProvider()
