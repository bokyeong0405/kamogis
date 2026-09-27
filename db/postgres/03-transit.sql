-- 도시철도 역(Point)과 노선(LineString). boundary와 같은 이유로 별도 스키마에 둔다:
-- unified/separated는 시설 2종의 통합·분리 비교 실험용이고, 여기에 테이블을 더하면
-- 이미 기록해 둔 벤치마크의 전제가 흐려진다.
CREATE SCHEMA IF NOT EXISTS transit;

-- 역번호는 전역 고유가 아니다(원본 1,099행에서 146건 중복). 노선 안에서만 유일하므로
-- (line_code, station_code)를 기본키로 쓴다.
CREATE TABLE IF NOT EXISTS transit.subway_stations (
    line_code text NOT NULL CHECK (line_code ~ '^[A-Z0-9]{5}$'),
    station_code text NOT NULL CHECK (length(btrim(station_code)) > 0),
    line_name text NOT NULL CHECK (length(btrim(line_name)) > 0),
    name text NOT NULL CHECK (length(btrim(name)) > 0),
    -- 같은 노선 안에서 역 순서를 정하는 키. 원본 역번호는 3자리와 4자리가 섞여 있어
    -- (예: 8호선 별내 연장 구간이 806, 본선이 0809) 문자열 정렬하면 순서가 뒤집힌다.
    -- 숫자로만 된 역번호는 4자리로 채우고, 접두어가 붙은 것은 그대로 둔다.
    sort_key text NOT NULL,
    -- 지선 식별자. 역번호의 선행 알파벳으로, 5호선만 본선('')과 마천지선('P')으로 갈린다.
    branch text NOT NULL,
    geom geometry(Point,4326) NOT NULL,
    attributes jsonb NOT NULL CHECK (jsonb_typeof(attributes) = 'object'),
    PRIMARY KEY (line_code, station_code),
    CHECK (NOT ST_IsEmpty(geom) AND ST_X(geom) BETWEEN -180 AND 180 AND ST_Y(geom) BETWEEN -90 AND 90)
);

-- 실제 선로 형상이 아니라 역을 순서대로 이은 모식도다. 곡선·터널·역간 우회가 모두 직선으로
-- 뭉개지므로 length_m를 실제 노선 연장으로 읽으면 안 된다.
CREATE TABLE IF NOT EXISTS transit.subway_lines (
    line_code text NOT NULL CHECK (line_code ~ '^[A-Z0-9]{5}$'),
    branch text NOT NULL,
    line_name text NOT NULL CHECK (length(btrim(line_name)) > 0),
    station_count integer NOT NULL CHECK (station_count >= 2),
    -- 인접 역 사이 최대 직선거리. 역번호 순서가 실제 운행 순서와 어긋나면 여기서 튄다.
    -- 적재 후 검수 지표로 남긴다.
    max_gap_m double precision NOT NULL CHECK (max_gap_m >= 0),
    -- 역번호 순서가 실제 운행 순서와 일치함을 확인했는지. false인 노선도 geom은 만들지만
    -- 그 형상은 신뢰할 수 없다.
    order_verified boolean NOT NULL,
    geom geometry(LineString,4326) NOT NULL,
    -- line_code 하나에 노선명이 둘 붙는 경우가 있다(I4101=1호선·경부선, S1109=서울·수도권 9호선).
    -- 원본이 끊어 등록한 단위를 그대로 보존한다. 합치는 규칙을 만들면 어디까지 합칠지가
    -- 판단이 되어 재현이 안 된다. 대신 9호선·7호선은 두 구간의 이음매 한 칸이 비어 보인다.
    PRIMARY KEY (line_code, line_name, branch),
    CHECK (NOT ST_IsEmpty(geom) AND ST_NPoints(geom) >= 2)
);

CREATE INDEX IF NOT EXISTS subway_stations_geom ON transit.subway_stations USING gist(geom);
CREATE INDEX IF NOT EXISTS subway_lines_geom ON transit.subway_lines USING gist(geom);
