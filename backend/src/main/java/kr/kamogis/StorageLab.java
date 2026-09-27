package kr.kamogis;

import java.nio.file.Path;
import java.util.*;
import org.bson.Document;

public final class StorageLab {
    private StorageLab() {}
    static String env(String name,String fallback) { return System.getenv().getOrDefault(name,fallback); }

    /** 비밀번호처럼 기본값을 두면 안 되는 값. 없으면 연결을 시도하지 않고 즉시 멈춘다. */
    static String required(String name) {
        String value=System.getenv(name);
        if(value==null || value.isBlank())
            throw new IllegalStateException(name+" is not set. Copy .env.example to .env and load it:\n"
                +"  set -a; source .env; set +a");
        return value;
    }

    /** MONGO_URI를 직접 주면 그대로 쓰고, 아니면 사용자·비밀번호로 조립한다. 비밀번호는 퍼센트 인코딩한다. */
    static String mongoUri() {
        String direct=System.getenv("MONGO_URI");
        if(direct!=null && !direct.isBlank()) return direct;
        String encoded=java.net.URLEncoder.encode(required("MONGO_PASSWORD"),java.nio.charset.StandardCharsets.UTF_8)
            .replace("+","%20");
        return "mongodb://"+env("MONGO_USER","kamogis")+":"+encoded+"@"+env("MONGO_HOST","127.0.0.1:57017")
            +"/?authSource=admin&serverSelectionTimeoutMS=5000";
    }
    public static void main(String[] args) throws Exception {
        if(args.length<1 || !Set.of("validate","import","verify").contains(args[0]))
            throw new IllegalArgumentException("Usage: validate|import|verify [raw-directory] [--crs=4326]");
        Path raw=rawDirectory(args);
        var rows=SourceReader.read(raw);
        System.out.println("Validated bus="+rows.stream().filter(f->f.type()==0).count()+" bike="+rows.stream().filter(f->f.type()==1).count());
        if(args[0].equals("validate")) return;
        if(!Arrays.asList(args).contains("--crs=4326"))
            throw new IllegalArgumentException("Explicit --crs=4326 required: coordinates are interpreted as WGS84, not transformed.");
        try(var mongo=new MongoStore(); var pg=new PostgresStore()) {
            if(args[0].equals("import")) {
                pg.load(rows);
                System.out.println("PostgreSQL unified + separated committed.");
                mongo.load(rows);
                System.out.println("MongoDB unified + separated acknowledged.");
            }
            Map<String,Document> expected=new TreeMap<>();
            rows.forEach(f->expected.put(f.key(),f.document()));
            for(boolean unified:List.of(true,false)) {
                requireEqual(expected,pg.read(unified,null),"PostgreSQL "+unified);
                requireEqual(expected,mongo.read(unified,null),"MongoDB "+unified);
            }
            for(double[] bbox:List.of(new double[]{126.97,37.55,127.02,37.59},new double[]{126.8,37.44,127.17,37.68})) {
                var p=pg.read(true,bbox); requireEqual(p,pg.read(false,bbox),"PostgreSQL bbox");
                var m=mongo.read(true,bbox); requireEqual(m,mongo.read(false,bbox),"MongoDB bbox");
                System.out.println("BBox model equality OK; PostgreSQL="+p.size()+" MongoDB="+m.size()+" (cross-engine spatial semantics may differ)");
            }
            System.out.println("PASS: all four models exactly match "+expected.size()+" source records; bbox equality verified within each DB.");
        }
    }
    static Path rawDirectory(String[] args) {
        Path raw=Path.of("data/raw");
        boolean provided=false;
        for(int i=1;i<args.length;i++) {
            if(args[i].equals("--crs=4326")) continue;
            if(args[i].startsWith("--") || provided) throw new IllegalArgumentException("Unexpected argument: "+args[i]);
            raw=Path.of(args[i]); provided=true;
        }
        return raw;
    }
    static void requireEqual(Map<String,Document> expected,Map<String,Document> actual,String label) {
        if(!expected.equals(actual)) throw new IllegalStateException(label+" mismatch: expected="+expected.size()+" actual="+actual.size());
    }
}
