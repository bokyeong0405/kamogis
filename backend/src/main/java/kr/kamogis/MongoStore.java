package kr.kamogis;

import com.mongodb.client.*;
import com.mongodb.client.model.*;
import org.bson.Document;
import java.util.*;

public final class MongoStore implements AutoCloseable {
    private final MongoClient client;
    private final MongoDatabase database;
    public MongoStore() {
        client=MongoClients.create(StorageLab.mongoUri());
        database=client.getDatabase("kamogis");
        database.runCommand(new Document("ping",1));
    }
    public void load(List<Facility> rows) {
        for(String name:List.of("facilities","bus_stops","bike_stations")) {
            List<WriteModel<Document>> batch=new ArrayList<>();
            for(var f:rows) {
                if(!name.equals("facilities") && f.type()!=(name.equals("bus_stops")?0:1)) continue;
                var key=new Document("source_id",f.id());
                if(name.equals("facilities")) key.append("facility_type",f.type());
                batch.add(new ReplaceOneModel<>(key,f.document(),new ReplaceOptions().upsert(true)));
                if(batch.size()==1000) { database.getCollection(name).bulkWrite(batch); batch.clear(); }
            }
            if(!batch.isEmpty()) database.getCollection(name).bulkWrite(batch);
        }
    }
    public Map<String,Document> read(boolean unified,double[] bbox) {
        Document filter=new Document();
        if(bbox!=null) {
            var ring=List.of(List.of(bbox[0],bbox[1]),List.of(bbox[2],bbox[1]),List.of(bbox[2],bbox[3]),List.of(bbox[0],bbox[3]),List.of(bbox[0],bbox[1]));
            filter=new Document("location",new Document("$geoWithin",new Document("$geometry",
                new Document("type","Polygon").append("coordinates",List.of(ring)))));
        }
        var pipeline=new ArrayList<Document>();
        pipeline.add(new Document("$match",filter));
        if(!unified) pipeline.add(new Document("$unionWith",new Document("coll","bike_stations")
            .append("pipeline",List.of(new Document("$match",filter)))));
        pipeline.add(new Document("$project",new Document("_id",0)));
        Map<String,Document> results=new TreeMap<>();
        try(var cursor=database.getCollection(unified?"facilities":"bus_stops").aggregate(pipeline).iterator()) {
            while(cursor.hasNext()) {
                var doc=cursor.next();
                String key=doc.getInteger("facility_type")+":"+doc.getString("source_id");
                if(results.put(key,doc)!=null) throw new IllegalStateException("Duplicate DB key: "+key);
            }
        }
        return results;
    }
    public void close() { client.close(); }
}
