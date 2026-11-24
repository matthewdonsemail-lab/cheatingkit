import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { Database } from 'bun:sqlite'

export function databasePath(env = process.env) {
  return env.CHEATINGKIT_DB || join(homedir(), '.cheatingkit', 'sessions.db')
}

export function openDatabase(path = databasePath()) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path, { create: true })
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS sessions (
      harness TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      sourcePath TEXT NOT NULL,
      startedAt TEXT,
      updatedAt TEXT,
      cwd TEXT,
      currentModel TEXT,
      PRIMARY KEY (harness, sessionId)
    );
    CREATE TABLE IF NOT EXISTS messages (
      harness TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      sourceId TEXT NOT NULL,
      sourcePosition INTEGER NOT NULL,
      timestamp TEXT,
      role TEXT NOT NULL,
      body TEXT,
      model TEXT,
      rawType TEXT,
      PRIMARY KEY (harness, sessionId, sourceId),
      FOREIGN KEY (harness, sessionId) REFERENCES sessions(harness, sessionId)
    );
    CREATE TABLE IF NOT EXISTS toolCalls (
      harness TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      sourceId TEXT NOT NULL,
      messageId TEXT,
      timestamp TEXT,
      name TEXT NOT NULL,
      input TEXT,
      output TEXT,
      PRIMARY KEY (harness, sessionId, sourceId)
    );
    CREATE TABLE IF NOT EXISTS timeline (
      harness TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      sourceId TEXT NOT NULL,
      timestamp TEXT,
      kind TEXT NOT NULL,
      detail TEXT NOT NULL,
      PRIMARY KEY (harness, sessionId, sourceId, kind)
    );
    CREATE TABLE IF NOT EXISTS proxyAttempts (
      requestId TEXT PRIMARY KEY,
      startedAt TEXT NOT NULL,
      completedAt TEXT,
      harness TEXT NOT NULL,
      protocol TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      sessionId TEXT,
      sourceId TEXT,
      originalText TEXT,
      proposedText TEXT,
      evidenceSourceIds TEXT NOT NULL DEFAULT '[]',
      analysisMode TEXT,
      analysisReason TEXT,
      analysisApplied INTEGER NOT NULL DEFAULT 0,
      httpStatus INTEGER,
      responseCompleted INTEGER NOT NULL DEFAULT 0,
      responseExcerpt TEXT,
      observation TEXT,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS sourceCursors (
      sourcePath TEXT PRIMARY KEY,
      harness TEXT NOT NULL,
      offsetBytes INTEGER NOT NULL DEFAULT 0,
      sourceSize INTEGER NOT NULL DEFAULT 0,
      sourceModifiedMs REAL NOT NULL DEFAULT 0,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sourceRecords (
      harness TEXT NOT NULL,
      sourcePath TEXT NOT NULL,
      sourcePosition INTEGER NOT NULL,
      sessionId TEXT NOT NULL,
      rawJson TEXT NOT NULL,
      PRIMARY KEY (harness, sourcePath, sourcePosition)
    );
    CREATE TABLE IF NOT EXISTS messageLabels (
      harness TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      sourceId TEXT NOT NULL,
      modelId TEXT NOT NULL,
      label TEXT NOT NULL,
      score REAL NOT NULL,
      labeledAt TEXT NOT NULL,
      PRIMARY KEY (harness, sessionId, sourceId, modelId)
    );
    CREATE TABLE IF NOT EXISTS warningLeadUps (
      harness TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      warningSourceId TEXT NOT NULL,
      sourceId TEXT NOT NULL,
      distance INTEGER NOT NULL,
      PRIMARY KEY (harness, sessionId, warningSourceId, sourceId)
    );
    CREATE TABLE IF NOT EXISTS searchChunks (
      id INTEGER PRIMARY KEY,
      harness TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      chunkStart INTEGER NOT NULL,
      messageIds TEXT NOT NULL,
      text TEXT NOT NULL,
      textHash TEXT NOT NULL,
      modelId TEXT NOT NULL,
      vector BLOB NOT NULL,
      UNIQUE (harness, sessionId, chunkStart)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS searchChunksFts USING fts5(text);
    CREATE TABLE IF NOT EXISTS indexState (
      stage TEXT PRIMARY KEY,
      modelId TEXT NOT NULL,
      indexedAt TEXT NOT NULL,
      chunks INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messagesByTime ON messages(harness, sessionId, timestamp);
    CREATE INDEX IF NOT EXISTS messagesByRolePosition ON messages(harness, sessionId, role, sourcePosition);
    CREATE INDEX IF NOT EXISTS timelineByTime ON timeline(timestamp);
    CREATE INDEX IF NOT EXISTS timelineByKind ON timeline(harness, sessionId, kind, sourceId);
    CREATE INDEX IF NOT EXISTS proxyAttemptsByTime ON proxyAttempts(startedAt DESC);
    CREATE INDEX IF NOT EXISTS proxyAttemptsBySession ON proxyAttempts(harness,sessionId,sourceId);
  `)
  return db
}
