#!/usr/bin/env python3
"""전체_도시철도역사정보 xlsx를 적재용 CSV로 바꾼다.

xlsx는 바이너리라 행정동 GeoJSON처럼 pg_read_file로 DB 안에서 풀 수 없다. 그렇다고
openpyxl/pandas를 새로 깔면 이 저장소의 파이썬 의존성이 0에서 1이 되므로, xlsx가
실제로는 XML zip이라는 점을 이용해 표준 라이브러리만으로 읽는다.

    python3 db/postgres/subway-xlsx-to-csv.py \
        data/raw/전체_도시철도역사정보_20260630.xlsx /tmp/subway-stations.csv

셀 서식은 무시하고 원문 문자열을 그대로 내보낸다. 역번호 '0809'의 앞자리 0과
위경도 소수점 15자리를 숫자로 해석하는 순간 잃기 때문이다.
"""
import csv
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
EXPECTED = ["역번호", "역사명", "노선번호", "노선명", "영문역사명", "한자역사명",
            "환승역구분", "환승노선번호", "환승노선명", "역위도", "역경도",
            "운영기관명", "역사도로명주소", "역사전화번호", "데이터기준일자"]


def cell_text(cell, shared):
    kind = cell.get("t")
    if kind == "inlineStr":
        return "".join(t.text or "" for t in cell.iter(NS + "t"))
    value = cell.find(NS + "v")
    if value is None:
        return ""
    return shared[int(value.text)] if kind == "s" else (value.text or "")


def rows(path):
    with zipfile.ZipFile(path) as archive:
        shared = []
        if "xl/sharedStrings.xml" in archive.namelist():
            table = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            shared = ["".join(t.text or "" for t in si.iter(NS + "t"))
                      for si in table.iter(NS + "si")]
        sheet = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
    for row in sheet.iter(NS + "row"):
        # 빈 셀은 <c>가 아예 없으므로 위치를 열 문자에서 되찾아야 자리가 밀리지 않는다.
        cells = {}
        for cell in row.iter(NS + "c"):
            column = re.match(r"[A-Z]+", cell.get("r")).group(0)
            cells[column] = cell_text(cell, shared)
        yield [cells.get(chr(ord("A") + i), "") for i in range(len(EXPECTED))]


def main(source, target):
    data = list(rows(source))
    header = [c.strip() for c in data[0]]
    if header != EXPECTED:
        raise SystemExit(f"예상과 다른 헤더입니다: {header}")
    body = [r for r in data[1:] if any(c.strip() for c in r)]
    with open(target, "w", newline="", encoding="utf-8") as out:
        writer = csv.writer(out)
        writer.writerows([[c.strip() for c in r] for r in body])
    print(f"{source} -> {target}: {len(body)} rows", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2])
