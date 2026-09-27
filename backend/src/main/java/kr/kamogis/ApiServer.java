package kr.kamogis;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.util.RawValue;
import java.util.*;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

/** 분리 테이블(separated.*)을 bbox로 조회해 GeoJSON FeatureCollection을 돌려준다. 좌표는 [경도, 위도] EPSG:4326. */
@SpringBootApplication(excludeName = "org.springframework.boot.autoconfigure.mongo.MongoAutoConfiguration")
@RestController
@RequestMapping("/api/layers")
public class ApiServer {
    private static final ObjectMapper JSON = new ObjectMapper();

    /**
     * facetKeys는 SQL에 식별자로 직접 이어붙이므로 요청에서 오는 값이 아니라 여기 적힌 상수만 사용한다.
     * 요청 파라미터는 이 목록에 있는 이름만 통과시키고, 값은 전부 바인딩 파라미터로 넘긴다.
     */
    record Layer(String slug, String table, int facilityType, List<String> facetKeys) {}

    private static final Layer BUS = new Layer("bus-stops", "separated.bus_stops", 0, List.of("stop_type"));
    private static final Layer BIKE = new Layer("bike-stations", "separated.bike_stations", 1,
        List.of("operation_mode", "district"));
    private static final List<Layer> LAYERS = List.of(BUS, BIKE);

    private final JdbcTemplate jdbc;

    public ApiServer(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    public static void main(String[] args) { SpringApplication.run(ApiServer.class, args); }

    @GetMapping("/bus-stops")
    public Map<String, Object> busStops(@RequestParam MultiValueMap<String, String> params) {
        return layer(BUS, params);
    }

    @GetMapping("/bike-stations")
    public Map<String, Object> bikeStations(@RequestParam MultiValueMap<String, String> params) {
        return layer(BIKE, params);
    }

    /** 레이어별 필터 가능한 속성과 값 목록. 개수는 bbox와 무관한 테이블 전체 기준이다. */
    @GetMapping("/bus-stops/facets")
    public Map<String, Object> busFacets() { return facets(BUS); }

    @GetMapping("/bike-stations/facets")
    public Map<String, Object> bikeFacets() { return facets(BIKE); }

    private Map<String, Object> layer(Layer def, MultiValueMap<String, String> params) {
        double[] b = parseBbox(params.getFirst("bbox"));
        // 별칭 f는 생략할 수 없다. boundary.admin_dongs에도 geom 컬럼이 있어서, adm_cd 서브쿼리 안에서
        // 한정하지 않은 geom은 바깥 시설이 아니라 안쪽 경계 테이블에 묶인다.
        StringBuilder sql = new StringBuilder(
            "SELECT f.source_id,f.name,ST_X(f.geom) AS lon,ST_Y(f.geom) AS lat,f.attributes::text AS attrs FROM ")
            .append(def.table())
            .append(" f WHERE ST_Intersects(f.geom,ST_MakeEnvelope(?,?,?,?,4326))");
        List<Object> args = new ArrayList<>(List.of(b[0], b[1], b[2], b[3]));
        String admCd = params.getFirst("adm_cd");
        if (admCd != null && !admCd.isBlank()) {
            sql.append(" AND EXISTS (SELECT 1 FROM boundary.admin_dongs d"
                + " WHERE d.adm_cd=? AND ST_Contains(d.geom,f.geom))");
            args.add(admCd);
        }
        for (String key : def.facetKeys()) {
            List<String> values = params.get(key);
            if (values == null || values.isEmpty()) continue;
            sql.append(" AND f.attributes->>'").append(key).append("' IN (")
                .append("?,".repeat(values.size() - 1)).append("?)");
            args.addAll(values);
        }
        List<Map<String, Object>> features = jdbc.query(sql.toString(),
            (rs, i) -> {
                Map<String, Object> properties = new LinkedHashMap<>();
                properties.put("facility_type", def.facilityType());
                properties.put("source_id", rs.getString("source_id"));
                properties.put("name", rs.getString("name"));
                properties.put("attributes", readJson(rs.getString("attrs")));
                return Map.of(
                    "type", "Feature",
                    "geometry", Map.of("type", "Point", "coordinates",
                        List.of(rs.getDouble("lon"), rs.getDouble("lat"))),
                    "properties", properties);
            },
            args.toArray());
        return Map.of("type", "FeatureCollection", "features", features);
    }

    /**
     * 행정동 경계. 시설 레이어와 달리 geometry가 MultiPolygon이라 좌표를 Java 객체로 풀지 않고
     * ST_AsGeoJSON 결과 문자열을 RawValue로 그대로 흘려보낸다. 427건 전체가 436 kB라
     * 파싱 후 재직렬화하면 그만큼을 왕복으로 버리게 된다.
     *
     * 소수점 6자리는 이 위도에서 약 0.11 m다. 경계 자체가 동당 평균 44개 정점으로 단순화되어
     * 있어 그보다 정밀하게 보내도 의미가 없다.
     */
    @GetMapping("/admin-dongs")
    public Map<String, Object> adminDongs(@RequestParam(name = "bbox", required = false) String bbox) {
        double[] b = parseBbox(bbox);
        List<Map<String, Object>> features = jdbc.query(
            "SELECT adm_cd,adm_cd2,adm_nm,sgg_nm,dong_nm,ST_AsGeoJSON(geom,6) AS geojson"
                + " FROM boundary.admin_dongs"
                + " WHERE ST_Intersects(geom,ST_MakeEnvelope(?,?,?,?,4326))",
            (rs, i) -> {
                Map<String, Object> properties = new LinkedHashMap<>();
                properties.put("adm_cd", rs.getString("adm_cd"));
                properties.put("adm_cd2", rs.getString("adm_cd2"));
                properties.put("adm_nm", rs.getString("adm_nm"));
                properties.put("sgg_nm", rs.getString("sgg_nm"));
                properties.put("dong_nm", rs.getString("dong_nm"));
                return Map.of(
                    "type", "Feature",
                    "geometry", new RawValue(rs.getString("geojson")),
                    "properties", properties);
            },
            b[0], b[1], b[2], b[3]);
        return Map.of("type", "FeatureCollection", "features", features);
    }

    /**
     * 도시철도 역. 시설 레이어와 스키마가 달라(노선별로만 역번호가 유일) 별도로 둔다.
     * 노선명을 속성으로 내려 프런트에서 호선 색을 칠할 수 있게 한다.
     */
    @GetMapping("/subway-stations")
    public Map<String, Object> subwayStations(@RequestParam(name = "bbox", required = false) String bbox) {
        double[] b = parseBbox(bbox);
        List<Map<String, Object>> features = jdbc.query(
            "SELECT line_code,station_code,line_name,name,ST_X(geom) AS lon,ST_Y(geom) AS lat"
                + " FROM transit.subway_stations"
                + " WHERE ST_Intersects(geom,ST_MakeEnvelope(?,?,?,?,4326))",
            (rs, i) -> {
                Map<String, Object> properties = new LinkedHashMap<>();
                properties.put("line_code", rs.getString("line_code"));
                properties.put("station_code", rs.getString("station_code"));
                properties.put("line_name", rs.getString("line_name"));
                properties.put("name", rs.getString("name"));
                return Map.of(
                    "type", "Feature",
                    "geometry", Map.of("type", "Point", "coordinates",
                        List.of(rs.getDouble("lon"), rs.getDouble("lat"))),
                    "properties", properties);
            },
            b[0], b[1], b[2], b[3]);
        return Map.of("type", "FeatureCollection", "features", features);
    }

    /**
     * 노선 형상. 역을 순서대로 이은 모식도라 실제 선로가 아니다.
     * order_verified=false는 역번호 순서가 실제 운행 순서와 어긋나는 것을 확인한 노선이라
     * 기본값으로는 빼고 내려보낸다. verified=false를 붙이면 전부 받는다.
     */
    @GetMapping("/subway-lines")
    public Map<String, Object> subwayLines(
        @RequestParam(name = "bbox", required = false) String bbox,
        @RequestParam(name = "verified", defaultValue = "true") boolean verifiedOnly) {
        double[] b = parseBbox(bbox);
        List<Map<String, Object>> features = jdbc.query(
            "SELECT line_code,line_name,branch,station_count,max_gap_m,order_verified,"
                + "ST_AsGeoJSON(geom,6) AS geojson FROM transit.subway_lines"
                + " WHERE ST_Intersects(geom,ST_MakeEnvelope(?,?,?,?,4326))"
                + " AND (order_verified OR NOT ?)",
            (rs, i) -> {
                Map<String, Object> properties = new LinkedHashMap<>();
                properties.put("line_code", rs.getString("line_code"));
                properties.put("line_name", rs.getString("line_name"));
                properties.put("branch", rs.getString("branch"));
                properties.put("station_count", rs.getInt("station_count"));
                properties.put("max_gap_m", Math.round(rs.getDouble("max_gap_m")));
                properties.put("order_verified", rs.getBoolean("order_verified"));
                return Map.of(
                    "type", "Feature",
                    "geometry", new RawValue(rs.getString("geojson")),
                    "properties", properties);
            },
            b[0], b[1], b[2], b[3], verifiedOnly);
        return Map.of("type", "FeatureCollection", "features", features);
    }

    /**
     * 행정동 하나의 시설 구성. 지도에 그려진 것이 아니라 동 전체를 센다.
     * bbox와 속성 필터에 영향받지 않으므로 필터를 켜도 그 동의 실제 구성이 그대로 보인다.
     */
    @GetMapping("/admin-dongs/{admCd}/summary")
    public Map<String, Object> dongSummary(@PathVariable("admCd") String admCd) {
        List<Map<String, Object>> dong = jdbc.query(
            "SELECT adm_cd,adm_cd2,adm_nm,sgg_nm,dong_nm,"
                + "round((ST_Area(geom::geography)/1e6)::numeric,2) AS area_km2"
                + " FROM boundary.admin_dongs WHERE adm_cd=?",
            (rs, i) -> {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("adm_cd", rs.getString("adm_cd"));
                row.put("adm_cd2", rs.getString("adm_cd2"));
                row.put("adm_nm", rs.getString("adm_nm"));
                row.put("sgg_nm", rs.getString("sgg_nm"));
                row.put("dong_nm", rs.getString("dong_nm"));
                row.put("area_km2", rs.getBigDecimal("area_km2"));
                return row;
            },
            admCd);
        if (dong.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "없는 행정동 코드입니다: " + admCd);

        Map<String, Object> layers = new LinkedHashMap<>();
        for (Layer def : LAYERS) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("total", jdbc.queryForObject(
                "SELECT count(*) FROM " + def.table() + " f"
                    + " JOIN boundary.admin_dongs d ON d.adm_cd=? AND ST_Contains(d.geom,f.geom)",
                Long.class, admCd));
            Map<String, Object> breakdown = new LinkedHashMap<>();
            for (String key : def.facetKeys()) {
                breakdown.put(key, jdbc.query(
                    "SELECT f.attributes->>'" + key + "' AS value, count(*) AS count FROM " + def.table() + " f"
                        + " JOIN boundary.admin_dongs d ON d.adm_cd=? AND ST_Contains(d.geom,f.geom)"
                        + " WHERE f.attributes->>'" + key + "' IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1",
                    (rs, i) -> Map.of("value", rs.getString("value"), "count", rs.getLong("count")),
                    admCd));
            }
            entry.put("facets", breakdown);
            layers.put(def.slug(), entry);
        }
        return Map.of("dong", dong.get(0), "layers", layers, "subway", subwayInDong(admCd));
    }

    /**
     * 동 안의 도시철도 역. 시설 레이어와 구조를 공유하지 않는 이유는 두 가지다.
     * 노선명이 attributes JSON이 아니라 컬럼이고, 환승역이 노선 수만큼 행으로 들어 있어
     * 행을 그대로 세면 "역 개수"가 되지 않는다(시청역은 1·2호선 2행).
     * 그래서 역 이름으로 묶고 노선을 모은다. total은 묶은 뒤의 역 수다.
     */
    private Map<String, Object> subwayInDong(String admCd) {
        // 원본은 같은 역을 노선에 따라 다르게 적는다. 분당선은 '강남구청역'인데 7호선은
        // '강남구청'이다. 이름 그대로 묶으면 한 역이 둘로 보인다.
        // 그래서 끝의 '역'을 뗀 것을 묶음 키로 쓰되, 뗀 이름을 가진 역이 300 m 안에
        // 실제로 있을 때만 뗀다. 거리 조건이 없으면 안 된다 — 전국에는 339 km 떨어진
        // '송정'과 '송정역'이 따로 있고 이런 쌍이 62개 중 13개다. 이름만 맞다고 합치면
        // 다른 역이 합쳐진다.
        //
        // 화면에 쓰는 이름은 묶인 표기 중 긴 쪽이다. load-subway.sql이 (노선,역번호)
        // 중복에서 긴 표기를 남긴 것과 같은 규칙이다. 짧은 쪽을 고르면 '서울역'이
        // '서울'로 나온다. 묶는 것도 이름을 고르는 것도 표시할 때만이고,
        // transit.subway_stations의 원본 역명은 그대로 둔다.
        //
        // 정렬은 COLLATE "C"를 쓴다. DB 콜레이션이 en_US.utf8인데 glibc의 이 로케일은
        // 한글에 쓸 만한 가중치가 없어 사실상 글자 수 순으로 나온다(가방 < 나비 < 하나 < 가나다).
        // 유니코드 한글 음절 블록(U+AC00~U+D7A3)이 가나다 순으로 배열돼 있어
        // 코드포인트 순서가 곧 사전 순서다. 한글로만 된 역명·노선명에는 이것으로 충분하다.
        List<Map<String, Object>> stations = jdbc.query(
            "WITH in_dong AS ("
                + " SELECT s.name, s.line_name, s.geom FROM transit.subway_stations s"
                + " JOIN boundary.admin_dongs d ON d.adm_cd=? AND ST_Contains(d.geom,s.geom))"
                // 짝은 전체 테이블에서 찾는다. 동 안에서만 찾으면 짝이 경계 밖에 있을 때
                // 놓친다(삼성2동의 '선정릉역'은 짝인 '선정릉'이 55 m 옆 다른 동에 있다).
                + ", canon AS ("
                + " SELECT coalesce((SELECT b.name FROM transit.subway_stations b"
                + "   WHERE i.name LIKE '%역' AND b.name = left(i.name, length(i.name)-1)"
                + "     AND ST_DWithin(i.geom::geography, b.geom::geography, 300)"
                + "   LIMIT 1), i.name) AS key, i.name AS orig, i.line_name"
                + " FROM in_dong i)"
                // DISTINCT가 붙은 집계에서는 ORDER BY 식이 인자와 같아야 해서 양쪽에 COLLATE를 준다.
                + " SELECT (array_agg(orig ORDER BY length(orig) DESC, orig COLLATE \"C\"))[1] AS name,"
                + "        array_agg(DISTINCT line_name COLLATE \"C\""
                + "        ORDER BY line_name COLLATE \"C\") AS lines"
                + " FROM canon GROUP BY key ORDER BY key COLLATE \"C\"",
            (rs, i) -> {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("name", rs.getString("name"));
                row.put("lines", List.of((String[]) rs.getArray("lines").getArray()));
                return row;
            },
            admCd);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("total", stations.size());
        out.put("stations", stations);
        return out;
    }

    private Map<String, Object> facets(Layer def) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (String key : def.facetKeys()) {
            out.put(key, jdbc.query(
                "SELECT attributes->>'" + key + "' AS value, count(*) AS count FROM " + def.table()
                    + " WHERE attributes->>'" + key + "' IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1",
                (rs, i) -> Map.of("value", rs.getString("value"), "count", rs.getLong("count"))));
        }
        return out;
    }

    private static Map<?, ?> readJson(String text) {
        try {
            return JSON.readValue(text, Map.class);
        } catch (Exception ex) {
            throw new IllegalStateException("Stored attributes are not a JSON object", ex);
        }
    }

    static double[] parseBbox(String bbox) {
        String[] parts = bbox == null ? new String[0] : bbox.split(",", -1);
        if (parts.length != 4) throw badRequest("bbox는 minLon,minLat,maxLon,maxLat 4개 값이어야 합니다.");
        double[] b = new double[4];
        for (int i = 0; i < 4; i++) {
            try {
                b[i] = Double.parseDouble(parts[i].trim());
            } catch (NumberFormatException ex) {
                throw badRequest("bbox 값이 숫자가 아닙니다: " + parts[i]);
            }
            if (!Double.isFinite(b[i])) throw badRequest("bbox 값이 유한한 숫자가 아닙니다: " + parts[i]);
        }
        if (b[0] < -180 || b[2] > 180 || b[1] < -90 || b[3] > 90)
            throw badRequest("bbox가 경도 [-180,180], 위도 [-90,90] 범위를 벗어났습니다.");
        if (b[0] >= b[2] || b[1] >= b[3]) throw badRequest("bbox는 minLon<maxLon, minLat<maxLat 이어야 합니다.");
        return b;
    }

    private static ResponseStatusException badRequest(String message) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
    }
}
