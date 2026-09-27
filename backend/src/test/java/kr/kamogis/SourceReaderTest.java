package kr.kamogis;

import org.bson.Document;
import org.junit.jupiter.api.Test;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class SourceReaderTest {
    @Test void crsFlagDoesNotBecomeDirectory() {
        assertEquals(java.nio.file.Path.of("data/raw"),StorageLab.rawDirectory(new String[]{"import","--crs=4326"}));
        assertEquals(java.nio.file.Path.of("somewhere"),StorageLab.rawDirectory(new String[]{"import","--crs=4326","somewhere"}));
        assertThrows(IllegalArgumentException.class,()->StorageLab.rawDirectory(new String[]{"import","--crs=4156"}));
    }
    @Test void duplicateWithinKindRejectedButSameIdAcrossKindsAllowed() {
        var bus=new Facility(0,"001","역",127,37,new Document());
        var bike=new Facility(1,"001","대여소",127,37,new Document());
        assertDoesNotThrow(()->SourceReader.validateUnique(List.of(bus,bike)));
        assertThrows(IllegalArgumentException.class,()->SourceReader.validateUnique(List.of(bus,bus)));
    }
    @Test void fullPayloadComparisonDetectsChangedNameWithSameCounts() {
        var original=new Facility(0,"001","원본",127,37,new Document());
        var changed=new Facility(0,"001","변경",127,37,new Document());
        assertThrows(IllegalStateException.class,()->StorageLab.requireEqual(
            java.util.Map.of(original.key(),original.document()),java.util.Map.of(changed.key(),changed.document()),"test"));
    }
}
