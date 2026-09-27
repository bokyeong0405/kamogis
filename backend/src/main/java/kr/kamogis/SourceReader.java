package kr.kamogis;

import org.apache.poi.ss.usermodel.*;
import org.bson.Document;
import java.nio.file.*;
import java.util.*;

public final class SourceReader {
    private static final DataFormatter FORMAT = new DataFormatter(Locale.ROOT);
    private SourceReader() {}
    public static List<Facility> read(Path directory) throws Exception {
        List<Facility> facilities = new ArrayList<>();
        readFile(directory.resolve("bus-stops-20260902.xlsx"),0,1,facilities);
        readFile(directory.resolve("bike-stations-202606.xlsx"),1,5,facilities);
        validateUnique(facilities);
        return List.copyOf(facilities);
    }
    public static void validateUnique(List<Facility> facilities) {
        Set<String> ids = new HashSet<>();
        for (var f : facilities) if (!ids.add(f.key()))
            throw new IllegalArgumentException("Duplicate source identity: " + f.key());
    }
    private static String text(Row row,int index) {
        return FORMAT.formatCellValue(row.getCell(index)).trim();
    }
    private static double number(Row row,int index) {
        var cell=row.getCell(index);
        return cell != null && cell.getCellType()==CellType.NUMERIC
            ? cell.getNumericCellValue() : Double.parseDouble(text(row,index));
    }
    private static void readFile(Path path,int type,int start,List<Facility> target) throws Exception {
        try (var input=Files.newInputStream(path); var workbook=WorkbookFactory.create(input)) {
            var sheet=workbook.getSheetAt(0);
            if (type==0 && !"NODE_ID".equals(text(sheet.getRow(0),0)))
                throw new IllegalArgumentException("Unexpected bus header: " + path);
            if (type==1 && !text(sheet.getRow(0),0).replace("\n", "").contains("대여소번호"))
                throw new IllegalArgumentException("Unexpected bike header: " + path);
            for (int i=start;i<=sheet.getLastRowNum();i++) {
                var row=sheet.getRow(i);
                if(row==null) continue;
                boolean empty=true;
                for(var cell:row) if(!FORMAT.formatCellValue(cell).isBlank()) { empty=false; break; }
                if(empty) continue;
                try {
                    Document attributes;
                    if(type==0) attributes=new Document("ars_id",text(row,1)).append("stop_type",text(row,5));
                    else attributes=new Document("district",text(row,2)).append("address",text(row,3))
                        .append("installed_at_raw",text(row,6)).append("lcd_racks_raw",text(row,7))
                        .append("qr_racks_raw",text(row,8)).append("operation_mode",text(row,9));
                    target.add(new Facility(type,text(row,0),text(row,type==0?2:1),
                        number(row,type==0?3:5),number(row,4),attributes));
                } catch(RuntimeException ex) {
                    throw new IllegalArgumentException(path + ": row " + (i+1) + ": " + ex.getMessage(),ex);
                }
            }
        }
    }
}
