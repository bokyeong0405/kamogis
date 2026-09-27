package kr.kamogis;

import org.bson.Document;
import java.sql.*;
import java.util.*;

public final class PostgresStore implements AutoCloseable {
    private final Connection connection;
    public PostgresStore() throws SQLException {
        connection=DriverManager.getConnection(StorageLab.env("PG_URL","jdbc:postgresql://127.0.0.1:55432/kamogis"),
            StorageLab.env("PG_USER","kamogis"),StorageLab.required("PG_PASSWORD"));
    }
    public void load(List<Facility> rows) throws SQLException {
        connection.setAutoCommit(false);
        try {
            for(String table:List.of("unified.facilities","separated.bus_stops","separated.bike_stations")) {
                boolean unified=table.startsWith("unified");
                String sql="INSERT INTO " + table + " ("+(unified?"facility_type,":"")+"source_id,name,geom,attributes) VALUES ("
                    +(unified?"?,":"")+"?,?,ST_SetSRID(ST_MakePoint(?,?),4326),?::jsonb) ON CONFLICT ("
                    +(unified?"facility_type,":"")+"source_id) DO UPDATE SET name=EXCLUDED.name,geom=EXCLUDED.geom,attributes=EXCLUDED.attributes";
                try(var stmt=connection.prepareStatement(sql)) {
                    int count=0;
                    for(var f:rows) {
                        if(!unified && f.type()!=(table.endsWith("bus_stops")?0:1)) continue;
                        int i=1;
                        if(unified) stmt.setInt(i++,f.type());
                        stmt.setString(i++,f.id()); stmt.setString(i++,f.name());
                        stmt.setDouble(i++,f.lon()); stmt.setDouble(i++,f.lat());
                        stmt.setString(i,f.attributes().toJson()); stmt.addBatch();
                        if(++count%1000==0) stmt.executeBatch();
                    }
                    stmt.executeBatch();
                }
            }
            connection.commit();
        } catch(SQLException ex) { connection.rollback(); throw ex; }
        finally { connection.setAutoCommit(true); }
        try(var stmt=connection.createStatement()) {
            stmt.execute("ANALYZE unified.facilities");
            stmt.execute("ANALYZE separated.bus_stops");
            stmt.execute("ANALYZE separated.bike_stations");
        }
    }
    public Map<String,Document> read(boolean unified, double[] bbox) throws SQLException {
        String filter=bbox==null?"":" WHERE ST_Intersects(geom,ST_MakeEnvelope(?,?,?,?,4326))";
        String fields="source_id,name,ST_X(geom) AS lon,ST_Y(geom) AS lat,attributes::text AS attributes";
        String sql=unified?"SELECT facility_type,"+fields+" FROM unified.facilities"+filter:
            "SELECT 0 AS facility_type,"+fields+" FROM separated.bus_stops"+filter+
            " UNION ALL SELECT 1 AS facility_type,"+fields+" FROM separated.bike_stations"+filter;
        Map<String,Document> results=new TreeMap<>();
        try(var stmt=connection.prepareStatement(sql)) {
            if(bbox!=null) for(int i=0;i<(unified?4:8);i++) stmt.setDouble(i+1,bbox[i%4]);
            try(var rs=stmt.executeQuery()) {
                while(rs.next()) {
                    var f=new Facility(rs.getInt("facility_type"),rs.getString("source_id"),rs.getString("name"),
                        rs.getDouble("lon"),rs.getDouble("lat"),Document.parse(rs.getString("attributes")));
                    results.put(f.key(),f.document());
                }
            }
        }
        return results;
    }
    public void close() throws SQLException { connection.close(); }
}
