# 네 가지 저장 모델 검증 결과

검증일: 2026-09-25. 성능 벤치마크가 아니라 적재·재적재·내용 일치 검증이다.

## 결과

| 저장소 | 버스 | 따릉이 | 합계 |
|---|---:|---:|---:|
| PostgreSQL unified.facilities | 11,236 | 2,789 | 14,025 |
| PostgreSQL separated.bus_stops + bike_stations | 11,236 | 2,789 | 14,025 |
| MongoDB facilities | 11,236 | 2,789 | 14,025 |
| MongoDB bus_stops + bike_stations | 11,236 | 2,789 | 14,025 |

동일한 import 명령을 두 번 실행했다. 두 번 모두 네 모델 전체가 파싱한 원본의 ID·이름·좌표·종류별 속성과 일치했다. 재적재로 행/문서가 늘거나 값이 달라지지 않았다.

```text
Validated bus=11236 bike=2789
PostgreSQL unified + separated committed.
MongoDB unified + separated acknowledged.
BBox model equality OK; PostgreSQL=684 MongoDB=684
BBox model equality OK; PostgreSQL=13842 MongoDB=13843
PASS: all four models exactly match 14025 source records; bbox equality verified within each DB.
```

| bbox (minLon,minLat,maxLon,maxLat) | PostgreSQL 각 모델 | MongoDB 각 모델 |
|---|---:|---:|
| 126.97,37.55,127.02,37.59 | 684 | 684 |
| 126.8,37.44,127.17,37.68 | 13,842 | 13,843 |

각 DB 내부에서는 통합과 분리의 전체 결과가 일치했다. 넓은 bbox의 DB 간 결과 건수는 다르다. PostgreSQL은 EPSG:4326 geometry의 ST_Intersects, MongoDB는 GeoJSON 구면 폴리곤의 $geoWithin을 사용한다. 정확한 차이 레코드/경계 분석은 후속 실험이다. 이 쿼리를 동일 의미로 간주하여 두 엔진 속도를 비교하지 않는다.

## 단위 검증

JUnit 5개 테스트: 잘못된 종류·ID·좌표 거부, 좌표 순서·ARS-ID 선행 0 보존, 종류 내부 중복 거부/종류 간 동일 ID 허용, 건수가 같아도 내용 변경 탐지, CRS 옵션과 생략 가능한 디렉터리 처리.

독립 코드 검토에서 발견한 CLI 옵션 파싱 문제를 수정했다. `import --crs=4326`에서 플래그를 디렉터리로 해석하지 않는다. 기본 원본 경로는 저장소 루트 기준 data/raw다.

## 환경 및 한계

- Docker Desktop, 이미지 postgis/postgis:17-3.5 및 mongo:8.0. 저장 볼륨은 유지한다.
- PostgreSQL 컨테이너는 amd64 에뮬레이션이다. 현재 결과는 속도 비교가 아니다.
- Java 21, Maven 3.9.9. 실행 절차는 backend/README.md 참조.
- 원본 snapshot과 parser 헤더를 고정했다. 향후 파일 형식이 바뀌면 매핑을 검토해야 한다.
- MongoDB 전체 적재 및 두 엔진 간 적재를 하나의 트랜잭션으로 묶지 않는다. 실패 후 재실행으로 복구한다.
- 변칙 입력은 첫 오류에서 중단하며 전체 오류 집계 리포트는 아직 제공하지 않는다.
- 기존 자료에 없어진 시설을 자동 삭제하지 않는다.
- 현재 라이브러리의 logging provider 부재 안내가 출력되지만 검증 실행은 성공했다. 운영 애플리케이션에는 logging backend 설정이 필요하다.
- 대규모 데이터 생성·측정, 부분 인덱스/복합 인덱스 최적화, API/지도 연결은 별도 단계다.
