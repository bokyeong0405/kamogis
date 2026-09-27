# KAMOGIS — 서울 공공 교통 데이터 공간 정보 실험

서울시 버스정류소·따릉이 대여소·행정동 경계·전국 도시철도 역과 노선을 PostGIS에 적재하고, bbox 조회 API와 지도 화면으로 확인한 기록이다.

만드는 것보다 **왜 그렇게 정했는지를 남기는 것**에 무게를 뒀다. 저장 모델은 네 가지를 실제로 만들어 재고 골랐고, 좌표계는 7종을 같은 점에 대해 비교했으며, 도시철도 노선은 원본에 순서 정보가 없다는 사실을 확인하고 어디까지 말할 수 있는지를 따로 정리했다. 측정하지 않은 것은 결론으로 쓰지 않았고, 원본의 오류는 고치지 않고 기록만 남겼다.

## 무엇이 들어 있나

| 데이터 | 건수 | 저장 위치 |
|---|---|---|
| 서울시 버스정류소 | 11,236 | `separated.bus_stops` |
| 서울 공공자전거(따릉이) 대여소 | 2,789 | `separated.bike_stations` |
| 서울 행정동 경계 | 427 | `boundary.admin_dongs` |
| 전국 도시철도 역 | 1,094 | `transit.subway_stations` |
| 도시철도 노선 형상 | 50 | `transit.subway_lines` |

비교 실험용으로 같은 시설 데이터가 PostgreSQL 통합 테이블(`unified.facilities`)과 MongoDB의 통합·분리 컬렉션에도 들어 있다.

## 구성

```
브라우저 ── React + OpenLayers (Vite, 5173)
              │  /api → 프록시
              ▼
           Spring Boot 조회 API (58080)   backend/src/.../ApiServer.java
              │  JDBC
              ▼
           PostgreSQL 17.5 + PostGIS 3.5.2 (55432)
           MongoDB 8.0 (57017) — 비교 실험용
```

화면은 레이어 토글, 지도 이동 시 bbox 재조회, 속성 필터 칩, 행정동 클릭 필터와 요약 패널, 좌표계 7종 전환과 오용 재현을 담고 있다.

## 실행

필요 도구: Java 21, Maven 3.9+, Node.js 22.12+, Docker Compose v2.

**1. 자격증명.** 접속 정보는 전부 환경변수로 읽는다. 저장소에 비밀번호를 두지 않으며, 설정하지 않으면 연결을 시도하기 전에 멈춘다.

```sh
cp .env.example .env     # 비밀번호를 직접 채운다
```

`docker compose`는 같은 디렉터리의 `.env`를 자동으로 읽는다. `mvn`/`java`는 읽지 않으므로 `./run-api.sh`가 대신 불러오며, 직접 `mvn`을 칠 때만 `set -a; source .env; set +a`가 필요하다.

**2. 원본 데이터.** 저장소에 포함하지 않는다([아래](#데이터-출처와-라이선스) 참조). `data/raw/`에 내려받은 뒤 검증한다.

```sh
mvn -f backend/pom.xml exec:java -Dexec.args="validate data/raw"
```

**3. 적재와 실행.**

```sh
docker compose up -d                                   # PostGIS + MongoDB
mvn -f backend/pom.xml exec:java -Dexec.args="import data/raw --crs=4326"
mvn -f backend/pom.xml exec:java -Dexec.args="verify data/raw --crs=4326"
```

그다음 **터미널 두 개**를 쓴다. 프런트의 Vite dev 서버가 `/api`를 127.0.0.1:58080으로 프록시하므로, 둘 다 떠 있어야 지도에 데이터가 올라온다.

```sh
./run-api.sh                             # 조회 API, 58080
cd frontend && npm ci && npm run dev     # 지도, http://127.0.0.1:5173
```

행정동과 도시철도는 스키마가 달라 별도 적재 스크립트를 쓴다. 자세한 절차는 각 SQL 파일 상단 주석에 있다.

```sh
docker compose exec -T postgres psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 < db/postgres/load-admin-dongs.sql

python3 db/postgres/subway-xlsx-to-csv.py data/raw/전체_도시철도역사정보_20260630.xlsx /tmp/subway-stations.csv
docker compose cp /tmp/subway-stations.csv postgres:/tmp/subway-stations.csv
docker compose exec -T postgres psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 < db/postgres/load-subway.sql
```

API 사용법과 설계 근거는 [backend/README.md](backend/README.md)에 있다.

## 읽을 만한 기록

세 가지가 이 저장소의 실제 내용물이다.

**[저장 모델 네 가지 비교](docs/research/2026-09-25-benchmark-results.md)** — PostgreSQL·MongoDB × 통합·분리 네 모델을 전부 만들고 단건·bbox 조회를 200회 × 3라운드로 쟀다. 결론은 PostgreSQL + 종류별 분리 테이블. **엔진 간 속도 순위는 내지 않는다** — PostGIS 컨테이너가 Apple Silicon에서 amd64 에뮬레이션으로 돌고 두 엔진의 bbox 의미(평면 대 구면)가 달라서, 그 숫자로 우열을 말하면 틀린다. 비교는 같은 엔진 안의 통합 대 분리로 한정했다. 설계는 [측정 설계](docs/research/2026-09-25-db-model-benchmark.md), 적재 동등성 확인은 [저장 모델 검증](docs/research/2026-09-25-storage-verification.md).

**[좌표계 7종 비교](docs/research/2026-09-25-crs-seven-systems.md)** — 4326·3857·5179·5186·5181(카카오맵)·5174(Bessel)·32652를 같은 점에 대해 변환하고 차이를 쟀다. 여기에 "A로 계산한 좌표를 B라고 알려주면 지도 어디에 찍히나"를 실제로 그려 봤다. 5174를 5181로 잘못 읽으면 **313~318 m**(datum 누락 — 한 블록 차이라 화면에 보인다), 5186을 5181로 잘못 읽으면 좌표값은 항상 정확히 100,000 m지만 **지상거리는 99,956~100,000 m**(TM 축척왜곡, `k≈1+x²/2R²`로 cm까지 재현된다). 둘 다 전국 상수가 아니고 원인이 서로 다르다. 해석 결정 과정은 [좌표계 결정 기록](docs/research/2026-09-25-crs-decision.md).

**[도시철도 노선 — 역 순서의 근거와, 판단이 안 되는 노선](docs/research/2026-09-26-subway-lines.md)** — 원본에 운행순번·상하행·인접역·영업거리·개통일이 **전부 없고** 순서 신호가 역번호 하나뿐이다. 역번호를 그대로 쓰면 깨지는 세 가지를 고쳤고(자릿수 혼재 19,602→3,336 m, 지선 혼입 7,821→2,283 m, 2호선 순환선 미폐합), 그래도 순서를 만들 수 없는 8개 노선은 점선으로 구분해 내보낸다. 검수 지표 4종이 서로를 대체하지 않는다는 것, 원본 좌표 오류 3건이 **각각 다른 지표에만 걸린다**는 것, 그리고 `max_gap_m`이 튀었다고 원인이 순서라고 단정하면 틀린다는 것(경의중앙선 190 km는 좌표 오류 탓이고 순서 문제만의 크기는 58.87 km)이 핵심이다.

설계 문서는 [프로젝트 1 — 공공데이터 지도 백엔드](project_01_public_data_map_design.md)와 [프로젝트 2 — 같은 장소, 다른 좌표계](project_02_crs_experiments_design.md)에 있다.

## 데이터 출처와 라이선스

| 데이터 | 출처 | 기준일 | 이용조건 |
|---|---|---|---|
| 버스정류소 위치정보 | [서울열린데이터광장 OA-15067](https://data.seoul.go.kr/dataList/OA-15067/S/1/datasetView.do) | 2026-09-02 | 서울열린데이터광장 이용약관 |
| 공공자전거 대여소 정보 | [서울열린데이터광장 OA-13252](https://data.seoul.go.kr/dataList/OA-13252/F/1/datasetView.do) | 2026-06 | 서울열린데이터광장 이용약관 |
| 행정동 경계 | [vuski/admdongkor ver20260701](https://github.com/vuski/admdongkor) | 2026-07-01 | CC BY 4.0(가공) / 원자료 SGIS **공공누리 제1유형** — 출처 표기 필수 |
| 전국도시철도역사정보표준데이터 | [공공데이터포털 15013205](https://www.data.go.kr/data/15013205/standard.do) (국가철도공단) | 2026-06-30 | 이용허락범위 제한 없음 |
| 배경지도 타일 | OpenStreetMap | — | ODbL, 저작자 표시 노출 |

**원본 데이터 파일은 저장소에 포함하지 않는다.** 재배포 대신 출처를 남긴다. 각 파일의 sha256·행수·검증 결과·발견한 오류는 [data/raw/manifest.json](data/raw/manifest.json)에 그대로 기록되어 있어, 같은 파일을 받았는지 해시로 확인할 수 있다.

```sh
mkdir -p data/raw
curl -L -o data/raw/hangjeongdong-20260701.geojson \
  https://raw.githubusercontent.com/vuski/admdongkor/master/ver20260701/HangJeongDong_ver20260701.geojson
shasum -a 256 data/raw/*    # manifest.json의 sha256과 대조
```

서울열린데이터광장 두 건과 공공데이터포털 도시철도 데이터는 **포털이 JS 기반 POST 방식이라 스크립트로 받을 수 없다.** 위 표의 링크에서 직접 내려받아 `data/raw/`에 두고, 파일명은 manifest의 `path` 값에 맞춘다.

**원본의 오류는 고치지 않고 기록만 한다** — 재현 가능성을 위해서다. 도시철도 좌표 오류 3건이 그 예로, 모두 manifest에 남아 있고 적재 결과에도 그대로 들어 있다.

## 알아 둘 것

- 행정동 경계는 **동당 평균 44개 정점으로 단순화되어 있다.** 면적 합 606.68 km²(공식 605.2, +0.24%), 인접 동 1쌍이 707.6 m² 겹치고, 시설 21건이 경계 밖 0.6~229 m에 놓인다. 정밀 경계가 필요한 결론에는 쓸 수 없다.
- 도시철도 노선 형상은 `ST_MakeLine(geom ORDER BY sort_key)`, 즉 **역을 이은 모식도이지 실제 선로가 아니다.** 길이를 노선 연장으로 읽으면 안 된다.
- 행정동 코드는 두 체계가 섞여 있다. `adm_cd`(8자리, 통계청 SGIS)와 `adm_cd2`(10자리, 행안부 행정표준코드)는 동 부분이 427건 중 141건만 우연히 일치한다. **다른 공공데이터와 조인할 키는 `adm_cd2`다.**
- **접속 정보는 전부 `.env`에서 읽는다.** 코드·`compose.yaml`·`application.properties` 어디에도 비밀번호 기본값이 없어서, 설정하지 않으면 연결 전에 실패한다. 호스트 포트는 127.0.0.1에만 바인딩하며 원격 배포용 구성이 아니다.
