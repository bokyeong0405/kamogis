package kr.kamogis;

import com.mongodb.client.*;
import org.bson.Document;
import java.nio.file.*;
import java.sql.*;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.TimeUnit;

/**
 * 4개 저장 모델(PG-U, PG-S, MG-U, MG-S)의 조회 지연을 측정한다.
 * 결론은 같은 엔진 내부의 통합 vs 분리 비교로 한정한다(스펙 §5 공간 의미의 일치).
 */
public final class Benchmark {
    static final String[] BBOX_NAMES = {"narrow", "medium", "wide"};
    static final double[][] BBOXES = {
        {126.97, 37.55, 127.02, 37.59},
        {126.90, 37.48, 127.10, 37.62},
        {126.80, 37.44, 127.17, 37.68}};
    static final String[] FILTERS = {"bus", "bike", "both"};
    static final String PG_FIELDS = "source_id,name,ST_X(geom) AS lon,ST_Y(geom) AS lat,attributes::text AS attrs";
    static long blackhole;

    record Cond(String engine, boolean unified, String scenario, String filter) {
        String id() { return engine + (unified ? "-U" : "-S") + "_" + scenario + (filter == null ? "" : "_" + filter); }
    }

    record Sample(int[] types, String[] ids) {}

    public static void main(String[] args) throws Exception {
        int warmup = intArg(args, "warmup", 10), iters = intArg(args, "iters", 200), rounds = intArg(args, "rounds", 3);
        Path out = Path.of(strArg(args, "out", "docs/research/bench/2026-09-25"));
        Files.createDirectories(out.resolve("plans"));
        try (Connection pg = DriverManager.getConnection(
                 StorageLab.env("PG_URL", "jdbc:postgresql://127.0.0.1:55432/kamogis"),
                 StorageLab.env("PG_USER", "kamogis"), StorageLab.required("PG_PASSWORD"));
             MongoClient client = MongoClients.create(StorageLab.mongoUri())) {
            MongoDatabase mongo = client.getDatabase("kamogis");
            try (var st = pg.createStatement()) {
                st.execute("SET statement_timeout='60s'");
                for (String t : List.of("unified.facilities", "separated.bus_stops", "separated.bike_stations"))
                    st.execute("ANALYZE " + t);
            }
            writeJson(out.resolve("env.json"), environment(pg, mongo, warmup, iters, rounds));
            writeJson(out.resolve("sizes.json"), sizes(pg, mongo));
            Sample sample = sampleKeys(pg, iters);
            writeJson(out.resolve("equality.json"), equality(pg, mongo));
            collectPlans(pg, mongo, out.resolve("plans"), sample);

            List<Cond> conds = new ArrayList<>();
            for (String engine : List.of("pg", "mongo"))
                for (boolean unified : List.of(true, false)) {
                    conds.add(new Cond(engine, unified, "single", null));
                    for (String b : BBOX_NAMES) for (String f : FILTERS) conds.add(new Cond(engine, unified, b, f));
                }
            Map<String, PreparedStatement> ps = prepare(pg, conds);

            for (Cond c : conds) for (int i = 0; i < warmup; i++) runOnce(ps, mongo, c, i, sample);

            StringBuilder csv = new StringBuilder("round,engine,model,scenario,filter,iteration,micros,rows\n");
            Map<String, List<long[]>> byCond = new LinkedHashMap<>();
            for (int r = 1; r <= rounds; r++) {
                List<Cond> order = new ArrayList<>(conds);
                Collections.shuffle(order, new Random(42L + r));
                for (Cond c : order) {
                    for (int i = 0; i < iters; i++) {
                        long micros, rows;
                        try {
                            long t0 = System.nanoTime();
                            rows = runOnce(ps, mongo, c, i, sample);
                            micros = (System.nanoTime() - t0) / 1000;
                        } catch (Exception ex) {
                            micros = -1; rows = -1;
                            System.err.println("ERROR " + c.id() + " iter " + i + ": " + ex.getMessage());
                        }
                        csv.append(r).append(',').append(c.engine()).append(',').append(c.unified() ? "U" : "S")
                           .append(',').append(c.scenario()).append(',').append(c.filter() == null ? "" : c.filter())
                           .append(',').append(i).append(',').append(micros).append(',').append(rows).append('\n');
                        byCond.computeIfAbsent(c.id(), k -> new ArrayList<>()).add(new long[]{r, micros, rows});
                    }
                    System.out.println("round " + r + " done " + c.id());
                }
            }
            Files.writeString(out.resolve("raw.csv"), csv);
            writeJson(out.resolve("summary.json"), summarize(conds, byCond, rounds));
            System.out.println("Benchmark complete. blackhole=" + blackhole + " out=" + out);
        }
    }

    static int intArg(String[] args, String name, int dflt) {
        for (String a : args) if (a.startsWith("--" + name + "=")) return Integer.parseInt(a.substring(name.length() + 3));
        return dflt;
    }

    static String strArg(String[] args, String name, String dflt) {
        for (String a : args) if (a.startsWith("--" + name + "=")) return a.substring(name.length() + 3);
        return dflt;
    }

    static double[] bbox(Cond c) {
        for (int i = 0; i < BBOX_NAMES.length; i++) if (BBOX_NAMES[i].equals(c.scenario())) return BBOXES[i];
        throw new IllegalArgumentException(c.scenario());
    }

    static Sample sampleKeys(Connection pg, int n) throws SQLException {
        List<Map.Entry<Integer, String>> all = new ArrayList<>();
        try (var st = pg.createStatement();
             var rs = st.executeQuery("SELECT facility_type,source_id FROM unified.facilities ORDER BY facility_type,source_id")) {
            while (rs.next()) all.add(Map.entry(rs.getInt(1), rs.getString(2)));
        }
        Collections.shuffle(all, new Random(42));
        int size = Math.min(n, all.size());
        int[] types = new int[size]; String[] ids = new String[size];
        for (int i = 0; i < size; i++) { types[i] = all.get(i).getKey(); ids[i] = all.get(i).getValue(); }
        return new Sample(types, ids);
    }

    // ---- query construction ----

    static String pgEnv(double[] b) {
        return b == null ? "ST_Intersects(geom,ST_MakeEnvelope(?,?,?,?,4326))"
            : "ST_Intersects(geom,ST_MakeEnvelope(" + b[0] + "," + b[1] + "," + b[2] + "," + b[3] + ",4326))";
    }

    static String pgBboxSql(Cond c, double[] literal) {
        String env = pgEnv(literal);
        if (c.unified()) {
            String sql = "SELECT facility_type," + PG_FIELDS + " FROM unified.facilities WHERE " + env;
            if (!c.filter().equals("both")) sql += " AND facility_type=" + (c.filter().equals("bus") ? 0 : 1);
            return sql;
        }
        String bus = "SELECT 0 AS facility_type," + PG_FIELDS + " FROM separated.bus_stops WHERE " + env;
        String bike = "SELECT 1 AS facility_type," + PG_FIELDS + " FROM separated.bike_stations WHERE " + env;
        return switch (c.filter()) { case "bus" -> bus; case "bike" -> bike; default -> bus + " UNION ALL " + bike; };
    }

    static Map<String, PreparedStatement> prepare(Connection pg, List<Cond> conds) throws SQLException {
        Map<String, PreparedStatement> ps = new HashMap<>();
        for (Cond c : conds) {
            if (!c.engine().equals("pg")) continue;
            if (c.scenario().equals("single")) {
                if (c.unified())
                    ps.put(c.id(), pg.prepareStatement(
                        "SELECT facility_type," + PG_FIELDS + " FROM unified.facilities WHERE facility_type=? AND source_id=?"));
                else {
                    ps.put(c.id() + "_bus", pg.prepareStatement(
                        "SELECT 0 AS facility_type," + PG_FIELDS + " FROM separated.bus_stops WHERE source_id=?"));
                    ps.put(c.id() + "_bike", pg.prepareStatement(
                        "SELECT 1 AS facility_type," + PG_FIELDS + " FROM separated.bike_stations WHERE source_id=?"));
                }
            } else ps.put(c.id(), pg.prepareStatement(pgBboxSql(c, null)));
        }
        return ps;
    }

    static Document geoFilter(double[] b) {
        var ring = List.of(List.of(b[0], b[1]), List.of(b[2], b[1]), List.of(b[2], b[3]), List.of(b[0], b[3]), List.of(b[0], b[1]));
        return new Document("location", new Document("$geoWithin", new Document("$geometry",
            new Document("type", "Polygon").append("coordinates", List.of(ring)))));
    }

    static List<Document> mongoPipeline(Cond c) {
        Document match = geoFilter(bbox(c));
        if (c.unified()) {
            if (!c.filter().equals("both")) match.append("facility_type", c.filter().equals("bus") ? 0 : 1);
            return List.of(new Document("$match", match));
        }
        if (!c.filter().equals("both")) return List.of(new Document("$match", match));
        return List.of(new Document("$match", match),
            new Document("$unionWith", new Document("coll", "bike_stations")
                .append("pipeline", List.of(new Document("$match", geoFilter(bbox(c)))))));
    }

    static String mongoCollection(Cond c) {
        if (c.unified()) return "facilities";
        if (c.scenario().equals("single")) throw new IllegalArgumentException("per-type collection");
        return c.filter().equals("bike") ? "bike_stations" : "bus_stops";
    }

    // ---- execution ----

    static long runOnce(Map<String, PreparedStatement> ps, MongoDatabase mongo, Cond c, int iter, Sample s) throws SQLException {
        return c.engine().equals("pg") ? runPg(ps, c, iter, s) : runMongo(mongo, c, iter, s);
    }

    static long runPg(Map<String, PreparedStatement> ps, Cond c, int iter, Sample sample) throws SQLException {
        PreparedStatement s;
        if (c.scenario().equals("single")) {
            int k = iter % sample.ids().length;
            if (c.unified()) { s = ps.get(c.id()); s.setInt(1, sample.types()[k]); s.setString(2, sample.ids()[k]); }
            else { s = ps.get(c.id() + (sample.types()[k] == 0 ? "_bus" : "_bike")); s.setString(1, sample.ids()[k]); }
        } else {
            s = ps.get(c.id());
            double[] b = bbox(c);
            int n = (!c.unified() && c.filter().equals("both")) ? 8 : 4;
            for (int i = 0; i < n; i++) s.setDouble(i + 1, b[i % 4]);
        }
        long rows = 0;
        try (ResultSet rs = s.executeQuery()) {
            while (rs.next()) {
                blackhole += rs.getInt(1) + rs.getString(2).length() + rs.getString(3).length()
                    + (long) rs.getDouble(4) + (long) rs.getDouble(5) + rs.getString(6).length();
                rows++;
            }
        }
        return rows;
    }

    static long runMongo(MongoDatabase mongo, Cond c, int iter, Sample sample) {
        Iterable<Document> it;
        if (c.scenario().equals("single")) {
            int k = iter % sample.ids().length;
            it = c.unified()
                ? mongo.getCollection("facilities")
                    .find(new Document("facility_type", sample.types()[k]).append("source_id", sample.ids()[k]))
                    .maxTime(60, TimeUnit.SECONDS)
                : mongo.getCollection(sample.types()[k] == 0 ? "bus_stops" : "bike_stations")
                    .find(new Document("source_id", sample.ids()[k])).maxTime(60, TimeUnit.SECONDS);
        } else {
            it = mongo.getCollection(mongoCollection(c)).aggregate(mongoPipeline(c)).maxTime(60, TimeUnit.SECONDS);
        }
        long rows = 0;
        for (Document d : it) {
            blackhole += d.getString("source_id").length() + d.getString("name").length();
            rows++;
        }
        return rows;
    }

    // ---- equality, plans, sizes, env ----

    static Set<String> pgKeys(Connection pg, boolean unified, String bboxName, String filter) throws SQLException {
        Cond c = new Cond("pg", unified, bboxName, filter);
        String sql = pgBboxSql(c, bbox(c)).replace("," + PG_FIELDS, ",source_id");
        Set<String> keys = new TreeSet<>();
        try (var st = pg.createStatement(); var rs = st.executeQuery(sql)) {
            while (rs.next()) keys.add(rs.getInt(1) + ":" + rs.getString(2));
        }
        return keys;
    }

    static Set<String> mongoKeys(MongoDatabase mongo, boolean unified, String bboxName, String filter) {
        Cond c = new Cond("mongo", unified, bboxName, filter);
        Set<String> keys = new TreeSet<>();
        for (Document d : mongo.getCollection(mongoCollection(c)).aggregate(mongoPipeline(c)))
            keys.add(d.getInteger("facility_type") + ":" + d.getString("source_id"));
        return keys;
    }

    static Document equality(Connection pg, MongoDatabase mongo) throws SQLException {
        List<Document> checks = new ArrayList<>();
        for (String b : BBOX_NAMES) for (String f : FILTERS) {
            Set<String> pu = pgKeys(pg, true, b, f), pss = pgKeys(pg, false, b, f);
            Set<String> mu = mongoKeys(mongo, true, b, f), ms = mongoKeys(mongo, false, b, f);
            checks.add(new Document("bbox", b).append("filter", f)
                .append("pg_unified", pu.size()).append("pg_separated", pss.size()).append("pg_equal", pu.equals(pss))
                .append("mongo_unified", mu.size()).append("mongo_separated", ms.size()).append("mongo_equal", mu.equals(ms))
                .append("cross_engine_count_diff", pu.size() - mu.size()));
        }
        return new Document("note", "equal은 같은 엔진 내부 통합/분리 ID 집합 비교. cross_engine은 건수 차만 기록(의미 차이 있음).")
            .append("checks", checks);
    }

    static void collectPlans(Connection pg, MongoDatabase mongo, Path dir, Sample sample) throws Exception {
        for (boolean unified : List.of(true, false))
            for (String b : BBOX_NAMES) for (String f : FILTERS) {
                Cond c = new Cond("pg", unified, b, f);
                StringBuilder plan = new StringBuilder();
                try (var st = pg.createStatement();
                     var rs = st.executeQuery("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + pgBboxSql(c, bbox(c)))) {
                    while (rs.next()) plan.append(rs.getString(1));
                }
                Files.writeString(dir.resolve(c.id() + ".json"), plan);
                Cond mc = new Cond("mongo", unified, b, f);
                List<Document> pipeline = mongoPipeline(mc);
                Document cmd = new Document("aggregate", mongoCollection(mc))
                    .append("pipeline", pipeline).append("cursor", new Document());
                Document explain = mongo.runCommand(new Document("explain", cmd).append("verbosity", "executionStats"));
                Files.writeString(dir.resolve(mc.id() + ".json"), explain.toJson());
            }
        // 단건 대표 1건: prepared 측정과 달리 literal 실행계획임을 파일명에 표시한다.
        String id = sample.ids()[0].replace("'", "''");
        int type = sample.types()[0];
        StringBuilder plan = new StringBuilder();
        try (var st = pg.createStatement();
             var rs = st.executeQuery("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT facility_type," + PG_FIELDS
                 + " FROM unified.facilities WHERE facility_type=" + type + " AND source_id='" + id + "'")) {
            while (rs.next()) plan.append(rs.getString(1));
        }
        Files.writeString(dir.resolve("pg-U_single_literal.json"), plan);
        Document cmd = new Document("find", "facilities")
            .append("filter", new Document("facility_type", type).append("source_id", sample.ids()[0]));
        Files.writeString(dir.resolve("mongo-U_single_literal.json"),
            mongo.runCommand(new Document("explain", cmd).append("verbosity", "executionStats")).toJson());
    }

    static Document sizes(Connection pg, MongoDatabase mongo) throws SQLException {
        List<Document> pgSizes = new ArrayList<>();
        try (var st = pg.createStatement(); var rs = st.executeQuery("""
            SELECT n.nspname||'.'||c.relname AS rel, pg_total_relation_size(c.oid) AS total,
                   pg_relation_size(c.oid) AS heap, pg_indexes_size(c.oid) AS indexes, c.reltuples::bigint AS approx_rows
            FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname IN ('unified','separated') AND c.relkind='r' ORDER BY 1""")) {
            while (rs.next()) pgSizes.add(new Document("relation", rs.getString(1))
                .append("total_bytes", rs.getLong(2)).append("heap_bytes", rs.getLong(3))
                .append("index_bytes", rs.getLong(4)).append("approx_rows", rs.getLong(5)));
        }
        List<Document> mongoSizes = new ArrayList<>();
        for (String coll : List.of("facilities", "bus_stops", "bike_stations")) {
            Document s = mongo.runCommand(new Document("collStats", coll));
            mongoSizes.add(new Document("collection", coll)
                .append("count", ((Number) s.get("count")).longValue())
                .append("data_bytes", ((Number) s.get("size")).longValue())
                .append("storage_bytes", ((Number) s.get("storageSize")).longValue())
                .append("total_index_bytes", ((Number) s.get("totalIndexSize")).longValue())
                .append("index_sizes", s.get("indexSizes")));
        }
        return new Document("postgresql", pgSizes).append("mongodb", mongoSizes);
    }

    static Document environment(Connection pg, MongoDatabase mongo, int warmup, int iters, int rounds) throws SQLException {
        String pgVersion = "", postgis = "";
        try (var st = pg.createStatement()) {
            try (var rs = st.executeQuery("SELECT version()")) { rs.next(); pgVersion = rs.getString(1); }
            try (var rs = st.executeQuery("SELECT PostGIS_Full_Version()")) { rs.next(); postgis = rs.getString(1); }
        }
        Document build = mongo.runCommand(new Document("buildInfo", 1));
        return new Document("timestamp", Instant.now().toString())
            .append("postgresql", pgVersion).append("postgis", postgis)
            .append("mongodb", build.getString("version"))
            .append("host_os", System.getProperty("os.name") + " " + System.getProperty("os.version"))
            .append("host_arch", System.getProperty("os.arch"))
            .append("java", System.getProperty("java.version"))
            .append("warmup", warmup).append("iterations_per_round", iters).append("rounds", rounds)
            .append("caveats", List.of(
                "PostgreSQL 컨테이너는 linux/amd64 에뮬레이션, MongoDB는 호스트 아키텍처 → 엔진 간 절대 속도 비교 불가",
                "warm-cache 측정. 단일 클라이언트, 단일 연결.",
                "PG bbox는 평면 ST_Intersects, Mongo bbox는 구면 $geoWithin으로 의미가 다름"));
    }

    // ---- summary ----

    static Document summarize(List<Cond> conds, Map<String, List<long[]>> byCond, int rounds) {
        List<Document> rows = new ArrayList<>();
        for (Cond c : conds) {
            List<long[]> recs = byCond.get(c.id());
            long[] all = recs.stream().mapToLong(r -> r[1]).filter(v -> v >= 0).sorted().toArray();
            long errors = recs.stream().filter(r -> r[1] < 0).count();
            long minRows = recs.stream().mapToLong(r -> r[2]).filter(v -> v >= 0).min().orElse(-1);
            long maxRows = recs.stream().mapToLong(r -> r[2]).filter(v -> v >= 0).max().orElse(-1);
            List<Document> perRound = new ArrayList<>();
            for (int r = 1; r <= rounds; r++) {
                final int round = r;
                long[] rr = recs.stream().filter(x -> x[0] == round && x[1] >= 0).mapToLong(x -> x[1]).sorted().toArray();
                perRound.add(new Document("round", r).append("p50_us", pct(rr, 0.50)).append("p95_us", pct(rr, 0.95)));
            }
            rows.add(new Document("condition", c.id())
                .append("engine", c.engine()).append("model", c.unified() ? "unified" : "separated")
                .append("scenario", c.scenario()).append("filter", c.filter() == null ? "" : c.filter())
                .append("samples", all.length).append("errors_or_timeouts", errors)
                .append("rows_min", minRows).append("rows_max", maxRows)
                .append("p50_us", pct(all, 0.50)).append("p95_us", pct(all, 0.95))
                .append("mean_us", all.length == 0 ? -1 : Arrays.stream(all).sum() / all.length)
                .append("per_round", perRound));
        }
        return new Document("conditions", rows);
    }

    static long pct(long[] sorted, double p) {
        if (sorted.length == 0) return -1;
        return sorted[Math.min(sorted.length - 1, Math.max(0, (int) Math.ceil(p * sorted.length) - 1))];
    }

    static void writeJson(Path path, Document doc) throws Exception {
        Files.writeString(path, doc.toJson());
    }
}
