# 팟캐스트 리서치 프로젝트

## 구조
- `data.json` — 채널 데이터 (source of truth)
- `research-log.json` — 리서치 이력, 커버리지맵, 검색어 뱅크
- `index.html` — GitHub Pages 대시보드
- `scripts/discover.mjs` — CLI 유틸리티

## 채널 스키마 (data.json)
```jsonc
{
  "name": "채널명",
  "handle": "@handle",           // 중복 체크 키
  "url": "https://youtube.com/@handle",
  "subs": "1만",
  "avg": "~5,000",
  "cat": "패션",                 // 패션|힙합|스트릿|코미디|연애|인터뷰|라이프|기타
  "email": "",
  "insta": "",
  "diff": "쉬움",               // 쉬움|중간|높음
  "status": "후보",              // 후보|컨택중|응답|확정|제외
  "note": "설명",
  "added": "2026-04-04",        // 추가된 날짜
  "discoveredVia": "search",    // search|related|guest|manual
  "discoverySource": "YouTube검색: 남자패션팟캐스트",
  "lastChecked": "2026-04-04",
  "tags": ["게스트형"],
  "guestOverlap": []
}
```

## "팟캐스트 더 찾아줘" 프로토콜

### Step 1: 상태 파악
1. `data.json` 읽기 → 현재 채널 수, status별 분포
2. `research-log.json` 읽기 → coverageMap에서 가장 낮은 카테고리 확인
3. queryBank.used 확인 → 중복 검색어 방지

### Step 2: 전략 선택
- coverage < 30% 카테고리 존재 → **Layer 1 (키워드 검색)**
- 모든 카테고리 50%+ → **Layer 2 (관련 채널 크롤링)** 또는 **Layer 3 (게스트 교차)**
- 사용자가 카테고리 지정 → 해당 카테고리 전략

### Step 3: 실행
- **Layer 1**: Playwright → YouTube 검색 (이번달 필터 sp=EgIIBA%3D%3D)
  - queryBank.planned에서 검색어 선택
  - 결과에서 팟캐스트/게스트형 채널 필터링
  - data.json 기존 handle과 중복 체크
- **Layer 2**: 기존 채널의 `youtube.com/@handle/channels` 크롤링
  - diff: "쉬움" 채널을 시드로 사용
- **Layer 3**: 기존 채널 최근 영상 제목에서 게스트명 추출 → 교차 검색

### Step 4: 기록
1. 새 채널을 data.json에 추가 (added, discoveredVia, discoverySource 필수)
2. research-log.json에 세션 기록 추가
3. coverageMap 업데이트
4. queryBank.used에 사용한 검색어 이동

### Step 5: 보고
```
이번 세션: {전략} / {카테고리}
검색어: {N}개 사용
발견: {N}개 / 추가: {N}개
커버리지 변화: {카테고리} {이전}% → {이후}%
다음 추천: {전략} + {카테고리}
```

## CLI 유틸리티
```bash
node scripts/discover.mjs dedup @handle      # 중복 체크
node scripts/discover.mjs coverage           # 커버리지 요약
node scripts/discover.mjs next-queries 5     # 미사용 검색어 5개
node scripts/discover.mjs add '{"name":...}' # 채널 추가
node scripts/discover.mjs log '{"id":...}'   # 세션 기록
```

## 중복 체크 규칙
- handle 기준 (대소문자 무시)
- URL의 @핸들 또는 /channel/UC... 부분 비교
- 이미 있으면 추가하지 않음

## 카테고리 정의
| 카테고리 | 키워드 |
|---------|--------|
| 패션 | 패션, 스타일, 옷, 브랜드, OOTD |
| 힙합 | 힙합, 래퍼, 음악, 뮤지션, 인디 |
| 스트릿 | 스트릿, 서브컬처, 빈티지, 아메카지 |
| 코미디 | 코미디, 개그, 스탠드업, 예능 |
| 연애 | 연애, 썸, 결혼, 데이팅, 사연 |
| 인터뷰 | 인터뷰, 커리어, 자기계발, 인생 |
| 라이프 | 라이프스타일, 일상, 문화, 취미 |
| 기타 | 위에 해당하지 않는 것 |
