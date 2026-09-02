import { mkdtemp, rm, mkdir } from 'fs/promises'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { isSqliteAvailable } from '../../src/sqlite.js'
import { createMiMoCodeProvider } from '../../src/providers/mimocode.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

type TestDb = {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): void }
  close(): void
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'mimocode-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
  delete process.env['MIMOCODE_DATA_DIR']
  delete process.env['MIMOCODE_DB_PREFIX']
})

// MiMoCode reuses OpenCode's Drizzle schema (session/message/part), just
// under its own data dir and db filename prefix (mimocode*.db by default —
// verified against a real ~460MB install; the filename matches the folder
// name, unlike an earlier version of this provider assumed).
function createTestDb(dir: string, filename = 'mimocode.db'): string {
  const mcDir = join(dir, 'mimocode')
  mkdirSync(mcDir, { recursive: true })
  const dbPath = join(mcDir, filename)

  const { DatabaseSync: Database } = require('node:sqlite')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
      slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL,
      version TEXT NOT NULL, time_created INTEGER, time_updated INTEGER,
      time_archived INTEGER
    )
  `)
  db.exec(`
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL,
      session_id TEXT NOT NULL, time_created INTEGER,
      time_updated INTEGER, data TEXT NOT NULL
    )
  `)
  db.close()
  return dbPath
}

function withTestDb(dbPath: string, fn: (db: TestDb) => void): void {
  const { DatabaseSync: Database } = require('node:sqlite')
  const db = new Database(dbPath)
  fn(db)
  db.close()
}

function insertSession(
  db: TestDb,
  id: string,
  opts: { directory?: string; title?: string; parentId?: string | null; archived?: number | null } = {},
): void {
  db.prepare(`
    INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_archived, parent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, 'proj-1', 'slug-1', opts.directory ?? '/home/user/myproject', opts.title ?? 'My Project', '1.0', 1700000000000, opts.archived ?? null, opts.parentId ?? null)
}

type MessageFixture = {
  role: string
  modelID?: string
  cost?: number
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

type PartFixture = {
  type: string
  text?: string
}

function insertMessage(db: TestDb, id: string, sessionId: string, timeCreated: number, data: MessageFixture): void {
  db.prepare(`INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)`)
    .run(id, sessionId, timeCreated, JSON.stringify(data))
}

function insertPart(db: TestDb, id: string, messageId: string, sessionId: string, data: PartFixture): void {
  db.prepare(`INSERT INTO part (id, message_id, session_id, data) VALUES (?, ?, ?, ?)`)
    .run(id, messageId, sessionId, JSON.stringify(data))
}

async function collectCalls(provider: ReturnType<typeof createMiMoCodeProvider>, dbPath: string, sessionId: string, seenKeys?: Set<string>): Promise<ParsedProviderCall[]> {
  const source = { path: `${dbPath}:${sessionId}`, project: 'myproject', provider: 'mimocode' }
  const calls: ParsedProviderCall[] = []
  for await (const call of provider.createSessionParser(source, seenKeys ?? new Set()).parse()) {
    calls.push(call)
  }
  return calls
}

const skipUnlessSqlite = isSqliteAvailable() ? describe : describe.skip

skipUnlessSqlite('mimocode provider - identity', () => {
  it('has correct name and displayName', () => {
    const provider = createMiMoCodeProvider()
    expect(provider.name).toBe('mimocode')
    expect(provider.displayName).toBe('MiMoCode')
  })

  it('strips provider prefix from model ids like opencode', () => {
    const provider = createMiMoCodeProvider()
    expect(provider.modelDisplayName('anthropic/claude-opus-4-6-20260205')).toBe('Opus 4.6')
    expect(provider.modelDisplayName('gpt-4o')).toBe('GPT-4o')
    expect(provider.modelDisplayName('big-pickle')).toBe('big-pickle')
  })

  it('maps builtin tool names', () => {
    const provider = createMiMoCodeProvider()
    expect(provider.toolDisplayName('bash')).toBe('Bash')
    expect(provider.toolDisplayName('task')).toBe('Agent')
    expect(provider.toolDisplayName('unknown_tool')).toBe('unknown_tool')
  })
})

skipUnlessSqlite('mimocode provider - probeRoots', () => {
  it('reports the resolved data dir', async () => {
    const provider = createMiMoCodeProvider(tmpDir)
    const roots = await provider.probeRoots!()
    expect(roots).toEqual([{ path: join(tmpDir, 'mimocode'), label: 'data' }])
  })
})

skipUnlessSqlite('mimocode provider - session discovery', () => {
  it('discovers sessions from mimocode*.db, not opencode*.db', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
    })

    const provider = createMiMoCodeProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.provider).toBe('mimocode')
    expect(sessions[0]!.project).toBe('home-user-myproject')
    expect(sessions[0]!.path).toBe(`${dbPath}:sess-1`)
  })

  it('ignores an opencode.db sitting in the same dir (different prefix)', async () => {
    createTestDb(tmpDir, 'opencode.db')
    const mimocodeDb = createTestDb(tmpDir, 'mimocode.db')
    withTestDb(mimocodeDb, (db) => {
      insertSession(db, 'sess-1')
    })

    const provider = createMiMoCodeProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toEqual([{ path: `${mimocodeDb}:sess-1`, project: 'home-user-myproject', provider: 'mimocode' }])
  })

  // Regression test for the real bug this session found: a second,
  // unrelated mimocode.db lives under <dataDir>/memory/ on a real install
  // (the client's long-term-memory store, not session history). Discovery
  // must only read direct children of dataDir, never recurse into it.
  it('does not descend into a nested memory/ dir holding its own mimocode.db', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
    })
    const memoryDir = join(tmpDir, 'mimocode', 'memory')
    await mkdir(memoryDir, { recursive: true })
    const { DatabaseSync: Database } = require('node:sqlite')
    const memoryDb = new Database(join(memoryDir, 'mimocode.db'))
    memoryDb.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
      slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL,
      version TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)`)
    memoryDb.prepare(`INSERT INTO session (id, project_id, slug, directory, title, version, time_created)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run('sess-memory', 'proj-1', 'slug-1', '/home/user/other', 'Other', '1.0', 1700000000000)
    memoryDb.close()

    const provider = createMiMoCodeProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toEqual([{ path: `${dbPath}:sess-1`, project: 'home-user-myproject', provider: 'mimocode' }])
  })

  it('excludes archived and child sessions', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-archived', { archived: 1700000001000 })
      insertSession(db, 'sess-child', { parentId: 'parent-id' })
    })

    const provider = createMiMoCodeProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toEqual([])
  })

  it('returns empty for a non-existent path', async () => {
    const provider = createMiMoCodeProvider('/nonexistent/path')
    const sessions = await provider.discoverSessions()
    expect(sessions).toEqual([])
  })

  it('honors MIMOCODE_DATA_DIR as the exact dir (no mimocode suffix appended)', async () => {
    const forkDir = join(tmpDir, 'custom-mimo-location')
    await mkdir(forkDir, { recursive: true })
    const { DatabaseSync: Database } = require('node:sqlite')
    const dbPath = join(forkDir, 'mimocode.db')
    const db = new Database(dbPath)
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
      slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL,
      version TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)`)
    db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL)`)
    db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL,
      session_id TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL)`)
    db.prepare(`INSERT INTO session (id, project_id, slug, directory, title, version, time_created)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run('sess-env', 'proj-1', 'slug-1', '/home/user/myproject', 'My Project', '1.0', 1700000000000)
    db.close()

    process.env['MIMOCODE_DATA_DIR'] = forkDir
    const provider = createMiMoCodeProvider() // no arg — must read env
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.path).toBe(`${dbPath}:sess-env`)
  })

  it('honors MIMOCODE_DB_PREFIX for a renamed db file', async () => {
    const forkDir = join(tmpDir, 'mimocode')
    await mkdir(forkDir, { recursive: true })
    const { DatabaseSync: Database } = require('node:sqlite')
    const dbPath = join(forkDir, 'mimocode-canary.db')
    const db = new Database(dbPath)
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
      slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL,
      version TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)`)
    db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL)`)
    db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL,
      session_id TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL)`)
    db.prepare(`INSERT INTO session (id, project_id, slug, directory, title, version, time_created)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run('sess-prefix', 'proj-1', 'slug-1', '/home/user/myproject', 'My Project', '1.0', 1700000000000)
    db.close()

    process.env['MIMOCODE_DB_PREFIX'] = 'mimocode-canary'
    const provider = createMiMoCodeProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.path).toBe(`${dbPath}:sess-prefix`)
  })
})

skipUnlessSqlite('mimocode provider - parsing', () => {
  it('parses tokens, cost, and tools from an assistant message', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 'msg-1', 'sess-1', 1700000001000, {
        role: 'assistant',
        modelID: 'anthropic/claude-opus-4-6-20260205',
        cost: 0.05,
        tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 10, write: 5 } },
      })
      insertPart(db, 'part-1', 'msg-1', 'sess-1', { type: 'text', text: 'done' })
    })

    const provider = createMiMoCodeProvider(tmpDir)
    const calls = await collectCalls(provider, dbPath, 'sess-1')

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.provider).toBe('mimocode')
    expect(call.model).toBe('anthropic/claude-opus-4-6-20260205')
    expect(call.inputTokens).toBe(100)
    expect(call.outputTokens).toBe(20)
    expect(call.cacheReadInputTokens).toBe(10)
    expect(call.cacheCreationInputTokens).toBe(5)
    expect(call.deduplicationKey).toBe('mimocode:sess-1:msg-1')
  })

  it('deduplicates on <provider>:<sessionId>:<messageId>', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 'msg-1', 'sess-1', 1700000001000, {
        role: 'assistant', modelID: 'gpt-4o',
        tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      insertPart(db, 'part-1', 'msg-1', 'sess-1', { type: 'text', text: 'hi' })
    })

    const provider = createMiMoCodeProvider(tmpDir)
    const seenKeys = new Set<string>()
    const first = await collectCalls(provider, dbPath, 'sess-1', seenKeys)
    const second = await collectCalls(provider, dbPath, 'sess-1', seenKeys)
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(0)
  })

  it('never throws on a missing/corrupt db and yields nothing', async () => {
    const provider = createMiMoCodeProvider(tmpDir)
    const calls = await collectCalls(provider, join(tmpDir, 'mimocode', 'does-not-exist.db'), 'sess-x')
    expect(calls).toEqual([])
  })
})
