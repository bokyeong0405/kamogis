-- 행정동 경계 적재. 초기화 스크립트가 아니라 수동 실행용이므로 파일명에 번호를 붙이지 않는다
-- (docker-entrypoint-initdb.d는 빈 볼륨 최초 기동 시 01-, 02- 순서로 실행되는데
--  이 스크립트는 컨테이너 안에 GeoJSON이 먼저 복사되어 있어야 하기 때문).
--
--   docker compose cp data/raw/hangjeongdong-20260701.geojson postgres:/tmp/hjd.geojson
--   docker compose exec -T postgres psql -U kamogis -d kamogis -v ON_ERROR_STOP=1 \
--     < db/postgres/load-admin-dongs.sql
--
-- (/docker-entrypoint-initdb.d는 읽기 전용 마운트라 -f로 지정할 수 없다. 표준입력으로 넣는다.)
--
-- pg_read_file은 superuser 또는 pg_read_server_files 권한이 필요하다. 34 MB GeoJSON을
-- 새 파서 의존성 없이 DB 안에서 처리하려고 선택했다(jsonb 파싱 약 7초).

BEGIN;

CREATE TEMP TABLE raw_doc (doc jsonb);
INSERT INTO raw_doc SELECT pg_read_file('/tmp/hjd.geojson')::jsonb;

-- 전국 3,558건 중 서울 427건만 적재한다. adm_nm은 '시도 자치구 동' 3토큰이 보장된다.
INSERT INTO boundary.admin_dongs (adm_cd, adm_cd2, adm_nm, sido_nm, sgg_cd, sgg_nm, dong_nm, geom)
SELECT p->>'adm_cd', p->>'adm_cd2', p->>'adm_nm', p->>'sidonm', p->>'sgg', p->>'sggnm',
       split_part(p->>'adm_nm', ' ', 3),
       ST_Multi(ST_GeomFromGeoJSON(f->'geometry'))
FROM raw_doc,
     LATERAL jsonb_array_elements(doc->'features') AS f,
     LATERAL (SELECT f->'properties') AS t(p)
WHERE p->>'sidonm' = '서울특별시'
ON CONFLICT (adm_cd) DO UPDATE SET
    adm_cd2 = EXCLUDED.adm_cd2, adm_nm = EXCLUDED.adm_nm, sido_nm = EXCLUDED.sido_nm,
    sgg_cd = EXCLUDED.sgg_cd, sgg_nm = EXCLUDED.sgg_nm, dong_nm = EXCLUDED.dong_nm,
    geom = EXCLUDED.geom;

COMMIT;

ANALYZE boundary.admin_dongs;
