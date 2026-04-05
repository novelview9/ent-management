# ENT Management — 팟캐스트 리서치 시스템

## 구조
```
research.db (SQLite)  ←  server.mjs (localhost:4000)  →  매니저 웹 UI
                      ←  Claude Code (API 호출)
                      →  build.mjs  →  dist/index.html  →  GitHub Pages (연예인용)
```

## 서버 시작
```bash
cd /Users/luke/project/ent-management
npm start   # → http://localhost:4000
```

## Claude Code API 사용법

### 현황 파악
```bash
curl localhost:4000/api/status
curl localhost:4000/api/coverage
curl localhost:4000/api/funnel
curl localhost:4000/api/followups
curl localhost:4000/api/next-queries?n=5
curl localhost:4000/api/channels?status=후보&cat=패션
```

### 채널 추가
```bash
curl -X POST localhost:4000/api/channels \
  -H 'Content-Type: application/json' \
  -d '{"name":"채널명","handle":"@handle","url":"https://...","subs":"1만","avg":"~5000","cat":"패션","email":"","insta":"","diff":"쉬움","note":"설명","via":"search","source":"YouTube검색: ..."}'
```

### 진행 관리
```bash
# 컨택 기록 (자동으로 7일 후 팔로업 설정)
curl -X POST localhost:4000/api/channels/@handle/contact \
  -H 'Content-Type: application/json' \
  -d '{"type":"email","message":"메시지 내용"}'

# 응답 기록 (긍정/부정/보류)
curl -X POST localhost:4000/api/channels/@handle/respond \
  -H 'Content-Type: application/json' \
  -d '{"result":"긍정"}'

# 확정
curl -X POST localhost:4000/api/channels/@handle/confirm

# 상태/스코어 수정
curl -X PUT localhost:4000/api/channels/@handle \
  -H 'Content-Type: application/json' \
  -d '{"fit_score":8,"note":"패션+음악 핏 좋음"}'
```

### 빌드 + 배포
```bash
curl -X POST localhost:4000/api/build   # dist/index.html 생성
cd /Users/luke/project/ent-management && git add dist/ && git push
```

## 리서치 프로토콜 ("팟캐스트 더 찾아줘")

1. `curl localhost:4000/api/status` → 커버리지 확인
2. `curl localhost:4000/api/next-queries?n=5` → 검색어 선택
3. coverage < 30% → Layer 1 (키워드 검색), > 50% → Layer 2 (관련 채널)
4. Playwright로 YouTube 검색/크롤링
5. 중복 체크 후 `POST /api/channels`로 추가
6. `POST /api/sessions`로 세션 기록
7. 결과 보고

## DB 스키마 (research.db)
- **channels**: 채널 데이터 + 상태 + 스코어
- **outreach**: 컨택 이력 + 팔로업 관리
- **sessions**: 리서치 세션 로그
- **query_bank**: 검색어 뱅크 (used/planned)
- **coverage**: 카테고리별 커버리지
- **weekly_goals**: 주간 목표
- **schedule**: 출연 스케줄

## 카테고리
패션 | 힙합 | 스트릿 | 코미디 | 연애 | 인터뷰 | 라이프 | 기타

## 상태 플로우
후보 → 컨택중 → 응답 → 확정 / 보류 / 제외
