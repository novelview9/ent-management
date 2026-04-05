#!/usr/bin/env node
/**
 * 팟캐스트 리서치 CLI (SQLite)
 *
 * 수집:  db.mjs search / add / dedup / related
 * 진행:  db.mjs contact / followup / respond
 * 현황:  db.mjs status / funnel / week / export
 */
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DB = resolve(ROOT, 'research.db');

function sql(query, mode = '') {
  const flags = mode === 'json' ? '-json' : mode === 'column' ? '-column -header' : '';
  try {
    return execSync(`sqlite3 ${flags} "${DB}" "${query.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
  } catch (e) {
    console.error('SQL Error:', e.stderr || e.message);
    return '';
  }
}

function jsonQuery(query) {
  const result = sql(query, 'json');
  return result ? JSON.parse(result) : [];
}

const [,, cmd, ...args] = process.argv;
const today = new Date().toISOString().split('T')[0];

switch (cmd) {

  // ========== 수집 ==========

  case 'dedup': {
    const handle = args[0];
    const h = handle.toLowerCase().replace(/^@/, '');
    const found = sql(`SELECT name, handle, status FROM channels WHERE LOWER(REPLACE(handle,'@','')) = '${h}';`, 'column');
    console.log(found || `OK: ${handle} is new`);
    break;
  }

  case 'add': {
    const ch = JSON.parse(args[0]);
    const esc = (s) => (s || '').replace(/'/g, "''");
    sql(`INSERT OR IGNORE INTO channels (name, handle, url, subs, avg_views, cat, email, insta, diff, status, note, added_at, discovered_via, discovery_source)
VALUES ('${esc(ch.name)}', '${esc(ch.handle)}', '${esc(ch.url)}', '${esc(ch.subs || '')}', '${esc(ch.avg || '')}', '${esc(ch.cat || '기타')}', '${esc(ch.email || '')}', '${esc(ch.insta || '')}', '${esc(ch.diff || '중간')}', '${esc(ch.status || '후보')}', '${esc(ch.note || '')}', '${today}', '${esc(ch.via || 'search')}', '${esc(ch.source || '')}');`);
    console.log(`Added: ${ch.name} (${ch.handle})`);
    break;
  }

  case 'score': {
    // 우선순위 스코어링 업데이트
    const handle = args[0];
    const score = parseInt(args[1]);
    sql(`UPDATE channels SET fit_score = ${score}, updated_at = datetime('now') WHERE handle = '${handle}';`);
    console.log(`Score updated: ${handle} → ${score}/10`);
    break;
  }

  // ========== 진행 ==========

  case 'contact': {
    const handle = args[0];
    const type = args[1] || 'email'; // email/dm/댓글
    const msg = args[2] || '';
    const row = jsonQuery(`SELECT id, name FROM channels WHERE handle = '${handle}';`);
    if (!row.length) { console.log('Channel not found'); break; }
    sql(`UPDATE channels SET status = '컨택중', updated_at = datetime('now') WHERE handle = '${handle}';`);
    sql(`INSERT INTO outreach (channel_id, type, subject, message, followup_needed, followup_date)
VALUES (${row[0].id}, '${type}', '게스트 출연 제안', '${(msg).replace(/'/g, "''")}', 1, date('now', '+7 days'));`);
    console.log(`Contacted: ${row[0].name} via ${type} — followup in 7 days`);
    break;
  }

  case 'respond': {
    const handle = args[0];
    const result = args[1] || '긍정'; // 긍정/부정/보류
    const row = jsonQuery(`SELECT id FROM channels WHERE handle = '${handle}';`);
    if (!row.length) { console.log('Channel not found'); break; }
    const newStatus = result === '긍정' ? '응답' : result === '부정' ? '보류' : '후보';
    sql(`UPDATE channels SET status = '${newStatus}', updated_at = datetime('now') WHERE handle = '${handle}';`);
    sql(`UPDATE outreach SET result = '${result}', response_at = datetime('now'), followup_needed = 0 WHERE channel_id = ${row[0].id} AND result IS NULL;`);
    sql(`INSERT INTO outreach (channel_id, type, direction, message, result) VALUES (${row[0].id}, 'email', 'received', '${result} 응답', '${result}');`);
    console.log(`Response logged: ${handle} → ${result} (status: ${newStatus})`);
    break;
  }

  case 'confirm': {
    const handle = args[0];
    sql(`UPDATE channels SET status = '확정', updated_at = datetime('now') WHERE handle = '${handle}';`);
    console.log(`Confirmed: ${handle}`);
    break;
  }

  case 'followups': {
    console.log('\n=== 팔로업 필요 ===');
    const result = sql(`SELECT c.name, c.handle, c.cat, o.type, o.sent_at, o.followup_date
FROM outreach o JOIN channels c ON c.id = o.channel_id
WHERE o.followup_needed = 1 AND o.result IS NULL
ORDER BY o.followup_date;`, 'column');
    console.log(result || '  없음');
    break;
  }

  // ========== 현황 ==========

  case 'status': {
    console.log('\n=== 채널 현황 ===');
    console.log(sql(`SELECT status, COUNT(*) as cnt FROM channels GROUP BY status ORDER BY CASE status WHEN '확정' THEN 1 WHEN '응답' THEN 2 WHEN '컨택중' THEN 3 WHEN '후보' THEN 4 WHEN '보류' THEN 5 WHEN '제외' THEN 6 END;`, 'column'));

    console.log('\n=== 카테고리별 (제외 빼고) ===');
    console.log(sql(`SELECT cat, COUNT(*) as cnt FROM channels WHERE status != '제외' GROUP BY cat ORDER BY cnt DESC;`, 'column'));

    console.log('\n=== 커버리지 ===');
    console.log(sql(`SELECT cat, pct || '%' as coverage, CASE WHEN search_done THEN 'Y' ELSE '-' END as search, CASE WHEN related_done THEN 'Y' ELSE '-' END as related, last_date FROM coverage ORDER BY pct;`, 'column'));

    console.log('\n=== 추천 액션 ===');
    const lowest = jsonQuery(`SELECT cat, pct FROM coverage ORDER BY pct LIMIT 1;`);
    if (lowest.length) {
      if (lowest[0].pct < 30) console.log(`  → Layer 1 (키워드 검색): "${lowest[0].cat}" (${lowest[0].pct}%)`);
      else console.log(`  → Layer 2/3 (관련채널/게스트분석)`);
    }

    const nextQ = jsonQuery(`SELECT query FROM query_bank WHERE status = 'planned' LIMIT 3;`);
    if (nextQ.length) {
      console.log('\n=== 다음 검색어 ===');
      nextQ.forEach((q, i) => console.log(`  ${i + 1}. ${q.query}`));
    }
    break;
  }

  case 'funnel': {
    console.log('\n=== 퍼널 메트릭 ===');
    console.log(sql(`SELECT * FROM v_funnel;`, 'column'));

    console.log('\n=== 전체 ===');
    const total = jsonQuery(`SELECT COUNT(*) FILTER (WHERE status != '제외') as total, COUNT(*) FILTER (WHERE status = '컨택중') as contacted, COUNT(*) FILTER (WHERE status = '응답') as responded, COUNT(*) FILTER (WHERE status = '확정') as confirmed FROM channels;`);
    if (total.length) {
      const t = total[0];
      console.log(`  후보풀: ${t.total} → 컨택: ${t.contacted} → 응답: ${t.responded} → 확정: ${t.confirmed}`);
    }
    break;
  }

  case 'week': {
    const weekStart = args[0] || today;
    console.log(`\n=== ${weekStart} 주간 현황 ===`);
    const goal = jsonQuery(`SELECT * FROM weekly_goals WHERE week_start = '${weekStart}';`);
    if (goal.length) {
      const g = goal[0];
      console.log(`  리서치: ${g.actual_research}/${g.target_research}`);
      console.log(`  컨택:   ${g.actual_contact}/${g.target_contact}`);
      console.log(`  팔로업: ${g.actual_followup}/${g.target_followup}`);
      console.log(`  응답:   ${g.actual_response}`);
    } else {
      console.log('  목표 미설정. set-week로 설정하세요.');
    }
    break;
  }

  case 'set-week': {
    const weekStart = args[0] || today;
    const research = args[1] || 10;
    const contact = args[2] || 5;
    const followup = args[3] || 3;
    sql(`INSERT OR REPLACE INTO weekly_goals (week_start, target_research, target_contact, target_followup) VALUES ('${weekStart}', ${research}, ${contact}, ${followup});`);
    console.log(`Week ${weekStart}: research=${research}, contact=${contact}, followup=${followup}`);
    break;
  }

  case 'list': {
    const filter = args[0] || '후보';
    const cat = args[1] || '';
    let where = `status = '${filter}'`;
    if (cat) where += ` AND cat = '${cat}'`;
    console.log(sql(`SELECT handle, name, cat, subs, diff, fit_score as score FROM channels WHERE ${where} ORDER BY fit_score DESC, added_at;`, 'column'));
    break;
  }

  case 'top': {
    console.log('\n=== 우선순위 TOP 10 (후보 중) ===');
    console.log(sql(`SELECT handle, name, cat, subs, diff, fit_score as score FROM channels WHERE status = '후보' ORDER BY fit_score DESC, diff = '쉬움' DESC LIMIT 10;`, 'column'));
    break;
  }

  // ========== 내보내기 ==========

  case 'export': {
    const channels = jsonQuery(`SELECT name, handle, url, subs, avg_views as avg, cat, email, insta, diff, status, note, added_at as added, discovered_via as discoveredVia, discovery_source as discoverySource, last_checked as lastChecked, fit_score, tags, guest_overlap as guestOverlap FROM channels ORDER BY CASE status WHEN '확정' THEN 1 WHEN '응답' THEN 2 WHEN '컨택중' THEN 3 WHEN '후보' THEN 4 WHEN '보류' THEN 5 WHEN '제외' THEN 6 END, cat;`);
    const coverage = jsonQuery(`SELECT * FROM coverage;`);
    const sessions = jsonQuery(`SELECT * FROM sessions ORDER BY date DESC;`);
    const funnel = jsonQuery(`SELECT * FROM v_funnel;`);
    const followups = jsonQuery(`SELECT * FROM v_followups;`);

    channels.forEach(ch => {
      try { ch.tags = JSON.parse(ch.tags || '[]'); } catch { ch.tags = []; }
      try { ch.guestOverlap = JSON.parse(ch.guestOverlap || '[]'); } catch { ch.guestOverlap = []; }
    });

    const output = {
      meta: {
        target: '윤담백 @ddd-lab (구독자 8.49K)',
        updated: today,
        totalChannels: channels.length
      },
      channels,
      coverage: Object.fromEntries(coverage.map(c => [c.cat, c])),
      funnel,
      followups,
      sessionCount: sessions.length
    };

    const outPath = resolve(ROOT, 'data.json');
    writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
    console.log(`Exported: ${channels.length} channels → data.json`);
    break;
  }

  default:
    console.log(`
팟캐스트 리서치 CLI (SQLite)

수집:
  db.mjs dedup @handle              중복 체크
  db.mjs add '{"name":..}'          채널 추가
  db.mjs score @handle 8            핏 스코어 (1-10)

진행:
  db.mjs contact @handle email      컨택 기록
  db.mjs respond @handle 긍정       응답 기록 (긍정/부정/보류)
  db.mjs confirm @handle            출연 확정
  db.mjs followups                  팔로업 필요 목록

현황:
  db.mjs status                     전체 현황 + 추천
  db.mjs funnel                     퍼널 메트릭
  db.mjs list 후보 패션              필터 조회
  db.mjs top                        우선순위 TOP 10
  db.mjs week 2026-04-07            주간 목표 현황
  db.mjs set-week 2026-04-07 10 5 3 주간 목표 설정

내보내기:
  db.mjs export                     SQLite → data.json (GitHub Pages)
    `);
}
