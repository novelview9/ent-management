-- 팟캐스트 리서치 DB

-- 1. 채널 (수집)
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  handle TEXT UNIQUE NOT NULL,
  url TEXT NOT NULL,
  subs TEXT,
  avg_views TEXT,
  cat TEXT CHECK(cat IN ('패션','힙합','스트��','코미디','연애','인터뷰','라이프','기타')),
  email TEXT,
  insta TEXT,
  diff TEXT CHECK(diff IN ('쉬움','중간','높음')) DEFAULT '중간',
  status TEXT CHECK(status IN ('후보','컨택중','응답','확정','보류','제외')) DEFAULT '후보',
  note TEXT,

  -- 수집 메타
  added_at TEXT DEFAULT (date('now')),
  discovered_via TEXT CHECK(discovered_via IN ('search','related','guest','manual')) DEFAULT 'search',
  discovery_source TEXT,
  last_checked TEXT DEFAULT (date('now')),
  last_upload TEXT,              -- 채널 마지막 업로드일

  -- 스코어링
  fit_score INTEGER DEFAULT 0,  -- 윤담백 콘텐츠 핏 (1-10)
  guest_frequency TEXT,         -- 게스트 초대 빈도: 매주/격주/비정기

  tags TEXT DEFAULT '[]',       -- JSON array
  guest_overlap TEXT DEFAULT '[]',

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 2. 아웃리치 (진행)
CREATE TABLE IF NOT EXISTS outreach (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  type TEXT CHECK(type IN ('email','dm','댓글','기타')) NOT NULL,
  direction TEXT CHECK(direction IN ('sent','received')) DEFAULT 'sent',
  subject TEXT,
  message TEXT,
  sent_at TEXT DEFAULT (datetime('now')),
  response_at TEXT,
  followup_needed INTEGER DEFAULT 0,
  followup_date TEXT,
  result TEXT,                  -- 긍정/부정/무응답/보류
  note TEXT
);

-- 3. 리서치 세션 (수집 이력)
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT DEFAULT (date('now')),
  strategy TEXT CHECK(strategy IN ('search','related','guest','manual')),
  queries TEXT,                 -- JSON array of search queries used
  categories TEXT,              -- JSON array of targeted categories
  channels_found INTEGER DEFAULT 0,
  channels_added INTEGER DEFAULT 0,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 4. 검색어 뱅크
CREATE TABLE IF NOT EXISTS query_bank (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT UNIQUE NOT NULL,
  status TEXT CHECK(status IN ('planned','used','exhausted')) DEFAULT 'planned',
  category TEXT,
  used_at TEXT,
  results_count INTEGER
);

-- 5. 주간 목표 (현황)
CREATE TABLE IF NOT EXISTS weekly_goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT NOT NULL,     -- 2026-04-07
  week_num INTEGER,
  target_research INTEGER DEFAULT 0,   -- 리서치할 채널 수
  target_contact INTEGER DEFAULT 0,    -- 컨택할 채널 수
  target_followup INTEGER DEFAULT 0,   -- 팔로업할 채널 수
  actual_research INTEGER DEFAULT 0,
  actual_contact INTEGER DEFAULT 0,
  actual_followup INTEGER DEFAULT 0,
  actual_response INTEGER DEFAULT 0,
  note TEXT
);

-- 6. 커버리지맵
CREATE TABLE IF NOT EXISTS coverage (
  cat TEXT PRIMARY KEY,
  search_done INTEGER DEFAULT 0,
  related_done INTEGER DEFAULT 0,
  guest_done INTEGER DEFAULT 0,
  pct INTEGER DEFAULT 0,
  last_date TEXT
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_channels_status ON channels(status);
CREATE INDEX IF NOT EXISTS idx_channels_cat ON channels(cat);
CREATE INDEX IF NOT EXISTS idx_outreach_channel ON outreach(channel_id);
CREATE INDEX IF NOT EXISTS idx_outreach_followup ON outreach(followup_needed, followup_date);

-- 뷰: 현황 대시보드
CREATE VIEW IF NOT EXISTS v_dashboard AS
SELECT
  status,
  cat,
  COUNT(*) as cnt,
  GROUP_CONCAT(name, ', ') as channels
FROM channels
GROUP BY status, cat
ORDER BY
  CASE status WHEN '확정' THEN 1 WHEN '응답' THEN 2 WHEN '컨택중' THEN 3 WHEN '후보' THEN 4 WHEN '보류' THEN 5 WHEN '제외' THEN 6 END,
  cat;

-- 뷰: 팔로업 필요한 채널
CREATE VIEW IF NOT EXISTS v_followups AS
SELECT
  c.name, c.handle, c.cat, c.email, c.insta,
  o.type, o.sent_at, o.followup_date, o.note as outreach_note
FROM outreach o
JOIN channels c ON c.id = o.channel_id
WHERE o.followup_needed = 1 AND o.result IS NULL
ORDER BY o.followup_date;

-- 뷰: 퍼널 메트릭
CREATE VIEW IF NOT EXISTS v_funnel AS
SELECT
  cat,
  COUNT(*) FILTER (WHERE status != '제외') as total,
  COUNT(*) FILTER (WHERE status = '후보') as candidates,
  COUNT(*) FILTER (WHERE status = '컨택중') as contacted,
  COUNT(*) FILTER (WHERE status = '응답') as responded,
  COUNT(*) FILTER (WHERE status = '확정') as confirmed,
  ROUND(100.0 * COUNT(*) FILTER (WHERE status IN ('응답','확정')) /
    NULLIF(COUNT(*) FILTER (WHERE status IN ('컨택중','응답','확정')), 0), 1) as response_rate
FROM channels
GROUP BY cat;
