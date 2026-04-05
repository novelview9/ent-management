import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(resolve(__dirname, 'research.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const app = new Hono();
app.use('/api/*', cors());

// ===================== API =====================

app.get('/api/status', (c) => {
  const byStatus = db.prepare(`SELECT status, COUNT(*) as cnt FROM channels GROUP BY status`).all();
  const byCat = db.prepare(`SELECT cat, COUNT(*) as cnt FROM channels WHERE status NOT IN ('제외','출연불가') GROUP BY cat ORDER BY cnt DESC`).all();
  const coverage = db.prepare(`SELECT * FROM coverage ORDER BY pct`).all();
  const total = db.prepare(`SELECT COUNT(*) as n FROM channels`).get();
  const nextQueries = db.prepare(`SELECT query FROM query_bank WHERE status = 'planned' LIMIT 3`).all();
  return c.json({ byStatus, byCat, coverage, total: total.n, nextQueries: nextQueries.map(q => q.query) });
});

app.get('/api/channels', (c) => {
  const { status, cat, diff, limit: lim, q } = c.req.query();
  let where = ['1=1'];
  if (status) where.push(`status = '${status}'`);
  if (cat) where.push(`cat = '${cat}'`);
  if (diff) where.push(`diff = '${diff}'`);
  if (q) where.push(`(name LIKE '%${q}%' OR handle LIKE '%${q}%' OR note LIKE '%${q}%')`);
  const limit = lim ? `LIMIT ${lim}` : '';
  return c.json(db.prepare(`SELECT * FROM channels WHERE ${where.join(' AND ')} ORDER BY fit_score DESC, added_at DESC ${limit}`).all());
});

app.get('/api/channels/:handle', (c) => {
  const handle = decodeURIComponent(c.req.param('handle'));
  const ch = db.prepare(`SELECT * FROM channels WHERE handle = ?`).get(handle);
  if (!ch) return c.json({ error: 'not found' }, 404);
  const outreach = db.prepare(`SELECT * FROM outreach WHERE channel_id = ? ORDER BY sent_at DESC`).all(ch.id);
  const schedules = db.prepare(`SELECT * FROM schedule WHERE channel_id = ? ORDER BY date`).all(ch.id);
  return c.json({ ...ch, outreach, schedules });
});

app.post('/api/channels', async (c) => {
  const ch = await c.req.json();
  const existing = db.prepare(`SELECT id FROM channels WHERE LOWER(REPLACE(handle,'@','')) = LOWER(REPLACE(?,'@',''))`).get(ch.handle);
  if (existing) return c.json({ error: 'duplicate', handle: ch.handle }, 409);
  const esc = (v) => v || '';
  const r = db.prepare(`INSERT INTO channels (name, handle, url, subs, avg_views, cat, email, insta, diff, status, note, added_at, discovered_via, discovery_source, fit_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, date('now'), ?, ?, ?)`).run(
    ch.name, ch.handle, esc(ch.url), esc(ch.subs), esc(ch.avg), ch.cat || '기타',
    esc(ch.email), esc(ch.insta), ch.diff || '중간', ch.status || '후보', esc(ch.note),
    ch.via || 'search', esc(ch.source), ch.fit_score || 0);
  return c.json({ ok: true, id: r.lastInsertRowid });
});

app.put('/api/channels/:handle', async (c) => {
  const handle = decodeURIComponent(c.req.param('handle'));
  const u = await c.req.json();
  const allowed = ['name','status','cat','diff','email','insta','note','fit_score','subs','avg_views','last_upload','guest_frequency','url','is_podcast'];
  const sets = Object.entries(u).filter(([k]) => allowed.includes(k)).map(([k, v]) => `${k} = '${String(v).replace(/'/g, "''")}'`);
  if (!sets.length) return c.json({ error: 'no valid fields' }, 400);
  sets.push(`updated_at = datetime('now')`);
  db.prepare(`UPDATE channels SET ${sets.join(', ')} WHERE handle = ?`).run(handle);
  return c.json({ ok: true });
});

app.delete('/api/channels/:handle', (c) => {
  const handle = decodeURIComponent(c.req.param('handle'));
  db.prepare(`DELETE FROM channels WHERE handle = ?`).run(handle);
  return c.json({ ok: true });
});

app.post('/api/channels/:handle/contact', async (c) => {
  const handle = decodeURIComponent(c.req.param('handle'));
  const body = await c.req.json();
  const ch = db.prepare(`SELECT id, name FROM channels WHERE handle = ?`).get(handle);
  if (!ch) return c.json({ error: 'not found' }, 404);
  db.prepare(`UPDATE channels SET status = '컨택중', updated_at = datetime('now') WHERE id = ?`).run(ch.id);
  db.prepare(`INSERT INTO outreach (channel_id, type, subject, message, followup_needed, followup_date)
    VALUES (?, ?, ?, ?, 1, date('now', '+7 days'))`).run(ch.id, body.type || 'email', body.subject || '게스트 출연 제안', body.message || '');
  return c.json({ ok: true, name: ch.name });
});

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

app.post('/api/channels/:handle/confirm', (c) => {
  const handle = decodeURIComponent(c.req.param('handle'));
  db.prepare(`UPDATE channels SET status = '확정', updated_at = datetime('now') WHERE handle = ?`).run(handle);
  return c.json({ ok: true });
});

app.get('/api/followups', (c) => {
  return c.json(db.prepare(`SELECT c.name, c.handle, c.cat, c.email, c.insta, o.type, o.sent_at, o.followup_date, o.id as outreach_id
    FROM outreach o JOIN channels c ON c.id = o.channel_id WHERE o.followup_needed = 1 AND o.result IS NULL ORDER BY o.followup_date`).all());
});

app.get('/api/funnel', (c) => {
  return c.json(db.prepare(`SELECT cat, COUNT(*) FILTER (WHERE status NOT IN ('제외','출연불가')) as total, COUNT(*) FILTER (WHERE status = '후보') as candidates, COUNT(*) FILTER (WHERE status = '컨택중') as contacted, COUNT(*) FILTER (WHERE status = '응답') as responded, COUNT(*) FILTER (WHERE status = '확정') as confirmed FROM channels GROUP BY cat`).all());
});

app.get('/api/coverage', (c) => c.json(db.prepare(`SELECT * FROM coverage ORDER BY pct`).all()));

app.get('/api/next-queries', (c) => {
  const n = parseInt(c.req.query('n')) || 5;
  return c.json(db.prepare(`SELECT id, query, category FROM query_bank WHERE status = 'planned' LIMIT ?`).all(n));
});

app.get('/api/schedule', (c) => {
  return c.json(db.prepare(`SELECT s.*, c.name as channel_name, c.handle FROM schedule s LEFT JOIN channels c ON c.id = s.channel_id ORDER BY s.date`).all());
});

app.post('/api/schedule', async (c) => {
  const s = await c.req.json();
  const r = db.prepare(`INSERT INTO schedule (channel_id, type, title, date, time, location, status, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(s.channel_id || null, s.type || '', s.title, s.date, s.time || '', s.location || '', s.status || '예정', s.note || '');
  return c.json({ ok: true, id: r.lastInsertRowid });
});

app.post('/api/sessions', async (c) => {
  const s = await c.req.json();
  db.prepare(`INSERT INTO sessions (date, strategy, queries, categories, channels_found, channels_added, note)
    VALUES (date('now'), ?, ?, ?, ?, ?, ?)`).run(s.strategy || 'search', JSON.stringify(s.queries || []), JSON.stringify(s.categories || []), s.found || 0, s.added || 0, s.note || '');
  return c.json({ ok: true });
});

app.get('/api/sessions', (c) => {
  return c.json(db.prepare(`SELECT * FROM sessions ORDER BY date DESC, id DESC`).all());
});

app.post('/api/build', (c) => {
  try {
    execSync('node build.mjs', { cwd: __dirname, encoding: 'utf8' });
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// ===================== 매니저 웹 UI =====================

const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;color:#222;line-height:1.5;font-size:14px}
nav{background:#111;color:#fff;padding:0 16px;display:flex;align-items:center;position:sticky;top:0;z-index:10;height:44px}
nav .brand{font-weight:700;font-size:15px;color:#fff;margin-right:24px}
nav a{color:#666;text-decoration:none;font-size:13px;padding:12px 8px;border-bottom:2px solid transparent}
nav a:hover{color:#ddd}nav a.active{color:#fff;border-bottom-color:#4fc3f7}
.wrap{max-width:960px;margin:0 auto;padding:16px}
h2{font-size:15px;font-weight:700;margin:20px 0 10px}
.card{background:#fff;border-radius:8px;padding:16px;margin-bottom:10px;border:1px solid #e8e8e8}
.card h3{font-size:13px;font-weight:600;color:#555;margin-bottom:8px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.stat{text-align:center;padding:12px;background:#fff;border-radius:8px;border:1px solid #e8e8e8}
.stat .n{font-size:26px;font-weight:700;line-height:1}.stat .l{font-size:11px;color:#888;margin-top:2px}
.stat.hi{border-color:#2e7d32;background:#f1f8e9}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:8px 6px;font-size:11px;color:#999;font-weight:500;border-bottom:2px solid #eee;white-space:nowrap}
td{padding:7px 6px;border-bottom:1px solid #f3f3f3;vertical-align:top}
tr:hover{background:#fafafa}
a{color:#1565c0;text-decoration:none}a:hover{text-decoration:underline}
.badge{display:inline-block;font-size:10px;padding:2px 6px;border-radius:3px;font-weight:600;white-space:nowrap}
.b-후보{background:#e3f2fd;color:#1565c0}.b-컨택중{background:#fff3e0;color:#e65100}
.b-응답{background:#e8f5e9;color:#2e7d32}.b-확정{background:#2e7d32;color:#fff}
.b-보류{background:#f5f5f5;color:#999}.b-제외{background:#f5f5f5;color:#ccc}.b-출연불가{background:#f5f5f5;color:#ccc}
.b-쉬움{background:#e8f5e9;color:#2e7d32}.b-중간{background:#fff3e0;color:#e65100}.b-높음{background:#fce4ec;color:#c62828}
.b-예정{background:#e3f2fd;color:#1565c0}.b-확정s{background:#2e7d32;color:#fff}.b-완료{background:#e8eaf6;color:#283593}.b-취소{background:#f5f5f5;color:#999}
.bar{height:6px;background:#eee;border-radius:3px;overflow:hidden}.bar-f{height:100%;border-radius:3px;transition:.3s}
.tabs{display:flex;gap:4px;margin-bottom:12px;flex-wrap:wrap}
.tabs a{padding:4px 10px;border-radius:14px;font-size:12px;text-decoration:none;border:1px solid #ddd;color:#888}
.tabs a:hover{border-color:#999;color:#555}.tabs a.on{background:#111;color:#fff;border-color:#111}
.btn{display:inline-block;padding:4px 10px;border-radius:6px;font-size:11px;text-decoration:none;cursor:pointer;border:none}
.btn-dark{background:#111;color:#fff}.btn-blue{background:#1565c0;color:#fff}.btn-green{background:#2e7d32;color:#fff}
.btn-orange{background:#e65100;color:#fff}.btn-gray{background:#eee;color:#666}.btn-red{background:#c62828;color:#fff}
.btn:hover{opacity:.85}
select.inline{font-size:11px;padding:2px 4px;border:1px solid #ddd;border-radius:4px;background:#fff}
input.inline{font-size:12px;padding:3px 6px;border:1px solid #ddd;border-radius:4px;width:100%}
textarea.inline{font-size:12px;padding:4px 6px;border:1px solid #ddd;border-radius:4px;width:100%;resize:vertical}
.empty{text-align:center;color:#aaa;padding:32px;font-size:13px}
.flash{padding:8px 12px;border-radius:6px;margin-bottom:12px;font-size:13px;background:#e8f5e9;color:#2e7d32;border:1px solid #c8e6c9}
.score{display:inline-flex;gap:1px}.score span{width:8px;height:14px;border-radius:2px;background:#eee}
.score span.filled{background:#ff9800}
.ch-link{font-weight:600;color:#111}.ch-link:hover{color:#1565c0}
.sub{font-size:11px;color:#aaa}
.mt8{margin-top:8px}.mb8{margin-bottom:8px}.mb16{margin-bottom:16px}
.flex{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.flex-between{display:flex;justify-content:space-between;align-items:center}
form.inline-form{display:inline}
`;

const layout = (title, body, activePath = '/') => `<!DOCTYPE html><html lang="ko"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title} - ENT</title>
<script src="https://unpkg.com/htmx.org@2.0.4"></script>
<style>${CSS}</style>
</head><body>
<nav>
<span class="brand">ENT</span>
<a href="/" class="${activePath === '/' ? 'active' : ''}">대시보드</a>
<a href="/channels" class="${activePath === '/channels' ? 'active' : ''}">채널</a>
<a href="/outreach" class="${activePath === '/outreach' ? 'active' : ''}">아웃리치</a>
<a href="/schedule" class="${activePath === '/schedule' ? 'active' : ''}">스케줄</a>
<a href="/research" class="${activePath === '/research' ? 'active' : ''}">리서치</a>
</nav>
<div class="wrap">${body}</div>
</body></html>`;

const scoreBar = (n) => {
  let h = '<span class="score">';
  for (let i = 1; i <= 10; i++) h += `<span${i <= n ? ' class="filled"' : ''}></span>`;
  return h + '</span>';
};

// ---------- 대시보드 ----------
app.get('/', (c) => {
  const sts = db.prepare(`SELECT status, COUNT(*) as cnt FROM channels GROUP BY status ORDER BY CASE status WHEN '확정' THEN 1 WHEN '응답' THEN 2 WHEN '컨택중' THEN 3 WHEN '후보' THEN 4 WHEN '보류' THEN 5 WHEN '제외' THEN 6 WHEN '출연불가' THEN 7 END`).all();
  const cov = db.prepare(`SELECT * FROM coverage ORDER BY pct`).all();
  const fups = db.prepare(`SELECT c.name, c.handle, c.email, o.followup_date FROM outreach o JOIN channels c ON c.id = o.channel_id WHERE o.followup_needed = 1 AND o.result IS NULL ORDER BY o.followup_date LIMIT 5`).all();
  const sched = db.prepare(`SELECT s.*, c.name as cn FROM schedule s LEFT JOIN channels c ON c.id = s.channel_id WHERE s.date >= date('now') ORDER BY s.date LIMIT 5`).all();
  const recent = db.prepare(`SELECT name, handle, cat, status, added_at FROM channels WHERE status NOT IN ('제외','출연불가') ORDER BY added_at DESC, id DESC LIMIT 5`).all();
  const sessions = db.prepare(`SELECT * FROM sessions ORDER BY date DESC LIMIT 3`).all();

  let h = '';

  // 퍼널 요약
  h += '<div class="grid4 mb16">';
  const order = ['후보', '컨택중', '응답', '확정'];
  order.forEach(s => {
    const cnt = sts.find(x => x.status === s)?.cnt || 0;
    h += `<div class="stat${s === '확정' && cnt > 0 ? ' hi' : ''}"><div class="n">${cnt}</div><div class="l"><span class="badge b-${s}">${s}</span></div></div>`;
  });
  h += '</div>';

  h += '<div class="grid2">';

  // 커버리지
  h += '<div class="card"><h3>리서치 커버리지</h3>';
  cov.forEach(cv => {
    const col = cv.pct >= 60 ? '#4caf50' : cv.pct >= 30 ? '#ff9800' : '#ef5350';
    h += `<div class="flex" style="margin:3px 0"><span style="width:45px;font-size:12px">${cv.cat}</span><div class="bar" style="flex:1"><div class="bar-f" style="width:${cv.pct}%;background:${col}"></div></div><span class="sub">${cv.pct}%</span></div>`;
  });
  h += '</div>';

  // 팔로업
  h += '<div class="card"><h3>팔로업 필요</h3>';
  if (fups.length) {
    fups.forEach(f => { h += `<div class="flex" style="margin:4px 0;font-size:12px"><a href="/channels/${encodeURIComponent(f.handle)}">${f.name}</a><span class="sub">${f.followup_date || '미정'}</span></div>`; });
  } else h += '<div class="empty" style="padding:16px">팔로업 없음</div>';
  h += '</div>';

  h += '</div>'; // grid2

  h += '<div class="grid2">';

  // 스케줄
  h += '<div class="card"><h3>다가오는 스케줄</h3>';
  if (sched.length) {
    sched.forEach(s => { h += `<div style="margin:4px 0;font-size:12px"><strong>${s.date}</strong> ${s.title} <span class="sub">${s.cn || ''}</span> <span class="badge b-${s.status}">${s.status}</span></div>`; });
  } else h += '<div class="empty" style="padding:16px">예정된 스케줄 없음</div>';
  h += '</div>';

  // 최근 추가
  h += '<div class="card"><h3>최근 추가 채널</h3>';
  recent.forEach(r => { h += `<div class="flex" style="margin:3px 0;font-size:12px"><a href="/channels/${encodeURIComponent(r.handle)}">${r.name}</a><span class="badge b-${r.cat}" style="font-size:9px">${r.cat}</span><span class="sub">${r.added_at}</span></div>`; });
  h += '</div>';

  h += '</div>'; // grid2

  return c.html(layout('대시보드', h, '/'));
});

// ---------- 채널 목록 ----------
app.get('/channels', (c) => {
  const status = c.req.query('status') || '';
  const cat = c.req.query('cat') || '';
  const q = c.req.query('q') || '';
  const podcast = c.req.query('podcast');
  let where = ["status NOT IN ('제외','출연불가')"];
  if (podcast === '0') where.push(`is_podcast = 0`);
  else if (podcast !== 'all') where.push(`is_podcast = 1`);
  if (status) where.push(`status = '${status}'`);
  if (cat) where.push(`cat = '${cat}'`);
  if (q) where.push(`(name LIKE '%${q}%' OR handle LIKE '%${q}%' OR note LIKE '%${q}%')`);
  const rows = db.prepare(`SELECT * FROM channels WHERE ${where.join(' AND ')} ORDER BY fit_score DESC, added_at DESC`).all();
  const allCats = db.prepare(`SELECT DISTINCT cat FROM channels WHERE status NOT IN ('제외','출연불가') AND is_podcast = 1 ORDER BY cat`).all().map(r => r.cat);
  const nonPodcastCnt = db.prepare(`SELECT COUNT(*) as n FROM channels WHERE status NOT IN ('제외','출연불가') AND is_podcast = 0`).get().n;

  const qs = (k, v) => {
    const p = new URLSearchParams();
    if (k !== 'status' && status) p.set('status', status);
    if (k !== 'cat' && cat) p.set('cat', cat);
    if (k !== 'podcast' && podcast && podcast !== undefined) p.set('podcast', podcast);
    if (k === 'status' && v) p.set('status', v);
    if (k === 'cat' && v) p.set('cat', v);
    if (k === 'podcast') p.set('podcast', v);
    return '/channels' + (p.toString() ? '?' + p : '');
  };

  let h = '';
  h += '<div class="flex-between mb8"><h2>채널 목록 (' + rows.length + ')</h2>';
  h += `<form action="/channels" method="get" class="flex"><input name="q" class="inline" placeholder="검색..." value="${q}" style="width:160px"><button class="btn btn-dark" type="submit">검색</button></form></div>`;

  // 팟캐스트/비팟캐 탭
  h += '<div class="tabs">';
  h += `<a href="${qs('podcast','')}" class="${!podcast || podcast === '' ? 'on' : ''}">팟캐스트만</a>`;
  h += `<a href="${qs('podcast','all')}" class="${podcast === 'all' ? 'on' : ''}">전체</a>`;
  if (nonPodcastCnt) h += `<a href="${qs('podcast','0')}" class="${podcast === '0' ? 'on' : ''}">비팟캐 (${nonPodcastCnt})</a>`;
  h += '</div>';

  // 상태 탭
  h += '<div class="tabs">';
  h += `<a href="${qs('status','')}" class="${!status ? 'on' : ''}">전체</a>`;
  ['후보', '컨택중', '응답', '확정', '보류', '출연불가'].forEach(s => { h += `<a href="${qs('status', s)}" class="${status === s ? 'on' : ''}">${s}</a>`; });
  h += '</div><div class="tabs">';
  allCats.forEach(ct => { h += `<a href="${qs('cat', ct)}" class="${cat === ct ? 'on' : ''}">${ct}</a>`; });
  h += '</div>';

  h += '<table><thead><tr><th>채널</th><th>구독자</th><th>평균</th><th>난이도</th><th>상태</th><th>스코어</th><th>연락처</th><th>액션</th></tr></thead><tbody>';
  if (!rows.length) h += '<tr><td colspan="8" class="empty">결과 없음</td></tr>';
  rows.forEach(r => {
    h += `<tr>
<td><a class="ch-link" href="/channels/${encodeURIComponent(r.handle)}">${r.name}</a><br><span class="sub">${r.handle}</span></td>
<td class="sub">${r.subs}</td>
<td class="sub">${r.avg_views || '-'}</td>
<td><span class="badge b-${r.diff}">${r.diff}</span></td>
<td><span class="badge b-${r.status}">${r.status}</span></td>
<td>${r.fit_score ? scoreBar(r.fit_score) : '<span class="sub">-</span>'}</td>
<td style="font-size:11px">${r.email ? `<a href="mailto:${r.email}">email</a> ` : ''}${r.insta ? `<a href="https://instagram.com/${r.insta.replace('@', '')}" target="_blank">insta</a>` : ''}</td>
<td>
${r.status === '후보' ? `<a class="btn btn-blue" href="/channels/${encodeURIComponent(r.handle)}/contact-form">컨택</a>` : ''}
${r.status === '컨택중' ? `<a class="btn btn-green" href="/channels/${encodeURIComponent(r.handle)}">상세</a>` : ''}
</td></tr>`;
  });
  h += '</tbody></table>';
  return c.html(layout('채널', h, '/channels'));
});

// ---------- 채널 상세 ----------
app.get('/channels/:handle', (c) => {
  const handle = decodeURIComponent(c.req.param('handle'));
  const ch = db.prepare(`SELECT * FROM channels WHERE handle = ?`).get(handle);
  if (!ch) return c.html(layout('404', '<div class="empty">채널을 찾을 수 없습니다</div>', '/channels'));
  const outs = db.prepare(`SELECT * FROM outreach WHERE channel_id = ? ORDER BY sent_at DESC`).all(ch.id);
  const scheds = db.prepare(`SELECT * FROM schedule WHERE channel_id = ? ORDER BY date`).all(ch.id);
  const flash = c.req.query('flash');

  let h = '';
  if (flash) h += `<div class="flash">${flash}</div>`;

  h += '<div class="flex-between mb8">';
  h += `<h2>${ch.name}</h2>`;
  h += `<div class="flex">`;
  h += `<a href="${ch.url}" target="_blank" class="btn btn-gray">YouTube</a>`;
  if (ch.email) h += ` <a href="mailto:${ch.email}" class="btn btn-gray">이메일</a>`;
  if (ch.insta) h += ` <a href="https://instagram.com/${ch.insta.replace('@','')}" target="_blank" class="btn btn-gray">인스타</a>`;
  h += '</div></div>';

  // 기본 정보
  h += '<div class="grid2"><div class="card"><h3>기본 정보</h3>';
  h += `<form method="post" action="/channels/${encodeURIComponent(handle)}/update">`;
  h += `<table>
<tr><td class="sub">핸들</td><td>${ch.handle}</td></tr>
<tr><td class="sub">카테고리</td><td><select name="cat" class="inline">${['패션','힙합','스트릿','코미디','연애','인터뷰','라이프','기타'].map(ct => `<option${ct===ch.cat?' selected':''}>${ct}</option>`).join('')}</select></td></tr>
<tr><td class="sub">구독자</td><td><input name="subs" class="inline" value="${ch.subs || ''}"></td></tr>
<tr><td class="sub">평균조회</td><td><input name="avg_views" class="inline" value="${ch.avg_views || ''}"></td></tr>
<tr><td class="sub">난이도</td><td><select name="diff" class="inline">${['쉬움','중간','높음'].map(d => `<option${d===ch.diff?' selected':''}>${d}</option>`).join('')}</select></td></tr>
<tr><td class="sub">상태</td><td><select name="status" class="inline">${['후보','컨택중','응답','확정','보류','출연불가','제외'].map(s => `<option${s===ch.status?' selected':''}>${s}</option>`).join('')}</select></td></tr>
<tr><td class="sub">핏 스코어</td><td><select name="fit_score" class="inline">${[0,1,2,3,4,5,6,7,8,9,10].map(n => `<option${n===ch.fit_score?' selected':''}>${n}</option>`).join('')}</select> /10</td></tr>
<tr><td class="sub">이메일</td><td><input name="email" class="inline" value="${ch.email || ''}"></td></tr>
<tr><td class="sub">인스타</td><td><input name="insta" class="inline" value="${ch.insta || ''}"></td></tr>
<tr><td class="sub">팟캐스트</td><td><select name="is_podcast" class="inline"><option value="1"${ch.is_podcast ? ' selected' : ''}>팟캐스트</option><option value="0"${!ch.is_podcast ? ' selected' : ''}>비팟캐</option></select></td></tr>
</table>
<div class="mt8"><label class="sub">메모</label><textarea name="note" class="inline" rows="2">${ch.note || ''}</textarea></div>
<div class="mt8"><button class="btn btn-dark" type="submit">저장</button></div>
</form></div>`;

  // 메타
  h += '<div class="card"><h3>메타</h3><table>';
  h += `<tr><td class="sub">추가일</td><td>${ch.added_at || '-'}</td></tr>`;
  h += `<tr><td class="sub">발견 경로</td><td>${ch.discovered_via || '-'}</td></tr>`;
  h += `<tr><td class="sub">발견 소스</td><td>${ch.discovery_source || '-'}</td></tr>`;
  h += `<tr><td class="sub">마지막 체크</td><td>${ch.last_checked || '-'}</td></tr>`;
  h += `<tr><td class="sub">마지막 업로드</td><td>${ch.last_upload || '-'}</td></tr>`;
  h += `<tr><td class="sub">게스트 빈도</td><td>${ch.guest_frequency || '-'}</td></tr>`;
  h += '</table></div></div>';

  // 아웃리치 이력
  h += '<div class="card"><div class="flex-between"><h3>아웃리치 이력</h3>';
  if (ch.status === '후보' || ch.status === '컨택중') h += `<a href="/channels/${encodeURIComponent(handle)}/contact-form" class="btn btn-blue">+ 컨택 추가</a>`;
  h += '</div>';
  if (outs.length) {
    h += '<table class="mt8"><tr><th>날짜</th><th>유형</th><th>방향</th><th>결과</th><th>팔로업</th></tr>';
    outs.forEach(o => {
      h += `<tr><td class="sub">${o.sent_at?.split(' ')[0] || '-'}</td><td>${o.type}</td><td>${o.direction}</td><td>${o.result || '-'}</td><td>${o.followup_needed ? `<span style="color:#e65100">${o.followup_date || '필요'}</span>` : '-'}</td></tr>`;
    });
    h += '</table>';
  } else h += '<div class="empty" style="padding:12px">아직 컨택 기록 없음</div>';
  h += '</div>';

  // 스케줄
  h += '<div class="card"><h3>스케줄</h3>';
  if (scheds.length) {
    scheds.forEach(s => { h += `<div style="margin:4px 0;font-size:12px"><strong>${s.date}</strong> ${s.title} <span class="badge b-${s.status}">${s.status}</span></div>`; });
  } else h += '<div class="empty" style="padding:12px">스케줄 없음</div>';
  h += '</div>';

  return c.html(layout(ch.name, h, '/channels'));
});

// 채널 업데이트 (폼 처리)
app.post('/channels/:handle/update', async (c) => {
  const handle = decodeURIComponent(c.req.param('handle'));
  const body = await c.req.parseBody();
  const allowed = ['cat','subs','avg_views','diff','status','fit_score','email','insta','note','is_podcast'];
  const sets = allowed.filter(k => body[k] !== undefined).map(k => `${k} = '${String(body[k]).replace(/'/g, "''")}'`);
  sets.push(`updated_at = datetime('now')`);
  db.prepare(`UPDATE channels SET ${sets.join(', ')} WHERE handle = ?`).run(handle);
  return c.redirect(`/channels/${encodeURIComponent(handle)}?flash=저장 완료`);
});

// 컨택 폼
app.get('/channels/:handle/contact-form', (c) => {
  const handle = decodeURIComponent(c.req.param('handle'));
  const ch = db.prepare(`SELECT * FROM channels WHERE handle = ?`).get(handle);
  if (!ch) return c.redirect('/channels');

  let h = `<h2>${ch.name} 컨택</h2>`;
  h += `<div class="card"><form method="post" action="/channels/${encodeURIComponent(handle)}/contact-submit">`;
  h += `<table>
<tr><td class="sub">유형</td><td><select name="type" class="inline"><option>email</option><option>dm</option><option>댓글</option><option>기타</option></select></td></tr>
<tr><td class="sub">제목</td><td><input name="subject" class="inline" value="게스트 출연 제안"></td></tr>
</table>`;
  h += `<div class="mt8"><label class="sub">메시지</label><textarea name="message" class="inline" rows="5" placeholder="보낸 메시지 내용..."></textarea></div>`;
  h += `<div class="mt8"><button class="btn btn-blue" type="submit">컨택 기록</button> <a href="/channels/${encodeURIComponent(handle)}" class="btn btn-gray">취소</a></div>`;
  h += '</form></div>';
  return c.html(layout('컨택', h, '/channels'));
});

app.post('/channels/:handle/contact-submit', async (c) => {
  const handle = decodeURIComponent(c.req.param('handle'));
  const body = await c.req.parseBody();
  const ch = db.prepare(`SELECT id FROM channels WHERE handle = ?`).get(handle);
  if (!ch) return c.redirect('/channels');
  db.prepare(`UPDATE channels SET status = '컨택중', updated_at = datetime('now') WHERE id = ?`).run(ch.id);
  db.prepare(`INSERT INTO outreach (channel_id, type, subject, message, followup_needed, followup_date)
    VALUES (?, ?, ?, ?, 1, date('now', '+7 days'))`).run(ch.id, body.type || 'email', body.subject || '', body.message || '');
  return c.redirect(`/channels/${encodeURIComponent(handle)}?flash=컨택 기록 완료`);
});

// ---------- 아웃리치 ----------
app.get('/outreach', (c) => {
  const rows = db.prepare(`SELECT o.*, c.name, c.handle, c.cat FROM outreach o JOIN channels c ON c.id = o.channel_id ORDER BY o.sent_at DESC`).all();
  const fups = rows.filter(r => r.followup_needed && !r.result);

  let h = '';
  if (fups.length) {
    h += `<div class="card" style="border-left:3px solid #e65100"><h3>팔로업 필요 (${fups.length})</h3><table><tr><th>채널</th><th>유형</th><th>보낸날</th><th>팔로업일</th><th>액션</th></tr>`;
    fups.forEach(f => {
      const overdue = f.followup_date && f.followup_date <= new Date().toISOString().split('T')[0];
      h += `<tr${overdue ? ' style="background:#fff3e0"' : ''}><td><a href="/channels/${encodeURIComponent(f.handle)}">${f.name}</a> <span class="sub">${f.cat}</span></td><td>${f.type}</td><td class="sub">${f.sent_at?.split(' ')[0] || '-'}</td><td${overdue ? ' style="color:#c62828;font-weight:600"' : ''}>${f.followup_date || '-'}</td><td><a href="/channels/${encodeURIComponent(f.handle)}" class="btn btn-orange">처리</a></td></tr>`;
    });
    h += '</table></div>';
  }

  h += '<h2>전체 아웃리치 이력</h2>';
  h += '<table><thead><tr><th>날짜</th><th>채널</th><th>유형</th><th>방향</th><th>결과</th><th>팔로업</th></tr></thead><tbody>';
  if (!rows.length) h += '<tr><td colspan="6" class="empty">기록 없음</td></tr>';
  rows.forEach(r => {
    h += `<tr><td class="sub">${r.sent_at?.split(' ')[0] || '-'}</td><td><a href="/channels/${encodeURIComponent(r.handle)}">${r.name}</a></td><td>${r.type}</td><td>${r.direction}</td><td>${r.result || '-'}</td><td>${r.followup_needed && !r.result ? `<span style="color:#e65100">${r.followup_date || '필요'}</span>` : '-'}</td></tr>`;
  });
  h += '</tbody></table>';
  return c.html(layout('아웃리치', h, '/outreach'));
});

// ---------- 스케줄 ----------
app.get('/schedule', (c) => {
  const rows = db.prepare(`SELECT s.*, c.name as cn, c.handle FROM schedule s LEFT JOIN channels c ON c.id = s.channel_id ORDER BY s.date`).all();
  const upcoming = rows.filter(r => r.date >= new Date().toISOString().split('T')[0] && r.status !== '취소');
  const past = rows.filter(r => r.date < new Date().toISOString().split('T')[0] || r.status === '취소' || r.status === '완료');

  let h = '<div class="flex-between mb8"><h2>스케줄</h2><a href="/schedule/new" class="btn btn-dark">+ 추가</a></div>';

  if (upcoming.length) {
    h += '<div class="card"><h3>예정</h3>';
    upcoming.forEach(s => {
      h += `<div class="flex" style="margin:6px 0;padding:8px;background:#fafafa;border-radius:6px">
<div style="min-width:80px"><strong>${s.date}</strong><br><span class="sub">${s.time || ''}</span></div>
<div style="flex:1"><strong>${s.title}</strong><br><span class="sub">${s.cn || ''} ${s.location ? '· ' + s.location : ''}</span></div>
<span class="badge b-${s.status}">${s.status}</span></div>`;
    });
    h += '</div>';
  }

  if (!upcoming.length && !past.length) h += '<div class="empty">스케줄 없음</div>';
  return c.html(layout('스케줄', h, '/schedule'));
});

app.get('/schedule/new', (c) => {
  const channels = db.prepare(`SELECT id, name, handle FROM channels WHERE status IN ('응답', '확정') ORDER BY name`).all();
  let h = '<h2>스케줄 추가</h2><div class="card"><form method="post" action="/schedule/create">';
  h += `<table>
<tr><td class="sub">제목</td><td><input name="title" class="inline" required></td></tr>
<tr><td class="sub">날짜</td><td><input name="date" type="date" class="inline" required></td></tr>
<tr><td class="sub">시간</td><td><input name="time" type="time" class="inline"></td></tr>
<tr><td class="sub">유형</td><td><select name="type" class="inline"><option>촬영</option><option>미팅</option><option>방송</option><option>기타</option></select></td></tr>
<tr><td class="sub">채널</td><td><select name="channel_id" class="inline"><option value="">선택안함</option>${channels.map(ch => `<option value="${ch.id}">${ch.name}</option>`).join('')}</select></td></tr>
<tr><td class="sub">장소</td><td><input name="location" class="inline"></td></tr>
<tr><td class="sub">메모</td><td><textarea name="note" class="inline" rows="2"></textarea></td></tr>
</table>`;
  h += '<div class="mt8"><button class="btn btn-dark" type="submit">추가</button> <a href="/schedule" class="btn btn-gray">취소</a></div></form></div>';
  return c.html(layout('스케줄 추가', h, '/schedule'));
});

app.post('/schedule/create', async (c) => {
  const b = await c.req.parseBody();
  db.prepare(`INSERT INTO schedule (channel_id, type, title, date, time, location, status, note)
    VALUES (?, ?, ?, ?, ?, ?, '예정', ?)`).run(b.channel_id || null, b.type || '', b.title, b.date, b.time || '', b.location || '', b.note || '');
  return c.redirect('/schedule');
});

// ---------- 리서치 ----------
app.get('/research', (c) => {
  const cov = db.prepare(`SELECT * FROM coverage ORDER BY pct`).all();
  const sessions = db.prepare(`SELECT * FROM sessions ORDER BY date DESC, id DESC LIMIT 10`).all();
  const planned = db.prepare(`SELECT query, category FROM query_bank WHERE status = 'planned' LIMIT 10`).all();
  const usedCnt = db.prepare(`SELECT COUNT(*) as n FROM query_bank WHERE status = 'used'`).get();

  let h = '<h2>리서치 현황</h2>';

  h += '<div class="grid2">';
  h += '<div class="card"><h3>카테고리별 커버리지</h3>';
  cov.forEach(cv => {
    const col = cv.pct >= 60 ? '#4caf50' : cv.pct >= 30 ? '#ff9800' : '#ef5350';
    h += `<div class="flex" style="margin:4px 0"><span style="width:50px;font-size:12px">${cv.cat}</span><div class="bar" style="flex:1"><div class="bar-f" style="width:${cv.pct}%;background:${col}"></div></div><span class="sub">${cv.pct}%</span>
    <span class="sub">${cv.search_done ? 'S' : '-'}${cv.related_done ? 'R' : '-'}${cv.guest_done ? 'G' : '-'}</span></div>`;
  });
  h += '</div>';

  h += '<div class="card"><h3>다음 검색어</h3>';
  h += `<div class="sub mb8">사용: ${usedCnt.n}개 · 남은: ${planned.length}개+</div>`;
  planned.forEach((q, i) => { h += `<div style="font-size:12px;margin:3px 0">${i + 1}. ${q.query} <span class="sub">${q.category || ''}</span></div>`; });
  h += '</div></div>';

  h += '<h2>최근 세션</h2><table><thead><tr><th>날짜</th><th>전략</th><th>발견</th><th>추가</th><th>노트</th></tr></thead><tbody>';
  sessions.forEach(s => {
    h += `<tr><td class="sub">${s.date}</td><td>${s.strategy}</td><td>${s.channels_found}</td><td>${s.channels_added}</td><td class="sub">${s.note || '-'}</td></tr>`;
  });
  h += '</tbody></table>';

  return c.html(layout('리서치', h, '/research'));
});

// ===================== Start =====================
const port = 4000;
serve({ fetch: app.fetch, port }, () => {
  console.log(`\n  ENT Management Server`);
  console.log(`  ├─ 매니저 UI:  http://localhost:${port}`);
  console.log(`  ├─ API:        http://localhost:${port}/api/status`);
  console.log(`  └─ DB:         research.db\n`);
});
