#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_PATH = resolve(ROOT, 'data.json');
const LOG_PATH = resolve(ROOT, 'research-log.json');

function loadData() {
  return JSON.parse(readFileSync(DATA_PATH, 'utf8'));
}

function loadLog() {
  return JSON.parse(readFileSync(LOG_PATH, 'utf8'));
}

function saveData(data) {
  data.meta.updated = new Date().toISOString().split('T')[0];
  data.meta.totalChannels = data.channels.length;
  writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + '\n');
}

function saveLog(log) {
  writeFileSync(LOG_PATH, JSON.stringify(log, null, 2) + '\n');
}

// === Commands ===

function dedup(handle) {
  const data = loadData();
  const normalized = handle.toLowerCase().replace(/^@/, '');
  const found = data.channels.find(ch =>
    ch.handle.toLowerCase().replace(/^@/, '') === normalized
  );
  if (found) {
    console.log(`DUPLICATE: "${found.name}" (${found.handle}) — status: ${found.status}`);
    return true;
  }
  console.log(`OK: ${handle} is new`);
  return false;
}

function coverage() {
  const data = loadData();
  const log = loadLog();

  const statusCounts = {};
  data.channels.forEach(ch => {
    statusCounts[ch.status] = (statusCounts[ch.status] || 0) + 1;
  });

  console.log('\n=== 채널 현황 ===');
  console.log(`전체: ${data.channels.length}`);
  Object.entries(statusCounts).forEach(([s, n]) => console.log(`  ${s}: ${n}`));

  console.log('\n=== 카테고리별 커버리지 ===');
  const cm = log.coverageMap;
  Object.entries(cm)
    .sort((a, b) => parseInt(a[1].coverage) - parseInt(b[1].coverage))
    .forEach(([cat, info]) => {
      const bar = '█'.repeat(Math.round(parseInt(info.coverage) / 5)) + '░'.repeat(20 - Math.round(parseInt(info.coverage) / 5));
      console.log(`  ${cat.padEnd(6)} ${bar} ${info.coverage.padStart(4)} ${info.searchDone ? '✓검색' : '○검색'} ${info.relatedDone ? '✓관련' : '○관련'} ${info.lastDate || '미탐색'}`);
    });

  console.log('\n=== 추천 다음 액션 ===');
  const lowest = Object.entries(cm).sort((a, b) => parseInt(a[1].coverage) - parseInt(b[1].coverage))[0];
  const noRelated = Object.entries(cm).filter(([, v]) => !v.relatedDone && v.searchDone);

  if (parseInt(lowest[1].coverage) < 30) {
    console.log(`  → Layer 1 (키워드 검색): "${lowest[0]}" 카테고리 (${lowest[1].coverage})`);
  } else if (noRelated.length > 0) {
    console.log(`  → Layer 2 (관련 채널 탐색): "${noRelated[0][0]}" 카테고리`);
  } else {
    console.log(`  → Layer 3 (게스트 교차 분석)`);
  }
}

function nextQueries(count = 5) {
  const log = loadLog();
  const planned = log.queryBank.planned.slice(0, count);
  console.log(`\n=== 미사용 검색어 (${count}개) ===`);
  planned.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));
  console.log(`\n남은 검색어: ${log.queryBank.planned.length}개`);
}

function addChannel(jsonStr) {
  const data = loadData();
  const ch = JSON.parse(jsonStr);

  // check duplicate
  const normalized = ch.handle.toLowerCase().replace(/^@/, '');
  const existing = data.channels.find(c => c.handle.toLowerCase().replace(/^@/, '') === normalized);
  if (existing) {
    console.log(`SKIP: "${existing.name}" already exists`);
    return;
  }

  // fill defaults
  ch.added = ch.added || new Date().toISOString().split('T')[0];
  ch.discoveredVia = ch.discoveredVia || 'search';
  ch.discoverySource = ch.discoverySource || '';
  ch.lastChecked = ch.lastChecked || ch.added;
  ch.tags = ch.tags || [];
  ch.guestOverlap = ch.guestOverlap || [];
  ch.status = ch.status || '후보';

  data.channels.push(ch);
  saveData(data);
  console.log(`ADDED: "${ch.name}" (${ch.handle}) → ${ch.cat} / ${ch.status}`);
}

function logSession(jsonStr) {
  const log = loadLog();
  const session = JSON.parse(jsonStr);

  session.id = session.id || `${new Date().toISOString().split('T')[0]}-${String(log.sessions.length + 1).padStart(2, '0')}`;
  session.date = session.date || new Date().toISOString().split('T')[0];

  log.sessions.push(session);

  // move used queries
  if (session.queries) {
    session.queries.forEach(q => {
      if (!log.queryBank.used.includes(q)) log.queryBank.used.push(q);
      log.queryBank.planned = log.queryBank.planned.filter(p => p !== q);
    });
  }

  saveLog(log);
  console.log(`LOGGED: session ${session.id} — ${session.channelsAdded || 0} channels added`);
}

function stats() {
  const data = loadData();
  const log = loadLog();

  console.log('\n=== 리서치 통계 ===');
  console.log(`총 채널: ${data.channels.length}`);
  console.log(`총 세션: ${log.sessions.length}`);
  console.log(`사용한 검색어: ${log.queryBank.used.length}`);
  console.log(`남은 검색어: ${log.queryBank.planned.length}`);

  const catCount = {};
  data.channels.filter(c => c.status !== '제외').forEach(c => {
    catCount[c.cat] = (catCount[c.cat] || 0) + 1;
  });
  console.log('\n카테고리별 후보 수:');
  Object.entries(catCount).sort((a, b) => b[1] - a[1]).forEach(([c, n]) => {
    console.log(`  ${c}: ${n}`);
  });
}

// === CLI Router ===
const [,, cmd, ...args] = process.argv;

switch (cmd) {
  case 'dedup':
    dedup(args[0]);
    break;
  case 'coverage':
    coverage();
    break;
  case 'next-queries':
    nextQueries(parseInt(args[0]) || 5);
    break;
  case 'add':
    addChannel(args[0]);
    break;
  case 'log':
    logSession(args[0]);
    break;
  case 'stats':
    stats();
    break;
  default:
    console.log(`
팟캐스트 리서치 CLI

사용법:
  node scripts/discover.mjs dedup @handle        중복 체크
  node scripts/discover.mjs coverage             커버리지 요약 + 추천
  node scripts/discover.mjs next-queries [N]     미사용 검색어 N개
  node scripts/discover.mjs add '{"name":...}'   채널 추가
  node scripts/discover.mjs log '{"strategy":..}'세션 기록
  node scripts/discover.mjs stats                전체 통계
    `);
}
