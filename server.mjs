import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(resolve(__dirname, 'research.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const app = new Hono();
app.use('/api/*', cors());

// ============ API ============

// 전체 현황
app.get('/api/status', (c) => {
  const byStatus = db.prepare(`SELECT status, COUNT(*) as cnt FROM channels GROUP BY status`).all();
  const byCat = db.prepare(`SELECT cat, COUNT(*) as cnt FROM channels WHERE status != '제외' GROUP BY cat ORDER BY cnt DESC`).all();
  const coverage = db.prepare(`SELECT * FROM coverage ORDER BY pct`).all();
  const total = db.prepare(`SELECT COUNT(*) as n FROM channels`).get();
  const nextQueries = db.prepare(`SELECT query FROM query_bank WHERE status = 'planned' LIMIT 3`).all();
  return c.json({ byStatus, byCat, coverage, total: total.n, nextQueries: nextQueries.map(q => q.query) });
});

// 채널 조회
app.get('/api/channels', (c) => {
  const { status, cat, diff, limit } = c.req.query();
  let where = ['1=1'];
  if (status) where.push(`status = '${status}'`);
  if (cat) where.push(`cat = '${cat}'`);
  if (diff) where.push(`diff = '${diff}'`);
  const lim = limit ? `LIMIT ${limit}` : '';
  const rows = db.prepare(`SELECT * FROM channels WHERE ${where.join(' AND ')} ORDER BY fit_score DESC, added_at DESC ${lim}`).all();
  return c.json(rows);
});

// 채널 추가
app.post('/api/channels', async (c) => {
  const ch = await c.req.json();
  const existing = db.prepare(`SELECT id FROM channels WHERE LOWER(REPLACE(handle,'@','')) = LOWER(REPLACE(?,'@',''))`).get(ch.handle);
  if (existing) return c.json({ error: 'duplicate', handle: ch.handle }, 409);
  const stmt = db.prepare(`INSERT INTO channels (name, handle, url, subs, avg_views, cat, email, insta, diff, status, note, added_at, discovered_via, discovery_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, date('now'), ?, ?)`);
  const r = stmt.run(ch.name, ch.handle, ch.url || '', ch.subs || '', ch.avg || '', ch.cat || '기타', ch.email || '', ch.insta || '', ch.diff || '중간', ch.status || '후보', ch.note || '', ch.via || 'search', ch.source || '');
  return c.json({ ok: true, id: r.lastInsertRowid });
});

// 채널 수정
app.put('/api/channels/:handle', async (c) => {
  const handle = decodeURIComponent(c.req.param('handle'));
  const updates = await c.req.json();
  const sets = Object.entries(updates).map(([k, v]) => `${k} = '${String(v).replace(/'/g, "''")}'`);
  sets.push(`updated_at = datetime('now')`);
  db.prepare(`UPDATE channels SET ${sets.join(', ')} WHERE handle = ?`).run(handle);
  return c.json({ ok: true });
});

// 컨택 기록
app.post('/api/channels/:handle/contact', async (c) => {
  const handle = decodeURIComponent(c.req.param('handle'));
  const body = await c.req.json();
  const ch = db.prepare(`SELECT id, name FROM channels WHERE handle = ?`).get(handle);
  if (!ch) return c.json({ error: 'not found' }, 404);
  db.prepare(`UPDATE channels SET status = '컨택중', updated_at = datetime('now') WHERE id = ?`).run(ch.id);
  db.prepare(`INSERT INTO outreach (channel_id, type, subject, message, followup_needed, followup_date)
    VALUES (?, ?, '게스트 출연 제안', ?, 1, date('now', '+7 days'))`).run(ch.id, body.type || 'email', body.message || '');
  return c.json({ ok: true, name: ch.name, followup: '7일 후' });
});

// 응답 기록
app.post('/api/channels/:handle/respond', async (c) => {
  const handle = decodeURIComponent(c.req.param('handle'));
  const body = await c.req.json();
  const ch = db.prepare(`SELECT id FROM channels WHERE handle = ?`).get(handle);
  if (!ch) return c.json({ error: 'not found' }, 404);
  const newStatus = body.result === '긍정' ? '응답' : body.result === '부정' ? '보류' : '후보';
  db.prepare(`UPDATE channels SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(newStatus, ch.id);
  db.prepare(`UPDATE outreach SET result = ?, response_at = datetime('now'), followup_needed = 0 WHERE channel_id = ? AND result IS NULL`).run(body.result, ch.id);
  return c.json({ ok: true, status: newStatus });
});

// 확정
app.post('/api/channels/:handle/confirm', async (c) => {
  const handle = decodeURIComponent(c.req.param('handle'));
  db.prepare(`UPDATE channels SET status = '확정', updated_at = datetime('now') WHERE handle = ?`).run(handle);
  return c.json({ ok: true });
});

// 팔로업 목록
app.get('/api/followups', (c) => {
  const rows = db.prepare(`SELECT c.name, c.handle, c.cat, c.email, c.insta, o.type, o.sent_at, o.followup_date
    FROM outreach o JOIN channels c ON c.id = o.channel_id
    WHERE o.followup_needed = 1 AND o.result IS NULL ORDER BY o.followup_date`).all();
  return c.json(rows);
});

// 퍼널
app.get('/api/funnel', (c) => {
  const rows = db.prepare(`SELECT cat,
    COUNT(*) FILTER (WHERE status != '제외') as total,
    COUNT(*) FILTER (WHERE status = '후보') as candidates,
    COUNT(*) FILTER (WHERE status = '컨택중') as contacted,
    COUNT(*) FILTER (WHERE status = '응답') as responded,
    COUNT(*) FILTER (WHERE status = '확정') as confirmed
    FROM channels GROUP BY cat`).all();
  return c.json(rows);
});

// 커버리지
app.get('/api/coverage', (c) => {
  return c.json(db.prepare(`SELECT * FROM coverage ORDER BY pct`).all());
});

// 검색어
app.get('/api/next-queries', (c) => {
  const n = parseInt(c.req.query('n')) || 5;
  return c.json(db.prepare(`SELECT query, category FROM query_bank WHERE status = 'planned' LIMIT ?`).all(n));
});

// 스케줄
app.get('/api/schedule', (c) => {
  const rows = db.prepare(`SELECT s.*, c.name as channel_name, c.handle FROM schedule s LEFT JOIN channels c ON c.id = s.channel_id ORDER BY s.date`).all();
  return c.json(rows);
});

app.post('/api/schedule', async (c) => {
  const s = await c.req.json();
  const r = db.prepare(`INSERT INTO schedule (channel_id, type, title, date, time, location, status, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(s.channel_id || null, s.type || '', s.title, s.date, s.time || '', s.location || '', s.status || '예정', s.note || '');
  return c.json({ ok: true, id: r.lastInsertRowid });
});

// 세션 기록
app.post('/api/sessions', async (c) => {
  const s = await c.req.json();
  db.prepare(`INSERT INTO sessions (date, strategy, queries, categories, channels_found, channels_added, note)
    VALUES (date('now'), ?, ?, ?, ?, ?, ?)`).run(s.strategy || 'search', JSON.stringify(s.queries || []), JSON.stringify(s.categories || []), s.found || 0, s.added || 0, s.note || '');
  return c.json({ ok: true });
});

// 빌드 트리거
app.post('/api/build', (c) => {
  try {
    execSync('node build.mjs', { cwd: __dirname, encoding: 'utf8' });
    return c.json({ ok: true, msg: 'Built dist/index.html' });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// ============ 매니저 웹 UI ============

const layout = (title, body) => `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title} - ENT Management</title>
<script src="https://unpkg.com/htmx.org@2.0.4"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f5f5f5;color:#222;line-height:1.5}
nav{background:#111;color:#fff;padding:10px 16px;display:flex;gap:16px;align-items:center;position:sticky;top:0;z-index:10}
nav a{color:#aaa;text-decoration:none;font-size:13px}nav a:hover,nav a.active{color:#fff}
nav .brand{font-weight:700;font-size:15px;color:#fff;margin-right:auto}
.container{max-width:900px;margin:0 auto;padding:16px}
.card{background:#fff;border-radius:10px;padding:16px;margin-bottom:12px;border:1px solid #eee}
.card h3{font-size:14px;margin-bottom:8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}
.stat{text-align:center}.stat .num{font-size:28px;font-weight:700}.stat .label{font-size:11px;color:#888}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:8px;color:#888;font-size:11px;border-bottom:2px solid #eee}
td{padding:8px;border-bottom:1px solid #f0f0f0}
.badge{font-size:10px;padding:2px 6px;border-radius:3px;font-weight:600}
.b-후보{background:#e3f2fd;color:#1565c0}.b-컨택중{background:#fff3e0;color:#e65100}
.b-응답{background:#e8f5e9;color:#2e7d32}.b-확정{background:#2e7d32;color:#fff}
.b-보류{background:#f5f5f5;color:#999}.b-제외{background:#f5f5f5;color:#ccc}
.b-쉬움{background:#e8f5e9;color:#2e7d32}.b-중간{background:#fff3e0;color:#e65100}.b-높음{background:#fce4ec;color:#c62828}
.bar{height:6px;background:#eee;border-radius:3px;overflow:hidden;margin-top:4px}
.bar-fill{height:100%;border-radius:3px}
a.btn{display:inline-block;padding:4px 10px;border-radius:6px;font-size:11px;text-decoration:none;background:#111;color:#fff}
.tabs{display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap}
.tabs a{padding:5px 12px;border-radius:16px;font-size:12px;text-decoration:none;border:1px solid #ddd;color:#666}
.tabs a.on{background:#111;color:#fff;border-color:#111}
</style></head><body>
<nav>
  <span class="brand">ENT</span>
  <a href="/">대시보드</a>
  <a href="/channels">채널</a>
  <a href="/outreach">아웃리치</a>
  <a href="/schedule">스케줄</a>
</nav>
<div class="container">${body}</div>
</body></html>`;

// 대시보드
app.get('/', (c) => {
  const byStatus = db.prepare(`SELECT status, COUNT(*) as cnt FROM channels GROUP BY status ORDER BY CASE status WHEN '확정' THEN 1 WHEN '응답' THEN 2 WHEN '컨택중' THEN 3 WHEN '후보' THEN 4 WHEN '보류' THEN 5 WHEN '제외' THEN 6 END`).all();
  const coverage = db.prepare(`SELECT * FROM coverage ORDER BY pct`).all();
  const followups = db.prepare(`SELECT c.name, c.handle, o.followup_date FROM outreach o JOIN channels c ON c.id = o.channel_id WHERE o.followup_needed = 1 AND o.result IS NULL ORDER BY o.followup_date LIMIT 5`).all();
  const upcoming = db.prepare(`SELECT s.*, c.name as channel_name FROM schedule s LEFT JOIN channels c ON c.id = s.channel_id WHERE s.date >= date('now') ORDER BY s.date LIMIT 5`).all();

  let html = '<div class="grid">';
  byStatus.forEach(s => { html += `<div class="card stat"><div class="num">${s.cnt}</div><div class="label"><span class="badge b-${s.status}">${s.status}</span></div></div>`; });
  html += '</div>';

  html += '<div class="card"><h3>커버리지</h3>';
  coverage.forEach(cv => {
    const color = cv.pct >= 60 ? '#4caf50' : cv.pct >= 30 ? '#ff9800' : '#f44336';
    html += `<div style="display:flex;align-items:center;gap:8px;margin:4px 0"><span style="width:50px;font-size:12px">${cv.cat}</span><div class="bar" style="flex:1"><div class="bar-fill" style="width:${cv.pct}%;background:${color}"></div></div><span style="font-size:11px;color:#888">${cv.pct}%</span></div>`;
  });
  html += '</div>';

  if (followups.length) {
    html += '<div class="card"><h3>팔로업 필요</h3><table><tr><th>채널</th><th>핸들</th><th>팔로업일</th></tr>';
    followups.forEach(f => { html += `<tr><td>${f.name}</td><td>${f.handle}</td><td>${f.followup_date || '-'}</td></tr>`; });
    html += '</table></div>';
  }

  if (upcoming.length) {
    html += '<div class="card"><h3>다가오는 스케줄</h3><table><tr><th>날짜</th><th>제목</th><th>채널</th><th>상태</th></tr>';
    upcoming.forEach(s => { html += `<tr><td>${s.date}</td><td>${s.title}</td><td>${s.channel_name || '-'}</td><td><span class="badge">${s.status}</span></td></tr>`; });
    html += '</table></div>';
  }

  return c.html(layout('대시보드', html));
});

// 채널 목록
app.get('/channels', (c) => {
  const status = c.req.query('status') || '';
  const cat = c.req.query('cat') || '';
  let where = ["status != '제외'"];
  if (status) where.push(`status = '${status}'`);
  if (cat) where.push(`cat = '${cat}'`);
  const rows = db.prepare(`SELECT * FROM channels WHERE ${where.join(' AND ')} ORDER BY fit_score DESC, added_at DESC`).all();
  const cats = db.prepare(`SELECT DISTINCT cat FROM channels WHERE status != '제외'`).all().map(r => r.cat);
  const statuses = ['후보', '컨택중', '응답', '확정', '보류'];

  let html = '<div class="tabs"><a href="/channels" class="' + (!status && !cat ? 'on' : '') + '">전체 (' + rows.length + ')</a>';
  statuses.forEach(s => { html += `<a href="/channels?status=${s}" class="${status === s ? 'on' : ''}">${s}</a>`; });
  html += '</div><div class="tabs">';
  cats.forEach(ct => { html += `<a href="/channels?cat=${ct}" class="${cat === ct ? 'on' : ''}">${ct}</a>`; });
  html += '</div>';

  html += '<table><thead><tr><th>채널</th><th>카테고리</th><th>구독자</th><th>난이도</th><th>상태</th><th>스코어</th><th>연락처</th></tr></thead><tbody>';
  rows.forEach(r => {
    html += `<tr>
      <td><a href="${r.url}" target="_blank" style="color:#111;font-weight:600">${r.name}</a><br><span style="color:#aaa;font-size:11px">${r.handle}</span></td>
      <td><span style="font-size:12px">${r.cat}</span></td>
      <td style="font-size:12px">${r.subs}</td>
      <td><span class="badge b-${r.diff}">${r.diff}</span></td>
      <td><span class="badge b-${r.status}">${r.status}</span></td>
      <td style="font-size:12px">${r.fit_score || '-'}</td>
      <td style="font-size:11px">${r.email ? `<a href="mailto:${r.email}">${r.email}</a>` : ''}${r.insta ? ` <a href="https://instagram.com/${r.insta.replace('@', '')}" target="_blank">${r.insta}</a>` : ''}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  return c.html(layout('채널', html));
});

// 아웃리치
app.get('/outreach', (c) => {
  const rows = db.prepare(`SELECT o.*, c.name, c.handle FROM outreach o JOIN channels c ON c.id = o.channel_id ORDER BY o.sent_at DESC`).all();
  let html = '<table><thead><tr><th>날짜</th><th>채널</th><th>유형</th><th>방향</th><th>결과</th><th>팔로업</th></tr></thead><tbody>';
  if (!rows.length) html += '<tr><td colspan="6" style="text-align:center;color:#aaa;padding:40px">아직 아웃리치 기록 없음</td></tr>';
  rows.forEach(r => {
    html += `<tr><td style="font-size:12px">${r.sent_at?.split('T')[0] || '-'}</td><td>${r.name} <span style="color:#aaa;font-size:11px">${r.handle}</span></td><td>${r.type}</td><td>${r.direction}</td><td>${r.result || '-'}</td><td>${r.followup_needed ? `<span style="color:#e65100">${r.followup_date || '필요'}</span>` : '-'}</td></tr>`;
  });
  html += '</tbody></table>';
  return c.html(layout('아웃리치', html));
});

// 스케줄
app.get('/schedule', (c) => {
  const rows = db.prepare(`SELECT s.*, c.name as channel_name, c.handle FROM schedule s LEFT JOIN channels c ON c.id = s.channel_id ORDER BY s.date`).all();
  let html = '<table><thead><tr><th>날짜</th><th>시간</th><th>제목</th><th>채널</th><th>장소</th><th>상태</th></tr></thead><tbody>';
  if (!rows.length) html += '<tr><td colspan="6" style="text-align:center;color:#aaa;padding:40px">스케줄 없음</td></tr>';
  rows.forEach(r => {
    html += `<tr><td>${r.date}</td><td>${r.time || '-'}</td><td style="font-weight:600">${r.title}</td><td>${r.channel_name || '-'}</td><td>${r.location || '-'}</td><td><span class="badge">${r.status}</span></td></tr>`;
  });
  html += '</tbody></table>';
  return c.html(layout('스케줄', html));
});

// ============ Start ============
const port = 4000;
serve({ fetch: app.fetch, port }, () => {
  console.log(`\n  ENT Management Server`);
  console.log(`  ├─ 매니저 UI:  http://localhost:${port}`);
  console.log(`  ├─ API:        http://localhost:${port}/api/status`);
  console.log(`  └─ DB:         research.db\n`);
});
