#!/usr/bin/env node
/**
 * SQLite → 정적 HTML 빌드 (연예인용 공개 페이지)
 */
import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(resolve(__dirname, 'research.db'), { readonly: true });
const DIST = resolve(__dirname, 'dist');
mkdirSync(DIST, { recursive: true });

const today = new Date().toISOString().split('T')[0];

// Data
const channels = db.prepare(`SELECT * FROM channels WHERE status NOT IN ('제외','출연불가') AND is_podcast = 1 ORDER BY
  CASE status WHEN '확정' THEN 1 WHEN '응답' THEN 2 WHEN '컨택중' THEN 3 WHEN '후보' THEN 4 WHEN '보류' THEN 5 END, cat`).all();
const coverage = db.prepare(`SELECT * FROM coverage ORDER BY pct`).all();
const schedule = db.prepare(`SELECT s.*, c.name as channel_name, c.handle FROM schedule s LEFT JOIN channels c ON c.id = s.channel_id WHERE s.status != '취소' ORDER BY s.date`).all();
const funnel = {
  total: channels.length,
  contacted: channels.filter(c => c.status === '컨택중').length,
  responded: channels.filter(c => c.status === '응답').length,
  confirmed: channels.filter(c => c.status === '확정').length,
};

// Group by status then cat
const grouped = {};
channels.forEach(ch => {
  if (!grouped[ch.cat]) grouped[ch.cat] = [];
  grouped[ch.cat].push(ch);
});

const catOrder = ['패션', '힙합', '스트릿', '코미디', '연애', '인터뷰', '라이프', '기타'];

// Build HTML
let channelRows = '';
catOrder.forEach(cat => {
  if (!grouped[cat]) return;
  const items = grouped[cat];
  channelRows += `<tr class="cat-header"><td colspan="5"><strong>${cat}</strong> <span class="cnt">${items.length}개</span></td></tr>`;
  items.forEach(ch => {
    const diffClass = ch.diff === '쉬움' ? 'easy' : ch.diff === '중간' ? 'mid' : 'hard';
    const statusClass = ch.status === '확정' ? 'confirmed' : ch.status === '응답' ? 'responded' : ch.status === '컨택중' ? 'contacting' : '';
    channelRows += `<tr class="${statusClass}">
      <td><a href="${ch.url}" target="_blank">${ch.name}</a><br><span class="sub">${ch.handle}</span></td>
      <td>${ch.subs}</td>
      <td><span class="diff ${diffClass}">${ch.diff}</span></td>
      <td><span class="status s-${ch.status}">${ch.status}</span></td>
      <td class="sub">${ch.note || ''}</td>
    </tr>`;
  });
});

let coverageHtml = '';
coverage.forEach(cv => {
  const color = cv.pct >= 60 ? '#4caf50' : cv.pct >= 30 ? '#ff9800' : '#ef5350';
  coverageHtml += `<div class="cov-item"><span class="cov-label">${cv.cat}</span><div class="cov-bar"><div class="cov-fill" style="width:${cv.pct}%;background:${color}"></div></div><span class="cov-pct">${cv.pct}%</span></div>`;
});

let scheduleHtml = '';
if (schedule.length) {
  schedule.forEach(s => {
    scheduleHtml += `<div class="sch-item ${s.status === '확정' ? 'sch-confirmed' : ''}">
      <div class="sch-date">${s.date}${s.time ? ' ' + s.time : ''}</div>
      <div class="sch-title">${s.title}</div>
      <div class="sch-meta">${s.channel_name || ''} ${s.location ? '· ' + s.location : ''} <span class="status s-${s.status}">${s.status}</span></div>
    </div>`;
  });
} else {
  scheduleHtml = '<p class="empty">아직 예정된 스케줄 없음</p>';
}

const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>윤담백 팟캐스트 현황</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f8f9fa;color:#222;line-height:1.6}
header{background:#fff;padding:20px 16px;border-bottom:1px solid #e0e0e0;text-align:center}
header h1{font-size:18px;font-weight:700}
header p{font-size:12px;color:#888;margin-top:2px}
.wrap{max-width:800px;margin:0 auto;padding:16px}
h2{font-size:15px;font-weight:700;margin:24px 0 12px;padding-bottom:6px;border-bottom:2px solid #222}
.pipeline{display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap}
.pipe-item{flex:1;min-width:80px;background:#fff;border-radius:10px;padding:14px;text-align:center;border:1px solid #eee}
.pipe-item .num{font-size:24px;font-weight:700}
.pipe-item .label{font-size:11px;color:#888}
.pipe-item.active{border-color:#2e7d32;background:#e8f5e9}
.cov-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-bottom:20px}
.cov-item{display:flex;align-items:center;gap:6px;font-size:12px}
.cov-label{width:45px;color:#555}
.cov-bar{flex:1;height:5px;background:#eee;border-radius:3px;overflow:hidden}
.cov-fill{height:100%;border-radius:3px}
.cov-pct{width:30px;text-align:right;color:#888;font-size:11px}
table{width:100%;border-collapse:collapse;font-size:13px;background:#fff;border-radius:10px;overflow:hidden}
th{text-align:left;padding:8px 10px;font-size:11px;color:#888;border-bottom:2px solid #eee}
td{padding:8px 10px;border-bottom:1px solid #f5f5f5}
tr.cat-header{background:#f8f9fa}
tr.cat-header td{padding:10px;font-size:13px}
.cnt{color:#888;font-weight:400;font-size:12px}
td a{color:#111;text-decoration:none;font-weight:600}
td a:hover{color:#1565c0}
.sub{color:#999;font-size:11px}
.diff{font-size:10px;padding:2px 6px;border-radius:3px;font-weight:600}
.easy{background:#e8f5e9;color:#2e7d32}.mid{background:#fff3e0;color:#e65100}.hard{background:#fce4ec;color:#c62828}
.status{font-size:10px;padding:2px 6px;border-radius:3px;font-weight:600}
.s-후보{background:#e3f2fd;color:#1565c0}.s-컨택중{background:#fff3e0;color:#e65100}
.s-응답{background:#e8f5e9;color:#2e7d32}.s-확정{background:#2e7d32;color:#fff}
.s-보류{background:#f5f5f5;color:#999}.s-예정{background:#e3f2fd;color:#1565c0}
tr.confirmed{background:#f1f8e9}tr.responded{background:#fff8e1}tr.contacting{background:#fff3e0}
.sch-item{background:#fff;border-radius:8px;padding:12px;margin-bottom:8px;border:1px solid #eee}
.sch-confirmed{border-left:3px solid #2e7d32}
.sch-date{font-size:12px;color:#888;font-weight:600}
.sch-title{font-size:14px;font-weight:600;margin:2px 0}
.sch-meta{font-size:12px;color:#999}
.empty{text-align:center;color:#aaa;padding:20px;font-size:13px}
footer{text-align:center;padding:24px;font-size:11px;color:#bbb}
@media(max-width:600px){.pipeline{gap:6px}.pipe-item{padding:10px}.pipe-item .num{font-size:20px}}
</style>
</head>
<body>
<header>
  <h1>윤담백 팟캐스트 현황</h1>
  <p>${today} 기준 · 총 ${channels.length}개 채널</p>
</header>
<div class="wrap">

<h2>진행 현황</h2>
<div class="pipeline">
  <div class="pipe-item"><div class="num">${funnel.total}</div><div class="label">후보</div></div>
  <div class="pipe-item${funnel.contacted ? ' active' : ''}"><div class="num">${funnel.contacted}</div><div class="label">컨택중</div></div>
  <div class="pipe-item${funnel.responded ? ' active' : ''}"><div class="num">${funnel.responded}</div><div class="label">응답</div></div>
  <div class="pipe-item${funnel.confirmed ? ' active' : ''}"><div class="num">${funnel.confirmed}</div><div class="label">확정</div></div>
</div>

<h2>스케줄</h2>
${scheduleHtml}

<h2>리서치 커버리지</h2>
<div class="cov-grid">${coverageHtml}</div>

<h2>채널 리스트</h2>
<table>
<thead><tr><th>채널</th><th>구독자</th><th>난이도</th><th>상태</th><th>메모</th></tr></thead>
<tbody>${channelRows}</tbody>
</table>

</div>
<footer>ENT Management · Built ${today}</footer>
</body>
</html>`;

writeFileSync(resolve(DIST, 'index.html'), html);
console.log(`Built: dist/index.html (${channels.length} channels, ${schedule.length} schedules)`);
