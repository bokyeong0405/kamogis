import proj4 from 'proj4';
import { register } from 'ol/proj/proj4.js';

export type CrsCode = 'EPSG:4326' | 'EPSG:3857' | 'EPSG:5179' | 'EPSG:5186' | 'EPSG:5181' | 'EPSG:5174' | 'EPSG:32652';

export type CrsInfo = {
  code: CrsCode;
  label: string;
  name: string;
  datum: string;
  unit: string;
  axisX: string;
  axisY: string;
  decimals: number;
  summary: string;
  useWhen: string;
  caution: string;
};

// proj4js는 EPSG:4326·EPSG:3857만 내장하므로 나머지 5개를 직접 정의합니다.
// GRS80 계열에 +towgs84=0,...을 명시해야 proj4js가 WGS84와 같은 datum으로 처리합니다.
const DEFS: [CrsCode, string][] = [
  ['EPSG:5179', '+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'],
  ['EPSG:5186', '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'],
  ['EPSG:5181', '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=500000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'],
  // 이 7-파라미터는 국토지리정보원 공식 10-파라미터(EPSG:5189, Molodensky-Badekas)의 근사입니다.
  // 서울 표본에서 PostGIS 결과와 약 0.05m 차이로, 후보 파라미터 중 가장 가까워 채택했습니다.
  ['EPSG:5174', '+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +units=m +no_defs +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43'],
  ['EPSG:32652', '+proj=utm +zone=52 +datum=WGS84 +units=m +no_defs'],
];

proj4.defs(DEFS);
register(proj4);

export const CRS_LIST: CrsInfo[] = [
  {
    code: 'EPSG:4326',
    label: '4326 · WGS 84 경위도',
    name: 'WGS 84',
    datum: 'WGS 84 (GRS80 타원체)',
    unit: '도(°)',
    axisX: '경도',
    axisY: '위도',
    decimals: 6,
    summary: '투영하지 않은 지리좌표계라 값이 각도입니다. 전 세계를 하나의 기준으로 표현할 수 있어 위치를 주고받는 표준으로 쓰입니다.',
    useWhen: 'GPS 수신값, GeoJSON, 공공데이터 API, 데이터베이스 저장. 이 프로젝트도 두 테이블 모두 geometry(Point, 4326)으로 저장합니다.',
    caution: '단위가 도라서 좌표를 빼도 미터가 나오지 않습니다. 거리는 geography 타입이나 투영좌표계로 계산해야 합니다.',
  },
  {
    code: 'EPSG:3857',
    label: '3857 · Web Mercator',
    name: 'WGS 84 / Pseudo-Mercator',
    datum: 'WGS 84 (구체로 근사)',
    unit: '미터(m)',
    axisX: 'X (동)',
    axisY: 'Y (북)',
    decimals: 3,
    summary: '지구를 한 변 약 4,007만 m인 정사각형으로 펼친 투영입니다. 웹 지도 타일의 사실상 표준이라 값이 수백만 단위로 커집니다.',
    useWhen: '배경지도 타일과 화면 렌더링. 이 지도의 OpenLayers 내부 표시 좌표계이기도 합니다.',
    caution: '미터 단위지만 거리 계산용이 아닙니다. 서울(위도 37.5°)에서는 평면거리가 실제보다 약 26% 크게 나옵니다 — 실측으로 54.81 m 거리가 69.24 m로 계산됐습니다.',
  },
  {
    code: 'EPSG:5179',
    label: '5179 · UTM-K 전국 단일',
    name: 'Korea 2000 / Unified CS',
    datum: 'Korea 2000 (GRS80)',
    unit: '미터(m)',
    axisX: 'X (동)',
    axisY: 'Y (북)',
    decimals: 3,
    summary: '중앙자오선 127.5°E, 축척계수 0.9996으로 전국을 하나의 평면에 담는 국가 표준 투영입니다.',
    useWhen: '국토지리정보원 기본도, 도로명주소 DB, 네이버 지도. 전국 범위를 한 좌표계로 다루며 거리를 계산할 때의 기본 선택지입니다.',
    caution: '축척계수가 1이 아니라 거리가 아주 조금 짧게 나옵니다 — 실측 54.81 m가 54.79 m(−0.04%)로 계산됐습니다. 실용상 무시할 수준이지만 원리는 알아둘 필요가 있습니다.',
  },
  {
    code: 'EPSG:5186',
    label: '5186 · 중부원점 2010',
    name: 'Korea 2000 / Central Belt 2010',
    datum: 'Korea 2000 (GRS80)',
    unit: '미터(m)',
    axisX: 'X (동)',
    axisY: 'Y (북)',
    decimals: 3,
    summary: '중부원점(127°E) 기준 TM 투영이고 축척계수가 정확히 1.0입니다. 원점 근처에서는 투영 왜곡이 사실상 없습니다.',
    useWhen: '수치지형도·지적도 같은 정밀 측량 성과물. 서울·중부권으로 범위가 한정된 정확한 미터 거리 계산.',
    caution: '적용 범위가 좁습니다. 전국을 덮으려면 서부(5185)·동부(5187)·동해(5188) 벨트를 따로 써야 하고, 벨트가 다른 데이터는 그대로 겹칠 수 없습니다.',
  },
  {
    code: 'EPSG:5181',
    label: '5181 · 중부원점 (카카오맵)',
    name: 'Korea 2000 / Central Belt',
    datum: 'Korea 2000 (GRS80)',
    unit: '미터(m)',
    axisX: 'X (동)',
    axisY: 'Y (북)',
    decimals: 3,
    summary: '카카오맵이 내부적으로 쓰는 좌표계입니다. 타원체·중앙자오선(127°E)·축척계수(1.0)가 5186과 완전히 같고 북쪽 오프셋만 500,000 m로 다릅니다.',
    useWhen: '카카오맵 계열 서비스나 이 좌표계로 배포된 데이터와 좌표를 주고받을 때.',
    caution: '5186과 X 값이 완전히 같고 Y만 정확히 100,000 m 차이납니다. 좌표 숫자만 보고는 둘을 구분할 수 없으니 반드시 출처의 EPSG 코드를 확인해야 합니다. 잘못 넣으면 100 km 떨어진 곳에 찍힙니다.',
  },
  {
    code: 'EPSG:5174',
    label: '5174 · 구 중부원점 (Bessel)',
    name: 'Korean 1985 / Modified Central Belt',
    datum: 'Korean 1985 (Bessel 1841) — datum이 다름',
    unit: '미터(m)',
    axisX: 'X (동)',
    axisY: 'Y (북)',
    decimals: 3,
    summary: '세계측지계를 도입하기 전의 구 좌표계로, 기준 타원체 자체가 Bessel 1841입니다. 투영 파라미터만 맞춰서는 위치가 절대 맞지 않습니다.',
    useWhen: '연속지적도처럼 아직 이 좌표계로 배포되는 공공데이터를 읽을 때. 새로 만드는 데이터에는 쓰지 않습니다.',
    caution: 'datum 변환을 빠뜨리면 약 363 m 어긋납니다(실측). 이 화면의 proj4js는 7-파라미터 근사를 쓰기 때문에, 공식 10-파라미터를 적용하는 PostGIS 값과 약 0.05 m 차이가 납니다.',
  },
  {
    code: 'EPSG:32652',
    label: '32652 · UTM zone 52N',
    name: 'WGS 84 / UTM zone 52N',
    datum: 'WGS 84',
    unit: '미터(m)',
    axisX: 'X (동)',
    axisY: 'Y (북)',
    decimals: 3,
    summary: '전 세계를 경도 6° 폭으로 나눈 국제 표준 투영입니다. 서울은 52구역(중앙자오선 129°E)에 들어갑니다.',
    useWhen: '위성영상이나 국제 데이터셋과 함께 분석할 때의 공통 기반. 국내 전용 좌표계를 모르는 해외 도구와도 잘 맞습니다.',
    caution: '한국은 경도 126°를 경계로 51·52 두 구역에 걸칩니다. 구역이 다른 데이터는 한 좌표계로 이어 붙일 수 없습니다.',
  },
];

export const DEFAULT_CRS: CrsCode = 'EPSG:4326';

export function getCrs(code: CrsCode): CrsInfo {
  return CRS_LIST.find((c) => c.code === code) ?? CRS_LIST[0];
}

export function projectFromLonLat(lon: number, lat: number, code: CrsCode): [number, number] {
  if (code === 'EPSG:4326') return [lon, lat];
  return proj4('EPSG:4326', code, [lon, lat]) as [number, number];
}

// 어떤 좌표계로 계산한 숫자를 **다른 좌표계라고 알려줬을 때** 실제로 찍히는 위치.
// 투영 미터를 경위도로 읽으면 위도가 90도를 넘어 실패하는데, 이 실패가 곧 "한국에서는
// 이 실수를 탐지할 수 있다"는 뜻이라 예외로 감추지 않고 null로 구분해 돌려줍니다.
export function misreadAs(
  lon: number, lat: number, from: CrsCode, to: CrsCode,
): [number, number] | null {
  const [x, y] = projectFromLonLat(lon, lat, from);
  try {
    const [mlon, mlat] = to === 'EPSG:4326' ? [x, y] : proj4(to, 'EPSG:4326', [x, y]) as [number, number];
    if (!Number.isFinite(mlon) || !Number.isFinite(mlat) || Math.abs(mlat) > 90) return null;
    return [mlon, mlat];
  } catch {
    return null;
  }
}

export function formatCoordinate(lon: number, lat: number, code: CrsCode): { x: string; y: string } {
  const info = getCrs(code);
  const [x, y] = projectFromLonLat(lon, lat, code);
  const opts = { minimumFractionDigits: info.decimals, maximumFractionDigits: info.decimals };
  return { x: x.toLocaleString('ko-KR', opts), y: y.toLocaleString('ko-KR', opts) };
}
