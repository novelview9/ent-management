#!/usr/bin/env node
/**
 * DB 초기화 + 기존 data.json → SQLite 마이그레이션
 */
import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DB = resolve(ROOT, 'research.db');
const SCHEMA = resolve(__dirname, 'schema.sql');
const DATA_JSON = resolve(ROOT, 'data.json');
const LOG_JSON = resolve(ROOT, 'research-log.json');

function sql(query) {
  return execSync(`sqlite3 "${DB}" "${query.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
}

function sqlFile(path) {
  execSync(`sqlite3 "${DB}" < "${path}"`, { encoding: 'utf8' });
}

function sqlBatch(statements) {
  const joined = statements.join('\n');
  execSync(`sqlite3 "${DB}"`, { input: joined, encoding: 'utf8' });
}

// 1. Create schema
console.log('1. Creating schema...');
sqlFile(SCHEMA);
console.log('   OK');

// 2. Migrate channels from data.json
if (existsSync(DATA_JSON)) {
  const data = JSON.parse(readFileSync(DATA_JSON, 'utf8'));
  const existing = parseInt(sql("SELECT COUNT(*) FROM channels;")) || 0;

  if (existing === 0) {
    console.log(`2. Migrating ${data.channels.length} channels from data.json...`);
    const stmts = data.channels.map(ch => {
      const esc = (s) => (s || '').replace(/'/g, "''");
      return `INSERT OR IGNORE INTO channels (name, handle, url, subs, avg_views, cat, email, insta, diff, status, note, added_at, discovered_via, discovery_source, last_checked, tags, guest_overlap)
VALUES ('${esc(ch.name)}', '${esc(ch.handle)}', '${esc(ch.url)}', '${esc(ch.subs)}', '${esc(ch.avg)}', '${esc(ch.cat)}', '${esc(ch.email)}', '${esc(ch.insta)}', '${esc(ch.diff)}', '${esc(ch.status)}', '${esc(ch.note)}', '${esc(ch.added || '2026-04-04')}', '${esc(ch.discoveredVia || 'search')}', '${esc(ch.discoverySource || '')}', '${esc(ch.lastChecked || '2026-04-04')}', '${esc(JSON.stringify(ch.tags || []))}', '${esc(JSON.stringify(ch.guestOverlap || []))}');`;
    });
    sqlBatch(stmts);
    console.log(`   OK: ${sql("SELECT COUNT(*) FROM channels;")} channels`);
  } else {
    console.log(`2. Channels already exist (${existing}), skipping migration`);
  }
}

// 3. Migrate research log
if (existsSync(LOG_JSON)) {
  const log = JSON.parse(readFileSync(LOG_JSON, 'utf8'));
  const existingSessions = parseInt(sql("SELECT COUNT(*) FROM sessions;")) || 0;

  if (existingSessions === 0 && log.sessions) {
    console.log(`3. Migrating ${log.sessions.length} sessions...`);
    const stmts = log.sessions.map(s => {
      const esc = (v) => (v || '').replace(/'/g, "''");
      return `INSERT INTO sessions (date, strategy, queries, categories, channels_found, channels_added, note)
VALUES ('${s.date}', '${s.strategy}', '${esc(JSON.stringify(s.queries || []))}', '${esc(JSON.stringify(s.categoriesTargeted || []))}', ${s.channelsFound || 0}, ${s.channelsAdded || 0}, '${esc(s.notes || '')}');`;
    });
    sqlBatch(stmts);
    console.log(`   OK: ${sql("SELECT COUNT(*) FROM sessions;")} sessions`);
  }

  // Migrate query bank
  const existingQueries = parseInt(sql("SELECT COUNT(*) FROM query_bank;")) || 0;
  if (existingQueries === 0 && log.queryBank) {
    console.log('4. Migrating query bank...');
    const stmts = [];
    (log.queryBank.used || []).forEach(q => {
      stmts.push(`INSERT OR IGNORE INTO query_bank (query, status, used_at) VALUES ('${q.replace(/'/g, "''")}', 'used', '2026-04-04');`);
    });
    (log.queryBank.planned || []).forEach(q => {
      stmts.push(`INSERT OR IGNORE INTO query_bank (query, status) VALUES ('${q.replace(/'/g, "''")}', 'planned');`);
    });
    sqlBatch(stmts);
    console.log(`   OK: ${sql("SELECT COUNT(*) FROM query_bank;")} queries`);
  }

  // Migrate coverage
  const existingCov = parseInt(sql("SELECT COUNT(*) FROM coverage;")) || 0;
  if (existingCov === 0 && log.coverageMap) {
    console.log('5. Migrating coverage map...');
    const stmts = Object.entries(log.coverageMap).map(([cat, v]) => {
      return `INSERT OR REPLACE INTO coverage (cat, search_done, related_done, pct, last_date)
VALUES ('${cat}', ${v.searchDone ? 1 : 0}, ${v.relatedDone ? 1 : 0}, ${parseInt(v.coverage) || 0}, ${v.lastDate ? `'${v.lastDate}'` : 'NULL'});`;
    });
    sqlBatch(stmts);
    console.log(`   OK`);
  }
}

// Summary
console.log('\n=== DB Ready ===');
console.log(`Path: ${DB}`);
console.log(sql("SELECT 'channels: ' || COUNT(*) FROM channels UNION ALL SELECT 'sessions: ' || COUNT(*) FROM sessions UNION ALL SELECT 'queries: ' || COUNT(*) FROM query_bank;"));
