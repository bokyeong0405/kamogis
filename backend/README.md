# 네 가지 공간 데이터 저장 모델 + 조회 API

Java 21 CLI로 동일한 서울 공공데이터를 네 모델에 저장하고, Spring Boot API로 분리 테이블을 조회한다.

1차 벤치마크(2026-09-25, docs/research/2026-09-25-benchmark-results.md) 결과에 따라 서비스 저장소는 **PostgreSQL + PostGIS의 종류별 분리 테이블**(separated.bus_stops, separated.bike_stations)로 결정했다. MongoDB와 통합 테이블은 비교 실험 기록으로 유지한다.

## 조회 API

```sh
./run-api.sh
```

`run-api.sh`는 `.env`를 셸에 불러온 뒤 아래를 실행한다. 환경변수를 이미 export 했다면 직접 쳐도 된다.

```sh
mvn -f backend/pom.xml compile exec:java -Dexec.mainClass=kr.kamogis.ApiServer
```

- `GET /api/layers/bus-stops?bbox=minLon,minLat,maxLon,maxLat`
- `GET /api/layers/bike-stations?bbox=minLon,minLat,maxLon,maxLat`
- `GET /api/layers/bus-stops/facets`, `GET /api/layers/bike-stations/facets`
- `GET /api/layers/admin-dongs?bbox=minLon,minLat,maxLon,maxLat` (행정동 경계, MultiPolygon)
- `GET /api/layers/subway-stations?bbox=...` (도시철도 역, Point)
- `GET /api/layers/subway-lines?bbox=...[&verified=false]` (도시철도 노선, LineString)
- 포트 58080(`application.properties`). bbox는 EPSG:4326 경도·위도 순서이며 개수·숫자·범위·min<max를 검증해 위반 시 400을 돌려준다. 응답은 GeoJSON FeatureCollection, 좌표는 [경도, 위도]. 경계 위 Point는 포함된다(ST_Intersects).

### 속성 필터

bbox 뒤에 속성 값을 덧붙여 `attributes->>'키' IN (...)`으로 좁힌다. 버스는 `stop_type`, 따릉이는 `operation_mode`와 `district`를 받는다.

```sh
curl -G localhost:58080/api/layers/bus-stops \
  --data-urlencode "bbox=126.97,37.55,127.02,37.59" \
  --data-urlencode "stop_type=일반차로" --data-urlencode "stop_type=중앙차로"
```

- 값이 여러 개면 **같은 이름의 파라미터를 반복**한다. 쉼표로 구분하지 않는 이유는 `operation_mode`의 실제 값에 `LCD,QR`처럼 쉼표가 들어 있기 때문이다.
- 필터 가능한 키는 `ApiServer.Layer.facetKeys()`의 상수 목록뿐이다. 요청에서 온 이름은 SQL에 넣지 않으며 값은 전부 바인딩 파라미터로 넘긴다.
- `/facets`는 각 키의 값과 건수를 반환한다. 개수는 bbox와 무관한 **테이블 전체 기준**이며 프런트엔드의 필터 칩 목록과 색상 순서를 만든다.
- 필터는 GiST bbox 스캔으로 후보를 줄인 뒤 heap에서 거르는 단계에 붙는다. 이 조건을 위한 별도 인덱스는 두지 않았다.
- 프런트엔드(frontend/, Vite dev 서버)는 `/api`를 127.0.0.1:58080으로 프록시한다.

### 행정동 경계

`boundary.admin_dongs`(서울 427건)를 bbox로 조회한다. 시설 레이어와 다른 점만 적는다.

- geometry가 MultiPolygon이라 좌표를 Java 객체로 풀지 않고 `ST_AsGeoJSON(geom,6)` 결과를 Jackson `RawValue`로 그대로 흘려보낸다. 427건 전체가 436 kB라 파싱 후 재직렬화하면 그만큼을 왕복으로 버린다.
- 소수점 6자리는 서울 위도에서 약 0.11 m다. 경계가 동당 평균 44개 정점으로 단순화되어 있어 더 정밀하게 보낼 이유가 없다. 15자리 기본값 대비 547 kB → 436 kB.
- **점과 달리 GiST recheck가 실제로 걸러낸다.** 인덱스에는 도형이 아니라 bounding box만 들어 있는데, Point는 bbox가 자기 자신이라 `&&` 통과 = 정답이지만 Polygon은 bbox가 실제 도형보다 크다. 종로 일대 bbox 조회에서 `Bitmap Index Scan` 41행 → `Rows Removed by Filter: 1` → 40행으로 좁혀진다.
- 적재 절차는 `db/postgres/load-admin-dongs.sql` 주석 참조. 스키마는 `db/postgres/02-boundary.sql`.
- 프런트엔드는 경계를 시설 점보다 **아래** 레이어에 깐다. 시설 점이 위에 있으므로 클릭이 점을 맞히면 상세 패널이 뜨고, 빈 곳을 눌렀을 때만 아래 행정동이 잡힌다. 동 이름표는 resolution 25(대략 zoom 13) 이하에서만 그린다.

### 행정동으로 시설 좁히기

시설 조회에 `adm_cd`(8자리 SGIS 행정동 코드)를 붙이면 그 동 안의 시설만 남는다. 속성 필터와 함께 쓸 수 있다.

```sh
curl -G localhost:58080/api/layers/bus-stops \
  --data-urlencode "bbox=126.9,37.5,127.1,37.62" \
  --data-urlencode "adm_cd=11010530" --data-urlencode "stop_type=마을버스"
```

- 조건은 `EXISTS (SELECT 1 FROM boundary.admin_dongs d WHERE d.adm_cd=? AND ST_Contains(d.geom,f.geom))`이다. `adm_cd`는 바인딩 파라미터이며 속성 필터와 달리 키 이름이 고정이라 화이트리스트가 필요 없다.
- **시설 테이블에 별칭 `f`를 붙이는 것이 필수다.** `boundary.admin_dongs`에도 `geom` 컬럼이 있어서, 한정하지 않은 `geom`은 서브쿼리 안쪽 스코프가 이겨 경계 테이블에 묶인다. 에러 없이 조용히 틀린 결과가 나온다.
- 계획은 `admin_dongs_pkey`로 동 1건을 찾은 뒤 시설 GiST를 한 번만 훑는다. **동의 bounding box(`geom @ d.geom`)가 bbox 조건과 함께 Index Cond로 들어간다.** 사직동 예시에서 후보 52건 → recheck 후 30건, 2.5 ms.
- `GET /api/layers/admin-dongs/{adm_cd}/summary`는 그 동의 시설 구성을 돌려준다. 면적·행정표준코드와 레이어별 총계, 그리고 각 `facetKeys`의 값별 건수다. 없는 코드는 404.
- **요약은 bbox와 속성 필터에 영향받지 않는다.** 지도에 그려진 것이 아니라 동 전체를 세므로, 마을버스를 꺼도 가회동 요약은 22건(마을버스 20·일반차로 2)을 그대로 보여준다. 패널에도 이 차이를 적어 둔다. 지도 위 개수를 다시 집계하면 필터를 켤 때마다 동의 실제 구성이 왜곡된다.
- 따릉이 요약에는 `district`도 들어간다. 같은 동 안에서는 보통 한 값뿐이지만, 속성의 자치구와 공간상 자치구가 어긋나는 9건(예: 황학동롯데캐슬은 속성 중구·위치 종로구)에서는 두 값이 보인다. 데이터 품질 확인용으로 남겨 둔다.
- bbox 조건은 동을 골라도 유지된다. 대신 프런트엔드가 선택한 동의 extent로 지도를 맞춰서(`view.fit`) 동 전체가 화면에 들어오게 한다. 경계 레이어를 끄면 보이지 않는 필터가 남지 않도록 동 선택도 함께 해제한다.

### 도시철도 역과 노선

원본은 국가철도공단 전국도시철도역사정보표준데이터(기준일 2026-06-30, 1,099행, 이용허락범위 제한 없음)다. 스키마는 `db/postgres/03-transit.sql`, 적재는 `db/postgres/subway-xlsx-to-csv.py` + `db/postgres/load-subway.sql`. 결과는 역 1,094건 · 노선 50건. 순서의 근거와 미검증 노선의 원인은 [도시철도 노선 형상 — 역 순서의 근거와, 판단이 안 되는 노선](../docs/research/2026-09-26-subway-lines.md)에 따로 정리했다.

- **서울로 자르지 않고 전국을 다 넣는다.** 노선이 시계를 넘나들어서 자르면 경계에서 선이 끊긴다. 화면에 무엇이 보일지는 bbox 조회가 정한다.
- **역번호는 전역 고유가 아니다**(1,099행 중 146건 중복). 노선 안에서만 유일하므로 PK는 `(line_code, station_code)`다. 그 조합마저 겹치는 5건은 `DISTINCT ON`으로 줄이며, 역명 표기가 다를 때는 **긴 쪽을 남긴다**(7호선 공식 역명이 '총신대입구(이수)'이고 '이수'가 축약형이다).
- 노선 형상은 `ST_MakeLine(geom ORDER BY sort_key)`, 즉 **역을 순서대로 이은 모식도**다. 곡선·터널·우회가 전부 직선으로 뭉개지므로 길이를 실제 노선 연장으로 읽으면 안 된다.

순서를 만드는 데 세 번 걸렸다. 앞의 둘은 인접 역 최대 직선거리(`max_gap_m`)로 확인했고, 셋째는 그 지표로 잡히지 않는다.

- **역번호 자릿수가 섞여 있다.** 3자리와 4자리가 같은 노선에 들어온다(8호선 별내 연장 806 vs 본선 0809). 문자열 정렬이면 806이 0809보다 뒤로 가서 노선이 19,602 m를 건너뛴다. 숫자만인 역번호를 4자리로 `lpad`해 3,336 m가 됐다.
- **지선이 한 노선으로 섞인다.** 역번호 선행 알파벳으로 `branch`를 갈라 5호선 본선과 마천지선(P)을 분리했고 7,821 m → 2,283 m. 52개 노선 그룹 중 접두어가 섞인 것은 S1105 하나뿐이라, 이 규칙은 갈라야 할 것만 정확히 가른다.
- **2호선 본선은 순환선인데 역번호가 시청(0201)→충정로(0243) 한 방향으로만 매겨져 있다.** 그대로 두면 도심에서 한 구간이 비어 보인다. 두 역이 실제 인접역이므로 첫 점을 끝에 덧붙여 고리를 닫는다. 빠져 있던 구간은 1,044.2 m로 이 노선 최대 간격 1,992 m보다 짧아 **`max_gap_m`은 고리 닫기 전후가 똑같다** — 지표 하나로는 안 잡히는 종류의 결함이다. 순환 구조는 역 목록만으로 알 수 없어 **노선을 지정하는 예외**로 두었다.

`order_verified`는 임계값이 아니라 **검토 결과**다. 인접 역 간격이 큰 노선을 하나씩 열어, 실제로 역 사이가 먼 것(인천국제공항선 10.16 km 영종대교, 경원선 8.49 km 전곡–연천, 진접선 7.86 km, 신분당선 7.74 km, 경춘선 7.21 km 등)과 역번호가 운행 순서가 아닌 것을 갈랐다. 후자 여덟(경의중앙선·경부선·경강선·분당선·수인선·경인선·동해선·안산과천선)이 `false`이며 `/subway-lines`는 기본적으로 빼고 내려보낸다. `verified=false`를 붙이면 전부 받는다.

여덟의 원인은 하나다 — **역번호가 운행 순서가 아니라 "묶음" 단위로 매겨져 있고, 묶음이 노선의 어디에 들어가는지를 알려 주는 컬럼이 원본에 없다.** 겉모습은 셋으로 나타난다. ① 묶음의 역들을 앞 묶음 사이사이에 끼워 넣어야 하는 경우(경부선의 1032 신길·1714 독산·1729 당정·1749 서동탄·1750 광명, 경인선, 분당선) ② 묶음이 통째로 한 자리에 들어가야 하는 경우(수인선의 1755~1762가 1877과 1878 사이로, 경의중앙선의 중앙선·경의선 계열 병합 — 1220 지평 → 1251 서울역 58.87 km) ③ 묶음이 역 하나인 경우(경강선 1512 성남, 동해선 8015 부산원동, 안산과천선 1763 수리산). ③은 역번호에 빈칸조차 없어 블록 구조 검사로는 안 걸리고 최근접역 검사로 찾았다.

**거리 임계값으로는 이 구분을 만들 수 없다.** 대경선 왜관–서대구 17.56 km는 사이에 역이 없는 진짜 구간이고 동해선 17.74 km는 순서 오류인데, 크기가 겹친다. 수도권 밖 노선도 같은 방식으로 확인했다.

- **`transit.subway_lines`에는 `ST_IsValid` CHECK를 걸지 않았다.** `admin_dongs`와 달리 지하철 노선은 자기교차가 정상이다.
- 대신 **원본의 좌표 오류 세 건을 찾았고, 찾아낸 지표가 전부 다르다.** ① 경의중앙선 1204 양원역은 주소가 서울 중랑구 송림길인데 좌표가 경북 봉화 일대(약 190 km)다 — `max_gap_m`이 튀어 발견했고, 시·도별 좌표 중앙값 검사로 같은 종류가 이 한 건뿐임을 확인했다. ② 5호선 마곡(0514)이 발산(0515)에서 7.1 m — `ST_IsSimple`이 false여서 걸렸고, 두 좌표를 바꿔 넣으면 true가 되어 원인을 재현 확인했다. ③ 4호선 이촌(0430)이 신용산(0429)에서 14.3 m — `ST_IsSimple`이 **true**라 안 잡혀 최근접역 검사로 찾았다. 세 건 모두 도로명주소와 좌표가 서로 모순이라 최소한 한쪽이 틀렸다는 것까지가 원본 안에서 말할 수 있는 전부다. **`max_gap_m`이 튀었다고 원인이 순서라고 단정하면 안 된다** — 경의중앙선의 190.79 km는 순서가 아니라 ①이 만든 값이고, 순서 문제만의 크기는 58.87 km다. 프로젝트 관례대로 **셋 다 고치지 않고 manifest에 기록만 했다.**
- **`line_code` 하나에 노선명이 둘 붙는 경우를 합치지 않는다**(I4101=1호선·경부선, S1109=서울·수도권 9호선). 합치면 깨끗한 1호선 10개 역이 망가진 경부선에 흡수되고, 어디까지 합칠지가 판단이 되어 재현이 안 된다. 대가로 9호선·7호선은 두 구간의 이음매 한 칸이 비어 보인다.
- 좌표가 완전히 같은 12개 그룹은 전부 노선이 다른 환승역이다(같은 노선 안의 동일 좌표 0건). 중복이 아니라 정상이다.
- 프런트엔드는 **노선을 경계 위·시설 점 아래, 역을 맨 위** 레이어에 둔다. 버스정류소가 화면당 수천 개라 역을 그 아래 두면 묻혀서 보이지도 눌리지도 않는다. 미검증 노선은 점선으로 그려 실선과 같은 무게로 보이지 않게 한다. 역 이름표는 resolution 10 이하에서만 그린다.

| DB | 통합 | 분리 |
|---|---|---|
| PostgreSQL + PostGIS | unified.facilities | separated.bus_stops, separated.bike_stations |
| MongoDB (kamogis DB) | facilities | bus_stops, bike_stations |

`facility_type`: 0=버스, 1=따릉이. 모든 원천 ID는 문자열이다. 통합 고유 키는 (종류, 원천 ID), 분리 고유 키는 원천 ID다. MongoDB 분리 문서에도 종류를 유지해 동일한 조회 응답을 만든다.

## 실행

필요 도구: Java 21, Maven 3.9+, Docker Compose v2. 저장소 루트에서:

```sh
cp .env.example .env && set -a && source .env && set +a   # 최초 1회 + 새 셸마다
docker compose up -d
docker compose ps
mvn -f backend/pom.xml test
mvn -f backend/pom.xml compile exec:java -Dexec.args="validate data/raw"
mvn -f backend/pom.xml compile exec:java -Dexec.args="import data/raw --crs=4326"
mvn -f backend/pom.xml compile exec:java -Dexec.args="verify data/raw --crs=4326"
mvn -f backend/pom.xml compile exec:java -Dexec.mainClass=kr.kamogis.Benchmark
```

`data/raw/`의 원본 파일은 저장소에 없다. 출처와 내려받는 방법은 루트 [README](../README.md#데이터-출처와-라이선스), 각 파일의 sha256과 검증 결과는 `data/raw/manifest.json`에 있다.

벤치마크(`Benchmark.java`)는 4개 모델 × (단건 + bbox 3영역 × 필터 3종)을 워밍업 10회, 200회 × 3라운드로 측정하고 `docs/research/bench/<날짜>/`에 raw.csv·summary.json·equality.json·sizes.json·env.json·plans/를 남긴다. `--warmup= --iters= --rounds= --out=`으로 재정의할 수 있다. 결과 해석은 `docs/research/2026-09-25-benchmark-results.md` 참조.

Docker context가 기본 소켓과 다르면 `docker --context desktop-linux compose ...`를 사용한다.
검증 시 임시 다운로드한 Maven은 `/tmp/apache-maven-3.9.9/bin/mvn`, 의존성 캐시는 `-Dmaven.repo.local=/tmp/kamogis-m2`를 사용했다. 임시 경로에 의존하지 않도록 평소에는 설치된 Maven을 사용한다.

로컬 포트: PostgreSQL 55432, MongoDB 57017(기본값, `.env`에서 변경 가능). 호스트 포트는 127.0.0.1에만 바인딩한다. 원격 서비스에 그대로 배포하지 않는다.

**접속 정보는 저장소에 두지 않는다.** `.env.example`을 `.env`로 복사해 비밀번호를 채우고 셸에 불러온다.

```sh
cp .env.example .env
set -a; source .env; set +a
```

`docker compose`는 `.env`를 자동으로 읽지만 `mvn`/`java`는 읽지 않아 위처럼 export가 필요하다. `PG_PASSWORD`·`MONGO_PASSWORD`에는 **기본값이 없다** — `StorageLab.required()`가 없으면 즉시 예외를 던지고, `compose.yaml`은 `${PG_PASSWORD:?...}`로 막고, `application.properties`는 `${PG_PASSWORD}`라 Spring이 기동에 실패한다. 실수로 기본 비밀번호가 붙은 채 배포되는 경로를 없애기 위해서다.

`PG_URL`·`PG_USER`·`MONGO_USER`·`MONGO_HOST`·`API_PORT`는 기본값이 있고, `MONGO_URI`를 직접 주면 조각 대신 그 값을 쓴다. 비밀번호에 특수문자가 있어도 되도록 URI 조립 시 퍼센트 인코딩한다.

PostGIS 이미지는 linux/amd64로 고정했으며 Apple Silicon에서는 에뮬레이션으로 실행한다. 따라서 추후 두 엔진의 절대 속도 비교에 이 환경을 그대로 사용하지 않는다. 구조별 비교에도 아키텍처를 측정 환경에 기록한다. MongoDB는 호스트 지원 아키텍처를 사용한다.

각각의 데이터 볼륨은 `docker compose stop` 이후에도 보존된다. 초기화 SQL/JS는 빈 볼륨의 최초 시작 시 실행된다. 기존 볼륨에 스키마 변경을 적용할 때는 다음 명령을 사용한다.

```sh
docker compose exec -T postgres psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/01-models.sql
docker compose exec -T mongo mongosh -u "$MONGO_USER" -p "$MONGO_PASSWORD" --authenticationDatabase admin /docker-entrypoint-initdb.d/01-models.js
```

`CREATE TABLE IF NOT EXISTS`는 기존 테이블의 컬럼을 변경하지 않는다. 컬럼 변경은 별도 migration이 필요하다. 데이터를 지우는 `down -v`는 일반 실행 절차에 포함하지 않는다.

## 적재와 검증

- XLSX 전체를 먼저 파싱·검증한다. 잘못된 행이 있으면 파일·행 번호·원인을 출력하고 DB 쓰기 전에 중단한다. 부분 성공 적재를 하지 않는다. 현 버전은 첫 오류에서 중단한다.
- source_id 중복, 빈 ID/이름, 종류, 숫자·좌표 범위를 검증한다. ARS-ID 선행 0을 보존한다.
- 입력에 삭제된 ID가 있어도 DB에서 자동 삭제하지 않는다. `verify`는 원본과 DB 전체 내용을 비교하므로 오래된 잔존 행도 불일치로 드러난다.
- PostgreSQL의 통합·분리 세 테이블은 하나의 트랜잭션으로 upsert한다.
- MongoDB는 1,000건 단위 upsert를 순차 실행한다. 전체 import의 원자성은 보장하지 않는다. 실패 시 로그의 완료 단계를 확인하고 같은 명령을 다시 실행한다. 고유 키가 중복을 방지한다.
- 두 DB 사이에 분산 트랜잭션을 사용하지 않는다. PostgreSQL이 완료되고 MongoDB가 실패할 수 있으며 재실행과 verify로 복구한다.
- 네 모델 모두 원본과 전체 필드·좌표·ID를 비교한다. 건수만 비교하지 않는다.
- 두 bbox에 대해 DB별 통합/분리 결과가 같은지 검증한다. PostgreSQL 평면 bbox와 MongoDB 구면 폴리곤 결과가 반드시 같다고 단정하지 않는다.
- 기본 인덱스: 각 저장소의 고유 키 및 GiST/2dsphere. 부분/복합 인덱스와 파티션은 이후 실험 구성으로 추가한다.

커넥션 설정은 `PG_URL`, `PG_USER`, `PG_PASSWORD`, `MONGO_URI`로 재정의할 수 있다. 지정한 DB에 쓰므로 기존 업무 DB를 지정하지 않는다.

좌표계 결정은 `docs/research/2026-09-25-crs-decision.md`, 측정 설계는 `docs/research/2026-09-25-db-model-benchmark.md`에 있다. 이번 단계는 모델·실데이터 적재 검증이며 대규모 성능 우열 결론을 내리지 않는다.
