# 통합·분리 모델 조회 성능 측정 결과 (1차, 실데이터 14,025건)

측정일: 2026-09-25. 설계는 [2026-09-25-db-model-benchmark.md](2026-09-25-db-model-benchmark.md), 적재 검증은 [2026-09-25-storage-verification.md](2026-09-25-storage-verification.md) 참조.
원자료: `docs/research/bench/2026-09-25/` (raw.csv, summary.json, equality.json, sizes.json, env.json, plans/).

## 1. 결론 요약

1. **같은 엔진 내부에서 결과는 완전히 동일하다.** 9개 bbox×필터 조건 모두 통합·분리 모델의 `(facility_type, source_id)` 집합이 일치했다.
2. **종류 하나만 조회할 때는 두 엔진 모두 분리 모델이 유리하거나 같다.** 기본 인덱스(geom GiST / 2dsphere + 고유 키)만 있는 통합 모델은 종류 필터를 공간 인덱스와 결합하지 못한다.
   - PostgreSQL 통합: 전체 종류의 PK 인덱스를 BitmapAnd로 추가 스캔 (narrow bus p50 10.7ms vs 분리 9.9ms, wide bike 91.4ms vs 68.7ms, −25%).
   - MongoDB 통합: 플래너가 2dsphere 대신 `(facility_type, source_id)` 인덱스를 선택해 해당 종류 전체 11,236건을 검사 (narrow bus p50 19.7ms vs 분리 7.1ms, **2.8배**). 종류 필터를 붙인 조회가 두 종류 모두 가져오는 조회(8.7ms)보다 느린 역전도 발생했다.
3. **두 종류를 함께 조회할 때는 통합 모델이 약간 유리하다.** 분리 모델은 PG `UNION ALL`(wide에서 Gather/Append 오버헤드), MongoDB `$unionWith`(wide both p50 116.9ms vs 122.4ms) 비용을 낸다. 차이는 크지 않다.
4. **단건 조회와 저장 공간은 사실상 무차별.** 단건 p50 0.8~1.0ms, 총 저장량 통합 ≈ 분리 (PG 7.14MB vs 7.09MB).
5. 이 결과는 **기본 인덱스 구성의 1차 비교**다. 스펙의 인덱스 단계 2(PG partial GiST, MongoDB `(facility_type, location)` 복합 인덱스)가 통합 모델의 종류 필터 약점을 줄이는지가 다음 실험이다. 두 엔진 간 속도 순위는 매기지 않는다(§8).

## 2. 환경

- PostgreSQL 17.5 + PostGIS 3.5.2 (컨테이너 linux/amd64, **Apple Silicon 에뮬레이션**), MongoDB 8.0.32 (호스트 아키텍처 aarch64 네이티브)
- 호스트: macOS (Darwin 23.4.0, aarch64), Java 21.0.8, 단일 클라이언트·단일 연결, warm-cache
- 데이터: 버스 11,236 + 따릉이 2,789 = 14,025건 (실데이터, 합성 없음)
- 도구: `backend/src/main/java/kr/kamogis/Benchmark.java`
  실행: `/tmp/apache-maven-3.9.9/bin/mvn -f backend/pom.xml -Dmaven.repo.local=/tmp/kamogis-m2 exec:java -Dexec.mainClass=kr.kamogis.Benchmark`

## 3. 방법

- 조건: 4모델(PG-U/PG-S/MG-U/MG-S) × (단건 + bbox 3영역 × 필터 3종) = 40조건
- bbox: narrow (126.97,37.55,127.02,37.59) / medium (126.90,37.48,127.10,37.62) / wide (126.80,37.44,127.17,37.68)
- 단건: 전체 키에서 seed 42로 뽑은 200개 `(종류, 원천 ID)`를 순환 조회. 네 모델 동일 순서.
- 조건별 워밍업 10회 → 본측정 200회 × 3라운드, 라운드마다 조건 실행 순서를 seed로 섞음. 오류·timeout 0건.
- 시간: 쿼리 실행부터 전 행/문서 소비까지(클라이언트 관점). ANALYZE 후 측정. EXPLAIN은 별도 수집.
- PG는 prepared statement 재사용(bbox는 파라미터 바인딩), EXPLAIN은 리터럴 SQL — 계획이 다를 수 있음을 전제로 기록.
- MongoDB bbox 조회는 모델 간 기계적 차이를 줄이기 위해 모두 aggregate(`$match` [+ `$unionWith`])로 실행. 단건은 find.

## 4. 결과 동등성 (equality.json)

| bbox | 필터 | PG 건수 | PG 통합=분리 | Mongo 건수 | Mongo 통합=분리 | 엔진 간 건수 차 |
|---|---|---:|---|---:|---|---:|
| narrow | bus / bike / both | 518 / 166 / 684 | 모두 일치 | 518 / 166 / 684 | 모두 일치 | 0 |
| medium | bus / bike / both | 6,217 / 1,433 / 7,650 | 모두 일치 | 6,214 / 1,434 / 7,648 | 모두 일치 | +3 / −1 / +2 |
| wide | bus / bike / both | 11,095 / 2,747 / 13,842 | 모두 일치 | 11,095 / 2,748 / 13,843 | 모두 일치 | 0 / −1 / −1 |

엔진 간 건수 차는 PG 평면 `ST_Intersects` vs Mongo 구면 `$geoWithin`의 경계 해석 차이로, 경계 부근 소수 레코드에서만 발생한다. 어느 쪽의 오류가 아니라 의미 차이다.

## 5. 지연 측정 (p50/p95, ms — 600회 통합, 라운드 간 p50 편차는 summary.json 참조)

| 조건 | 행수 | PG-U | PG-S | MG-U | MG-S |
|---|---:|---:|---:|---:|---:|
| 단건 | 1 | 0.86 / 1.50 | 0.80 / 1.38 | 0.82 / 1.89 | 0.85 / 1.64 |
| narrow bus | 518 | 10.71 / 13.34 | 9.91 / 15.10 | **19.65** / 23.65 | **7.14** / 9.42 |
| narrow bike | 166 | 6.84 / 8.25 | 5.71 / 8.52 | 7.41 / 9.02 | 4.78 / 6.62 |
| narrow both | 684 | 14.65 / 24.76 | 15.21 / 22.02 | 8.71 / 11.55 | 9.57 / 11.89 |
| medium bus | 6,217 | 109.13 / 140.31 | 105.97 / 139.71 | 54.34 / 65.81 | 52.02 / 70.02 |
| medium bike | 1,433 | **48.87** / 64.92 | **36.75** / 48.33 | 19.54 / 24.92 | 18.91 / 26.32 |
| medium both | 7,650 | 141.69 / 199.07 | 139.97 / 176.24 | 68.35 / 87.58 | 72.08 / 90.56 |
| wide bus | 11,095 | 192.80 / 239.56 | 188.23 / 242.16 | 87.61 / 111.76 | 87.79 / 108.19 |
| wide bike | 2,747 | **91.38** / 123.62 | **68.68** / 90.80 | 31.21 / 39.77 | 31.74 / 39.96 |
| wide both | 13,842* | 258.05 / 335.79 | 252.17 / 330.64 | 116.92 / 141.42 | 122.37 / 166.18 |

\* Mongo는 13,843건. PG와 Mongo 열을 가로로 비교하지 않는다 — PG는 amd64 에뮬레이션에서 실행됐고 공간 연산 의미도 다르다(§8).

## 6. 실행계획 관찰 (plans/)

- **PG-U 종류 필터**: `facilities_geom`과 `facilities_pkey`의 BitmapAnd. narrow bus에서 geom 인덱스 684건 + PK 인덱스 **11,236건**(버스 전체)을 스캔한다. 분리 모델은 `bus_stops_geom` 단독으로 518건만 스캔 (EXPLAIN 11.3ms vs 5.0ms).
- **PG wide both**: 통합은 Seq Scan 1회(130.9ms). 분리는 Gather + Append 병렬 계획(309.4ms). EXPLAIN 수치는 계측 오버헤드를 포함하며 본측정 p50(258 vs 252ms)에서는 차이가 거의 없었다 — 계획 모양의 차이가 곧 지연 차이는 아니다.
- **MG-U 종류 필터**: winning plan이 `facility_type_1_source_id_1` 인덱스를 선택, narrow bus에서 docsExamined **11,236** / nReturned 518. 분리 컬렉션은 2dsphere로 docsExamined 921. 통합에서 종류 필터가 있으면 2dsphere가 필터와 결합되지 못해 오히려 both(docsExamined 1,176)보다 느리다.
- 낮은 선택도(wide)에서는 어차피 대부분을 읽으므로 통합·분리 차이가 줄어든다.

## 7. 저장 공간 (sizes.json)

| | 데이터 | 인덱스 | 합계 |
|---|---:|---:|---:|
| PG 통합 facilities | 5.04MB | 2.06MB | 7.14MB |
| PG 분리 bus+bike | 4.98MB | 2.03MB | 7.09MB |
| Mongo 통합 facilities | 1.85MB(storage) | 0.79MB | 2.64MB |
| Mongo 분리 bus+bike | 1.88MB(storage) | 0.60MB | 2.48MB |

통합·분리의 저장 비용 차이는 이 규모에서 무의미하다. Mongo 통합의 `(facility_type, source_id)` 고유 인덱스(413KB)가 분리의 `source_id` 인덱스 합(192KB)보다 크다.

## 8. 엔진 간 비교를 하지 않는 이유

- PostgreSQL 컨테이너는 linux/amd64 에뮬레이션, MongoDB는 aarch64 네이티브다. 실행 환경이 불공정하다.
- bbox 의미가 다르다(평면 vs 구면). §4의 건수 차이가 그 증거다.
- 따라서 §5의 PG 대 Mongo 절대값 차이는 이 실험의 결론이 아니다. 결론은 각 엔진 내부의 통합 vs 분리 비교로 한정한다.

## 9. 해석과 선택 지침

| 주 조회 패턴 | 유리한 모델 | 근거 |
|---|---|---|
| 종류별 레이어 조회(지도 토글) | 분리 | 두 엔진 모두 기본 인덱스에서 종류 필터 비용이 없음. 소수 종류(따릉이)에서 PG −25%, Mongo 최대 −64% |
| 전체 시설 한 번에 조회 | 통합(소폭) | UNION ALL / $unionWith 오버헤드 회피. 이번 규모에서 차이는 작음 |
| 단건 상세 | 무차별 | 0.8~1.0ms |
| 새 시설 종류 추가·종류별 검수/재적재 | 분리 | 성능이 아니라 운영 근거(제약·작업 경계) — 설계 문서 §8 |

현재 프런트엔드가 종류별 표시 켜기/끄기(레이어 단위 bbox 조회)를 주 패턴으로 하므로, **기본 인덱스 전제에서는 분리 모델이 안전한 기본값**이다. 단, 통합 모델의 약점은 구조가 아니라 인덱스 구성에서 온 것일 수 있다. PG partial GiST(`WHERE facility_type=…`), Mongo `(facility_type, location: 2dsphere)` 복합 인덱스를 추가한 2차 측정에서 통합이 분리와 대등해지면, "통합 + 보강 인덱스"도 유효한 선택지다(전체 조회·공통 참조가 쉬워지는 장점 유지).

## 10. 한계

- 14,025건의 작은 실데이터, warm-cache, 단일 클라이언트. 동시성·쓰기 혼합·10만/100만 합성 데이터 확대는 미수행.
- PG 측정은 에뮬레이션 환경의 상대 비교다. 절대값을 다른 환경으로 일반화하지 않는다.
- prepared statement(측정)와 리터럴 SQL(EXPLAIN)의 계획이 다를 수 있다.
- MongoDB bbox를 aggregate로 통일했다. find 단독 경로와의 차이는 측정하지 않았다.
- p95도 600회 표본의 추정치다. 원자료는 raw.csv에 있다.

## 11. 다음 단계

1. 인덱스 단계 2: PG partial GiST / Mongo 복합 2dsphere 추가 후 동일 조건 재측정 (통합 모델 약점 검증).
2. 합성 데이터 10만 건 확대 및 동일 파이프라인 재실행.
3. Spring Boot bbox API + 프런트 연결(프로젝트 1 실험 2)로 클라이언트 관점 지연과 API 지연 구분.
