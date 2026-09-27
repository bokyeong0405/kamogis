-- 도시철도 역·노선 적재. load-admin-dongs.sql과 같은 이유로 초기화 스크립트가 아니다.
--
--   python3 db/postgres/subway-xlsx-to-csv.py \
--       data/raw/전체_도시철도역사정보_20260630.xlsx /tmp/subway-stations.csv
--   docker compose cp /tmp/subway-stations.csv postgres:/tmp/subway-stations.csv
--   docker compose exec -T postgres psql -U kamogis -d kamogis -v ON_ERROR_STOP=1 \
--       < db/postgres/load-subway.sql
--
-- 서버 측 COPY라 superuser 권한이 필요하다(pg_read_file과 같은 조건).
-- 전국 1,099행을 전부 넣는다. 서울만 자르지 않는 이유는 노선이 시계를 넘나들어서,
-- 자르면 경계에서 선이 끊기기 때문이다. 화면에 뭐가 보일지는 bbox 조회가 정한다.

BEGIN;

CREATE TEMP TABLE raw_station (
    station_code text, station_name text, line_code text, line_name text,
    name_en text, name_hanja text, transfer_kind text, transfer_line_code text,
    transfer_line_name text, lat text, lon text, operator text,
    road_address text, phone text, data_date text
);
COPY raw_station FROM '/tmp/subway-stations.csv' WITH (FORMAT csv);

-- 원본에 (노선번호, 역번호)가 겹치는 행이 5건 있다. 셋은 노선명만 다른 같은 역이고,
-- 둘은 역명 표기가 다르다(S1107/0736 '이수' vs '총신대입구(이수)', I1101/1809 '주안역' 중복).
-- 긴 표기를 남긴다 — 7호선 공식 역명이 '총신대입구(이수)'이고, 짧은 쪽이 축약형이다.
INSERT INTO transit.subway_stations
    (line_code, station_code, line_name, name, sort_key, branch, geom, attributes)
SELECT DISTINCT ON (r.line_code, r.station_code)
    r.line_code, r.station_code, r.line_name, r.station_name,
    -- 역번호가 3자리와 4자리로 섞여 들어온다(8호선 별내 연장 806 vs 본선 0809).
    -- 문자열 정렬로는 806이 0809보다 뒤로 가서 노선이 19.6 km를 건너뛴다.
    CASE WHEN r.station_code ~ '^[0-9]+$' THEN lpad(r.station_code, 4, '0') ELSE r.station_code END,
    substring(r.station_code FROM '^[^0-9]*'),
    ST_SetSRID(ST_MakePoint(lon::double precision, lat::double precision), 4326),
    jsonb_build_object(
        'name_en', name_en, 'name_hanja', name_hanja,
        'transfer_kind', transfer_kind, 'transfer_line_name', transfer_line_name,
        'operator', operator, 'road_address', road_address)
FROM raw_station r
ORDER BY r.line_code, r.station_code, length(r.station_name) DESC
ON CONFLICT (line_code, station_code) DO UPDATE SET
    line_name = EXCLUDED.line_name, name = EXCLUDED.name,
    sort_key = EXCLUDED.sort_key, branch = EXCLUDED.branch,
    geom = EXCLUDED.geom, attributes = EXCLUDED.attributes;

-- 노선 형상. 역을 sort_key 순으로 이은 모식도이므로 실제 선로가 아니다.
-- order_verified=false인 노선은 역번호 순서가 실제 운행 순서와 다른 것을 확인한 것들이다.
-- 전부 코레일 광역철도이고 원인은 하나다: 역번호가 운행 순서가 아니라 '묶음' 단위로
-- 매겨져 있고, 묶음이 노선의 어디에 들어가는지 알려 주는 컬럼이 원본에 없다.
-- 겉모습은 셋으로 나타난다.
--   (1) 묶음의 역들을 앞 묶음 사이사이에 끼워 넣어야 함 — 경부선 1002~1007, 1701~1713,
--       1715~1728은 각각 순서가 정확한데 1032 신길, 1714 독산, 1729 당정, 1749 서동탄,
--       1750 광명이 뒤에 몰려 있다. 경인선·분당선도 같다.
--   (2) 묶음이 통째로 한 자리에 들어가야 함 — 수인선 1755~1762가 1877과 1878 사이로.
--       경의중앙선은 중앙선(1201~1220)과 경의선(1251~1286) 계열이 한 노선명에 합쳐져
--       1220 지평 -> 1251 서울역에서 58.87 km를 건너뛴다.
--   (3) 묶음이 역 하나 — 경강선 1512 성남(최근접역이 1502 이매 669 m), 동해선 8015
--       부산원동(8007 재송 868 m), 안산과천선 1763 수리산. 번호에 빈칸조차 없어
--       블록 구조 검사로는 안 걸리고 최근접역 검사로 찾았다.
-- 묶음이 개통 시기라는 가설은 개통일 컬럼이 없어 확인할 수 없다.
--
-- 주의: 경의중앙선의 max_gap_m 190,789 m는 순서가 아니라 1204 양원역 좌표 오류 탓이다
-- (주소는 서울 중랑구인데 좌표가 경북). max_gap_m이 튀었다고 원인이 순서라고 단정하지 말 것.
-- 자세한 근거는 docs/research/2026-09-26-subway-lines.md.
WITH built AS (
    SELECT line_code, line_name, branch,
           count(*) AS station_count,
           ST_MakeLine(geom ORDER BY sort_key) AS geom
    FROM transit.subway_stations
    GROUP BY line_code, line_name, branch
    HAVING count(*) >= 2
), closed AS (
    -- 2호선 본선은 순환선인데 역번호가 시청(0201)에서 충정로(0243)까지 한 방향으로만
    -- 매겨져 있어 ST_MakeLine이 열린 선으로 끝난다. 그대로 두면 도심에서 충정로–시청
    -- 한 구간이 비어 보인다. 두 역이 실제 인접역이므로 첫 점을 끝에 덧붙여 고리를 닫는다.
    -- 순환 구조는 역 목록만으로는 알 수 없어 노선을 지정하는 예외로 둔다.
    SELECT line_code, line_name, branch, station_count,
           CASE WHEN (line_code, line_name, branch) = ('S1102', '2호선', '')
                THEN ST_AddPoint(geom, ST_StartPoint(geom)) ELSE geom END AS geom
    FROM built
)
INSERT INTO transit.subway_lines
    (line_code, line_name, branch, station_count, max_gap_m, order_verified, geom)
SELECT c.line_code, c.line_name, c.branch, c.station_count,
       -- 최종 형상에서 재계산한다. 고리를 닫은 2호선은 마지막 구간이 새로 생기기 때문.
       (SELECT coalesce(max(ST_Distance(a.geom::geography, b.geom::geography)), 0)
        FROM ST_DumpPoints(c.geom) a
        JOIN ST_DumpPoints(c.geom) b ON b.path[1] = a.path[1] + 1),
       -- 간격이 큰 노선을 하나씩 훑어 실제로 역 사이가 먼 것과 순서가 어긋난 것을 갈랐다.
       -- 수도권 밖도 같은 기준으로 봤다. 대경선 왜관–서대구 17.6 km처럼 큰 간격이
       -- 실제인 경우가 있어 거리 임계값으로는 가를 수 없다.
       (c.line_code, c.line_name) NOT IN (
           ('I1101', '경인선'), ('I4101', '경부선'), ('I4103', '안산과천선'),
           ('I4105', '분당선'), ('I4108', '경의중앙선'),
           -- 수인선 오이도 다음이 고색(24.8 km)으로 이어진다(겉모습 2).
           -- 경강선·동해선은 겉모습 3으로, 번호는 연속인데 한 역이 엉뚱한 자리에 있다.
           ('I41K5', '경강선'), ('I28K1', '수인선'), ('I26K6', '동해선')),
       c.geom
FROM closed c
ON CONFLICT (line_code, line_name, branch) DO UPDATE SET
    station_count = EXCLUDED.station_count, max_gap_m = EXCLUDED.max_gap_m,
    order_verified = EXCLUDED.order_verified, geom = EXCLUDED.geom;

COMMIT;

ANALYZE transit.subway_stations;
ANALYZE transit.subway_lines;
