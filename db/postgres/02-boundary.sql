-- 행정동 경계 Polygon. unified/separated는 시설 2종의 통합·분리 비교 실험용이므로
-- 성격이 다른 경계 데이터는 별도 스키마에 둔다.
CREATE SCHEMA IF NOT EXISTS boundary;

CREATE TABLE IF NOT EXISTS boundary.admin_dongs (
    adm_cd text PRIMARY KEY CHECK (adm_cd ~ '^[0-9]{8}$'),
    adm_cd2 text NOT NULL UNIQUE CHECK (adm_cd2 ~ '^[0-9]{10}$'),
    adm_nm text NOT NULL CHECK (length(btrim(adm_nm)) > 0),
    sido_nm text NOT NULL CHECK (length(btrim(sido_nm)) > 0),
    sgg_cd text NOT NULL CHECK (sgg_cd ~ '^[0-9]{5}$'),
    sgg_nm text NOT NULL CHECK (length(btrim(sgg_nm)) > 0),
    dong_nm text NOT NULL CHECK (length(btrim(dong_nm)) > 0),
    geom geometry(MultiPolygon,4326) NOT NULL,
    CHECK (NOT ST_IsEmpty(geom)
        AND ST_XMin(geom) >= -180 AND ST_XMax(geom) <= 180
        AND ST_YMin(geom) >= -90 AND ST_YMax(geom) <= 90),
    -- 적재한 427건이 모두 ST_IsValid를 통과함을 확인한 뒤 제약으로 승격했다.
    -- 자기교차 Polygon은 ST_Contains 결과를 예측 불가능하게 만들므로 입력 단계에서 막는다.
    CHECK (ST_IsValid(geom))
);

CREATE INDEX IF NOT EXISTS admin_dongs_geom ON boundary.admin_dongs USING gist(geom);
CREATE INDEX IF NOT EXISTS admin_dongs_sgg_nm ON boundary.admin_dongs (sgg_nm);
