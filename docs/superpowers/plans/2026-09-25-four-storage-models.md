# Four storage models implementation plan

Goal: 동일한 검수 데이터를 PostgreSQL 및 MongoDB의 통합·분리 모델에 적재하고 동등성을 검증한다.
Spec: ../../research/2026-09-25-db-model-benchmark.md
Architecture: Java 21 CLI가 XLSX를 공통 Facility 레코드로 읽고 JDBC/MongoDB driver로 독립 적재한다. Docker Compose는 전용 데이터베이스를 제공한다. API·대규모 부하는 이번 변경에서 제외한다.

## 작업
- [x] Docker Compose, PostgreSQL DDL, MongoDB validator 및 인덱스 작성.
- [x] 원천 ID·좌표 검증의 실패 테스트 후 공통 레코드와 XLSX parser 구현.
- [x] JDBC 및 MongoDB 적재기 구현. 모든 입력 검증 완료 후 쓰기, 고유 키 upsert.
- [x] 실제 DB에서 전체 데이터 및 bbox ID 집합 일치, 재적재 불변성 검증.
- [x] 실행 명령, 원본 보존, 좌표계 판단 및 검증 결과 기록.

## 검증 기준
종류별 중복 ID 거부, 비정상 좌표 거부, 선행 0 보존, 미확인 CRS 적재 거부, 반복 적재에 의한 중복 없음. 실제 데이터베이스 테스트는 별도 전용 테스트 DB를 사용하고 서비스 데이터를 삭제하지 않는다.

## 결정 기록
- 사용자가 네 모델 구현을 명시적으로 요청했으므로 같은 구현 허가를 재요청하지 않고 직접 진행한다.
- 현재 폴더는 Git 저장소가 아니므로 worktree·commit을 만들지 않는다.
- EPSG:4156은 WGS84가 아니다. 사용자에게 확인한 결과 4326 오타였으며 이를 기록하고 적재했다.

검증 결과: docs/research/2026-09-25-storage-verification.md. 독립 검토의 CLI 옵션 파싱 지적을 반영했다.
