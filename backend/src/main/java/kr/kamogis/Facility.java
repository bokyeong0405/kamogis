package kr.kamogis;

import org.bson.Document;
import java.util.List;

public record Facility(int type, String id, String name, double lon, double lat, Document attributes) {
    public Facility {
        if ((type != 0 && type != 1) || id == null || id.isBlank() || name == null || name.isBlank()
            || !Double.isFinite(lon) || !Double.isFinite(lat) || lon < -180 || lon > 180
            || lat < -90 || lat > 90 || (lon == 0 && lat == 0) || attributes == null)
            throw new IllegalArgumentException("Invalid facility: " + type + ":" + id);
    }
    public String key() { return type + ":" + id; }
    public Document document() {
        return new Document("facility_type",type).append("source_id",id).append("name",name)
            .append("location",new Document("type","Point").append("coordinates",List.of(lon,lat)))
            .append("attributes",attributes);
    }
}
