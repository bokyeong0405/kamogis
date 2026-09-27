package kr.kamogis;

import org.bson.Document;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class FacilityTest {
    @Test void rejectsInvalidCoordinatesAndTypes() {
        assertThrows(IllegalArgumentException.class, () -> new Facility(0,"1","역",Double.NaN,37,new Document()));
        assertThrows(IllegalArgumentException.class, () -> new Facility(0,"1","역",127,91,new Document()));
        assertThrows(IllegalArgumentException.class, () -> new Facility(2,"1","역",127,37,new Document()));
        assertThrows(IllegalArgumentException.class, () -> new Facility(0,"","역",127,37,new Document()));
    }
    @Test void preservesIdsAndLongitudeFirst() {
        var f = new Facility(0,"001","역",127,37,new Document("ars_id","00001"));
        assertEquals("0:001",f.key());
        assertEquals(java.util.List.of(127.0,37.0), f.document().get("location",Document.class).get("coordinates"));
        assertEquals("00001",f.document().get("attributes",Document.class).getString("ars_id"));
    }
}
