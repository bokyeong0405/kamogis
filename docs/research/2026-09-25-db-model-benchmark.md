# 서울 공공데이터 DB 선택과 통합·분리 모델 비교

작성일: 2026-09-25
상태: 원본 다운로드·기초 검수 및 네 가지 저장 모델 구현. 실데이터 1차 성능 측정 완료 — 결과는 2026-09-25-benchmark-results.md 참조. 좌표계 결정은 2026-09-25-crs-decision.md 참조.

## 1. 목적과 사실의 범위

카카오모빌리티 공간정보 시스템 개발 공고가 요구하는 데이터 모델링, 수집·검수·가공·배포, 성능 개선을 작은 프로젝트로 경험한다.

사용자가 제공한 공고는 PostgreSQL, MongoDB 등의 설계·개발 경험을 우대한다. 두 DB를 같은 서비스에서 반드시 함께 사용한다거나 내부 역할, 데이터 규모, QPS가 무엇인지는 밝히지 않는다. 아래 역할 설명은 기술 특성에 근거한 설계 가설이며 해당 회사의 실제 아키텍처라는 주장이 아니다.

질문을 분리한다.

1. 어떤 업무와 데이터에 PostgreSQL + PostGIS 또는 MongoDB가 맞는가?
2. 각 DB에서 버스·자전거를 통합하거나 분리하면 어떤 조회와 운영 작업에 유리한가?
3. 작은 실제 데이터와 확대된 합성 데이터에서 선택이 달라지는가?

두 DB에 같은 데이터를 넣는 것은 이번 비교 실험의 목적이다. 서비스에서 모든 쓰기를 두 DB에 동시에 하는 설계로 확대하지 않는다.

## 2. 확보한 데이터

| 종류 | 공식 파일 | 로컬 경로 | 실데이터 행 수 |
|---|---|---|---:|
| 버스 | 서울시버스정류소위치정보(20260902).xlsx | data/raw/bus-stops-20260902.xlsx | 11,236 |
| 따릉이 | 공공자전거 대여소 정보(26.6월 기준).xlsx | data/raw/bike-stations-202606.xlsx | 2,789 |
| 버스 명세 | 컬럼정의_서울시 버스정류소 위치정보.xlsx | data/raw/bus-stops-columns.xlsx | 명세 문서 |

출처 및 파일 SHA-256은 `data/raw/manifest.json`에 기록한다. 두 원본은 기준 시점이 다르다. 서로 같은 날짜의 실제 교통망이라고 해석하지 않는다.

기초 검수 결과:

- 버스 첫 행은 헤더, 따릉이는 1~5행이 다단 헤더·빈 행이며 6행부터 데이터다.
- 버스 `NODE_ID`, 따릉이 대여소 번호에 누락·중복이 없다. 문자열 식별자로 적재한다.
- 모든 데이터 행의 좌표가 숫자이며 경도 [-180, 180], 위도 [-90, 90]에 있고 (0, 0)이 아니다. 이는 좌표계·현실 위치의 정확성을 입증하지 않는다.
- 버스 X/Y 범위: [126.7974938496, 37.4305199435, 127.181785, 37.690177].
- 따릉이 경도/위도 범위: [126.79859924, 37.43097687, 127.18075562, 37.69101334].
- 버스 파일에는 한강선착장 8건이 포함된다. 기본 실험은 원본 전체를 보존하고 `stop_type`을 유지한다. 육상 버스만 분석하는 결과에는 8건 제외 여부를 명시한다.
- 버스 원본의 `ARS_ID`는 문자열이며 `00001` 같은 선행 0을 보존한다. 주 식별자는 NODE_ID로 삼는다.
- 버스 사이트의 `WGS84 (EPSG-5179)`는 서로 맞지 않는 표기다. 원본은 경위도 형태이나 숫자 범위만으로 CRS를 확정하지 않는다. 컬럼 명세도 CRS를 명시하지 않고 현재 파일과 컬럼 구성이 다르다.
- 후속 사용자 확인에 따라 EPSG:4326으로 해석하고 숫자를 변환하지 않고 저장했다. 근거·한계·4156 오타 정정은 2026-09-25-crs-decision.md에 기록했다. 제공기관의 확인으로 주장하지 않는다.

## 3. DB를 선택하는 이유

### PostgreSQL + PostGIS

- ID·종류·필수값·참조 관계를 PK, UNIQUE, CHECK, FK 등으로 표현하기 좋다.
- 정류소와 노선, 행정구역, 적재 이력을 연결하는 관계형 모델과 SQL 집계에 적합하다.
- PostGIS는 좌표 변환, 공간 포함·교차, 반경 검색과 공간 인덱스를 제공한다.
- `jsonb`로 종류별 추가 속성도 저장할 수 있다. JSON 데이터라는 사실만으로 MongoDB가 필요한 것은 아니다.
- 비용: 스키마 변경과 인덱스 유지, 데이터 증가에 따른 통계·VACUUM·운영 관리를 고려해야 한다.

### MongoDB

- 종류별로 필드가 다른 공간 객체와 관련 속성을 문서 단위로 표현할 수 있다.
- 한 번에 읽는 정보를 같은 문서에 담으면 일부 관계 조회를 줄일 수 있다. 반대로 중복 저장한 값의 갱신 부담이 생긴다.
- GeoJSON과 `2dsphere` 인덱스로 구면 공간 검색을 지원한다.
- 유연한 스키마에도 validator와 unique 인덱스를 적용한다. 정합성을 포기하거나 스키마 설계가 필요 없는 DB가 아니다.
- 비용: 문서 경계, 중복 데이터 정합성, 문서 크기, 인덱스와 분산 키 설계가 필요하다. 공간 인덱스 자체를 shard key로 사용할 수 없다.

함께 사용하는 가설도 가능하다. 예를 들어 PostgreSQL은 검수한 기준 데이터와 관계를 관리하고 MongoDB는 문서형 배포 결과를 제공할 수 있다. 이 경우 버전·재처리·동기화 지연·장애 복구가 추가 비용이다. 이 역할 구분을 이번 벤치마크의 비교 데이터에 적용하면 원본과 가공본을 비교하게 되므로, 벤치마크에서는 동일한 정규화 데이터를 양쪽에 적재한다.

서비스 후보로는 PostgreSQL + PostGIS를 우선 검토한다. 현재 과제의 검수·관계·공간 조회 목적에 직접 맞기 때문이다. MongoDB도 동일 데이터로 검증한 뒤 장단점을 기록한다. 이는 측정 전 가설이지 속도 우열의 결론이 아니다.

## 4. 모델 후보

종류 필드 이름은 의미가 드러나는 `facility_type`을 사용한다. 값은 사용자 제안대로 0=버스, 1=따릉이로 고정하며 코드에는 이름 있는 상수를 둔다.

공통 정규화 레코드:

```text
facility_type: 0 | 1
source_id: 문자열
name: 문자열
longitude, latitude: 숫자
attributes: 종류별 속성
```

실험 1차에서는 통합·분리 모델 모두 같은 속성 표현과 길이를 사용한다. PostgreSQL은 `attributes jsonb`, MongoDB는 `attributes` 하위 문서다. 종류별 전용 컬럼 도입은 2차 모델링 실험으로 분리한다. 서로 다른 폭의 레코드와 다른 인덱스를 비교하고 모두 테이블 분리 효과라고 해석하지 않는다.

| 후보 | 구조 | 식별자 |
|---|---|---|
| PG-U | `facilities` 통합 테이블 | PK(facility_type, source_id) |
| PG-S | `bus_stops`, `bike_stations` 분리 테이블 | 각 테이블 PK(source_id) |
| MG-U | `facilities` 통합 컬렉션 | unique(facility_type, source_id) |
| MG-S | `bus_stops`, `bike_stations` 분리 컬렉션 | 각 컬렉션 unique(source_id) |

서로 다른 종류의 같은 ID는 다른 시설이다. MongoDB 자동 `_id`만 믿고 원천 데이터 중복을 허용하지 않는다. 타입 변경은 신규 ID나 종류 간 이동으로 명시적으로 처리하고 단순 수정으로 숨기지 않는다.

### 인덱스 단계

1. 기준 비교: PostgreSQL은 각 모델에 geom GiST, MongoDB는 각 모델에 location 2dsphere, 각 모델의 고유 키 인덱스.
2. 종류 조회 최적화: PG-U의 종류별 partial GiST(`WHERE facility_type = 0/1`), MG-U의 `(facility_type, location: 2dsphere)` 복합 인덱스를 별도 구성으로 비교.
3. 시간·자원이 허용될 때 PostgreSQL `LIST(facility_type)` 파티셔닝을 제3의 구조로 추가한다. 논리적으로 하나의 테이블이며 물리적으로 분리되고 종류 조건에 따라 pruning되는지 확인한다.

모든 인덱스를 한꺼번에 추가하지 않는다. 구성별 정의와 총 크기를 저장하며 쿼리 계획을 강제하지 않는다. PostgreSQL partial index는 쿼리 조건이 인덱스 조건을 함의해야 하므로, 리터럴과 드라이버의 prepared statement/generic plan 차이도 후속 확인한다. 태그 0/1의 낮은 cardinality만으로 일반 B-tree가 항상 효과적이라고 가정하지 않는다.

## 5. 조회 시나리오

| 조회 | 확인할 점 |
|---|---|
| 종류 + ID 단건 상세 | 고유 키 조회, 원천 ID 타입 |
| 지도 bbox 안의 버스만 | 종류 필터와 공간 인덱스 선택도 |
| 지도 bbox 안의 따릉이만 | 종류 비율이 다른 상황의 영향 |
| 지도 bbox 안의 두 종류 모두 | 통합 구조의 단순함과 분리 구조 병합 비용 |
| 500m / 2km 내 시설 | 반경·단위·거리 모델·인덱스 |
| 가까운 K개, K=20 | 거리 정렬, 종류별 top-K를 전체 top-K로 올바르게 병합하는 비용 |

최소 실험은 단건과 bbox 세 종류다. 반경·nearest-K는 기본 비교가 검증된 뒤 추가한다.

좁은 영역, 중간 영역, 넓은 영역을 만들고 도심 밀집지와 외곽을 포함한다. 실제 bbox·중심·반경과 반환 행 수를 결과에 남긴다. 동일 bbox와 동일 선택도는 서로 다른 실험이므로 구분한다.

PG-S의 두 종류 조회는 같은 연결에서 `UNION ALL`로 하나의 결과를 만든다. MongoDB 분리 컬렉션은 `$unionWith`로 하나의 논리적 결과를 만들고, 두 요청을 애플리케이션에서 병합하는 방식은 별도 실험으로 표시한다. 각 종류별 K개를 그대로 합쳐 전체 top-K라고 하지 않는다.

### 공간 의미의 일치

PostGIS geometry(EPSG:4326)의 평면 사각형과 MongoDB GeoJSON 구면 폴리곤은 변의 해석이 같지 않을 수 있다. 거리도 PostGIS geography의 타원체 계산과 MongoDB의 구면 계산이 일치한다고 가정하지 않는다.

- 1차 결론은 같은 DB 내부의 구조 비교로 한정한다. 이때 같은 연산자를 사용한다.
- 각 모델이 같은 `(facility_type, source_id)` 집합을 반환하는지 양방향 차집합으로 검사한다. 건수만 비교하지 않는다.
- bbox 내부·외부·경계 및 반경 경계의 작은 fixture를 둔다.
- DB 간 속도를 직접 비교하려면 공통 의미와 경계 처리를 정의하고 결과 일치를 먼저 검증한다. 불일치하면 DB 간 순위표를 만들지 않는다.
- PostgreSQL 반경 검색을 geography로 한다면 geography 컬럼 또는 해당 cast의 expression index를 준비한다. geometry GiST가 임의의 cast에도 그대로 적용된다고 가정하지 않는다.

## 6. 데이터 확대

실제 데이터부터 측정한다. 14,025건에서 차이가 작아도 유효한 결과다. 차이를 만들기 위해 더미 데이터를 무조건 늘리지 않는다.

합성 데이터 단계는 총 10만 → 100만 건이며, 1,000만 건은 디스크·메모리·실행 시간을 확인한 뒤 선택한다. 어느 수도 카카오모빌리티의 실제 규모를 뜻하지 않는다.

생성 규칙:

- 고정 seed와 생성기 버전을 기록한다. 모든 비교 모델은 같은 생성 결과를 재사용한다.
- 실제 좌표를 기반으로 근처에 분포시키는 밀집형과 직사각형 균등 분포를 분리한다. 실제 도로 위 시설 또는 서비스 트래픽을 정확히 재현한다고 주장하지 않는다.
- 시설 비율은 실제 비율, 50:50, 95:5를 단계적으로 비교한다. 모든 조합을 처음부터 실행하지 않는다.
- 실제 레코드를 단순히 같은 좌표로 반복 복제하지 않는다. 고유 ID를 만들고 좌표·속성 길이 분포를 명시한다.
- 서울 범위의 점 수를 늘리는 것은 밀도 증가 실험이다. 전국 범위 확대와 구분한다.
- 검색 요청도 균등 분포와 일부 도심에 집중되는 분포를 구분한다. 밀집 시설 분포와 인기 검색 분포는 다른 변수다.
- 합성 데이터는 서비스 데이터와 다른 DB/schema 및 파일 경로에 저장한다.

## 7. 측정 방법

### 공정성

- DB 버전, PostGIS 버전, CPU 아키텍처, RAM, Docker 자원 제한, 디스크, 데이터·인덱스 크기, 연결 수를 기록한다.
- 먼저 단일 클라이언트로 구조 영향을 본다. 동시성 8·32와 읽기/쓰기 혼합은 후속 부하 실험이다.
- 적재·인덱스 생성을 완료하고 PostgreSQL ANALYZE 후 측정한다. 다른 실험의 적재와 벤치마크를 동시에 실행하지 않는다.
- 동일 데이터, 조회 조건, 반환 필드, 정렬·LIMIT 조건을 사용한다. COUNT(*)만 빠르다고 실제 데이터 조회도 빠르다고 결론 내리지 않는다.
- 조건별 워밍업 10회 후 본 측정 200회, 실행 순서를 섞고 3라운드 반복한다. 200회의 p95도 추정치이며 분산과 원자료를 남긴다.
- 제한 시간 내에 끝나지 않은 쿼리는 누락하지 않고 timeout으로 기록한다.

### 시간의 구분

- 클라이언트: 연결 풀 확보 이후 쿼리 실행부터 마지막 행/문서를 소비할 때까지의 시간. MongoDB 최초 배치 반환만 재지 않는다.
- DB 실행계획: PostgreSQL `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`, MongoDB `explain("executionStats")`를 대표 조건에 대해 별도 수집한다.
- EXPLAIN 자체의 계측 오버헤드와 계획 캐시 차이가 있으므로 이를 일반 쿼리 지연 시간과 동일시하지 않는다.
- 최종 API 지연에는 JSON 직렬화·네트워크·서버 비용이 추가된다. 프론트 지도 렌더링은 이 실험에서 제외한다.
- 기본 결과는 warm-cache다. 컨테이너 재시작만으로 OS 파일 캐시가 지워졌다고 주장하지 않는다.

### 기록할 값

- 지연 시간 p50/p95, 반복 간 변동, 반환 건수·바이트, 처리량과 오류·timeout 비율.
- PG 실제/추정 행 수, 필터로 제거한 행, 버퍼 hit/read, 선택된 scan 종류.
- MongoDB nReturned, totalDocsExamined, totalKeysExamined, winningPlan.
- 최초 적재·인덱스 구축 시간, 재적재/upsert 시간, 데이터·인덱스 디스크 사용량.
- 일부 갱신 후 크기·지연 변화. 실험용 snapshot을 복원하고 동일한 갱신 집합을 사용한다.

유의미한 차이는 절대 지연, 상대 차이, 반복 변동을 함께 보고 판단한다. 최저 시간 하나만 선택하지 않는다. 성능이 비슷하면 단순성·제약·확장·운영 비용으로 선택한다.

## 8. 속도 외의 평가

| 기준 | 통합 | 분리 |
|---|---|---|
| 종류별 필수 속성 | 조건부 제약 또는 validator가 복잡해질 수 있음 | 종류별 제약을 직접 표현하기 쉬움 |
| 전체 지도 검색 | 하나의 조회 경로 | UNION/병합과 정렬 필요 |
| 새 시설 종류 추가 | 공통 필드 재사용, 제약·인덱스 변경 검토 | 새 테이블/컬렉션과 조회 경로 추가 |
| 종류별 적재·재처리 | 종류 조건 누락 방지 필요 | 작업 경계를 분리하기 쉬움 |
| 참조 관계 | 공통 시설 참조를 한 곳으로 만들기 쉬움 | 종류별 참조 또는 공통 상위 엔티티 필요 |
| 속성 차이 | JSON 또는 조건부 nullable 필드 설계 필요 | 전용 필드 설계 가능 |
| 운영 | 공통 통계·정책과 인덱스 관리 | 통계·인덱스·권한·보존 정책을 종류별로 관리 |

같은 DB 인스턴스의 테이블 분리는 CPU·I/O·장애를 완전히 격리하지 않는다. 종류가 둘이라는 사실만으로 통합 또는 분리의 속도 우위를 결정할 수 없다.

## 9. 적재 및 재현 구현 범위

1. 원본 파일을 변경하지 않고 checksum, 취득일, 원천 기준일, 컬럼·CRS 해석을 기록한다.
2. 필수값·중복 ID·숫자/범위·종류별 규칙을 검수하고 실패 행과 이유를 남긴다. 중복의 임의 마지막 행 채택은 하지 않는다.
3. 동일한 정규화 레코드 묶음을 4개 모델에 적재한다. 재실행은 고유 키 기준 upsert하며 원본에 없는 행을 자동 삭제하지 않는다.
4. 적재 건수·내용·재적재 불변성을 검증한다. 두 DB에 걸친 원자적 트랜잭션을 가정하지 않고 각각의 실행 상태를 기록한다.
5. 실제 데이터와 10만 건에서 결과 동일성·실행계획·측정 도구를 먼저 검증한다.
6. 100만 건, 인덱스 대안, 비율·분포를 단계적으로 확대한다.
7. raw 측정값, 계획, 환경 정보를 저장하고 관측 사실·원인 가설·한계를 나눈 보고서를 만든다.

기존 Java/Spring 계획을 유지하고 적재·검수·조회 역할을 나눈다. 벤치마크는 ORM 자동 생성 SQL 차이를 피하기 위해 명시적 SQL 및 MongoDB driver 쿼리를 사용한다. API와 지도 연결은 DB 실험과 별도 단계로 둔다.

2026-09-25 후속 구현에서 Docker Desktop을 실행하고 compose.yaml로 두 DB를 구성했다. Java 적재·검증 도구는 backend/에 있다. 실제 적재 결과는 별도 검증 기록을 참조한다. 대규모 성능 측정은 아직 수행하지 않았다.

## 10. 참고 자료

- 공고: https://careers.kakao.com/jobs/S-4757?company=SUBSIDIARY
- 버스: https://data.seoul.go.kr/dataList/OA-15067/S/1/datasetView.do
- 따릉이: https://data.seoul.go.kr/dataList/OA-13252/F/1/datasetView.do
- PostgreSQL JSON/JSONB: https://www.postgresql.org/docs/current/datatype-json.html
- PostgreSQL partial indexes: https://www.postgresql.org/docs/current/indexes-partial.html
- PostgreSQL partitioning: https://www.postgresql.org/docs/current/ddl-partitioning.html
- PostgreSQL EXPLAIN: https://www.postgresql.org/docs/current/using-explain.html
- PostGIS indexes: https://postgis.net/workshops/postgis-intro/indexing.html
- MongoDB data modeling: https://www.mongodb.com/docs/manual/core/data-modeling-introduction/
- MongoDB schema validation: https://www.mongodb.com/docs/manual/core/schema-validation/
- MongoDB 2dsphere: https://www.mongodb.com/docs/manual/core/indexes/index-types/geospatial/2dsphere/
- MongoDB geospatial restrictions: https://www.mongodb.com/docs/v8.0/core/indexes/index-types/index-geospatial/
- MongoDB geoWithin: https://www.mongodb.com/docs/manual/reference/operator/query/geowithin/
- MongoDB explain: https://www.mongodb.com/docs/manual/tutorial/analyze-query-plan/
