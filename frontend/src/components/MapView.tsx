import { useEffect, useRef, useState } from 'react';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import TileLayer from 'ol/layer/Tile.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import OSM from 'ol/source/OSM.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import Point from 'ol/geom/Point.js';
import { Circle as CircleStyle, Fill, Stroke, Style, Text } from 'ol/style.js';
import { defaults as defaultControls, ScaleLine } from 'ol/control.js';
import { fromLonLat, toLonLat, transformExtent } from 'ol/proj.js';
import LineString from 'ol/geom/LineString.js';
import Feature from 'ol/Feature.js';
import { getDistance } from 'ol/sphere.js';
import { CRS_LIST, DEFAULT_CRS, formatCoordinate, getCrs, misreadAs, type CrsCode } from '../crs';

// GeoJSON/API 좌표는 [경도, 위도](EPSG:4326), 지도 표시는 EPSG:3857을 사용합니다.
const SEOUL = [126.978, 37.5665];
const INITIAL_ZOOM = 12;

type LayerKey = 'bus' | 'bike';
type FacetDef = { key: string; label: string; mode: 'multi' | 'single' };
type FacetOption = { value: string; count: number };
type FacetData = Record<string, FacetOption[]>;

type LayerDef = {
  key: LayerKey;
  label: string;
  slug: string;
  color: string;
  radius: number;
  colorBy: string;
  palette: string[];
  facets: FacetDef[];
};

const LAYERS: LayerDef[] = [
  {
    key: 'bus',
    label: '버스정류소',
    slug: 'bus-stops',
    color: '#2563eb',
    radius: 5,
    colorBy: 'stop_type',
    palette: ['#2563eb', '#7c3aed', '#db2777', '#0891b2', '#64748b', '#1e293b'],
    facets: [{ key: 'stop_type', label: '정류소 유형', mode: 'multi' }],
  },
  {
    key: 'bike',
    label: '따릉이 대여소',
    slug: 'bike-stations',
    color: '#16a34a',
    radius: 6,
    colorBy: 'operation_mode',
    palette: ['#16a34a', '#ea580c', '#a16207'],
    facets: [
      { key: 'operation_mode', label: '거치대 방식', mode: 'multi' },
      { key: 'district', label: '자치구', mode: 'single' },
    ],
  },
];

// 행정동 경계는 MultiPolygon이고 필터·색상 분류가 없어 시설 레이어(LAYERS)와 구조를 공유하지 않습니다.
const BOUNDARY = { key: 'dong', label: '행정동 경계', slug: 'admin-dongs' } as const;

// 지하철은 노선(LineString)과 역(Point) 두 레이어가 한 토글로 묶입니다.
const SUBWAY = {
  lineKey: 'subway-line',
  stationKey: 'subway-station',
  label: '지하철',
  linesSlug: 'subway-lines',
  stationsSlug: 'subway-stations',
} as const;

// 노선색은 운영기관 공식 색을 노선명으로 맞춥니다. 같은 계통을 공유하는 광역철도
// (경부·경인·경원선은 1호선, 일산선은 3호선, 진접선은 4호선)는 계통 색을 따릅니다.
const LINE_COLORS: Record<string, string> = {
  '1호선': '#0052a4', 경부선: '#0052a4', 경인선: '#0052a4', 경원선: '#0052a4',
  '2호선': '#00a84d',
  '3호선': '#ef7c1c', 일산선: '#ef7c1c',
  '4호선': '#00a5de', 진접선: '#00a5de', 안산과천선: '#00a5de',
  '5호선': '#996cac',
  '6호선': '#cd7c2f',
  '7호선': '#747f00', '도시철도 7호선': '#747f00',
  '8호선': '#e6186c', '수도권 광역철도 8호선': '#e6186c',
  '서울 도시철도 9호선': '#bdb092', '수도권  도시철도 9호선': '#bdb092',
  경의중앙선: '#77c4a3', 분당선: '#f5a200', 수인선: '#f5a200', 신분당선: '#d4003b',
  경춘선: '#0c8e72', 경강선: '#003da5', 서해선: '#8fc31f', 우이신설선: '#b7c452',
  김포도시철도: '#a17800', 인천국제공항선: '#0090d2',
  '인천지하철 1호선': '#7ca8d5', '인천지하철 2호선': '#ed8b00',
  '수도권 경량도시철도 신림선': '#6789ca',
};
const SUBWAY_FALLBACK = '#5b6b7a';
const lineColor = (name: string) => LINE_COLORS[name] ?? SUBWAY_FALLBACK;

// 역 이름표는 노선이 구분될 만큼 확대했을 때만 그립니다.
const STATION_LABEL_MAX_RESOLUTION = 10;

type SubwayLineInfo = {
  lineCode: string;
  lineName: string;
  branch: string;
  stationCount: number;
  maxGapM: number;
  orderVerified: boolean;
};

const layerUrl = (slug: string) => `/api/layers/${slug}`;

type DongFacetCount = { value: string; count: number };
// 지하철은 layers와 구조가 다릅니다. 환승역이 노선 수만큼 행으로 들어 있어
// 행을 세면 역 개수가 되지 않으므로, 서버가 역 이름으로 묶어 노선 목록을 함께 보냅니다.
type DongStation = { name: string; lines: string[] };
type DongSummary = {
  dong: { adm_cd: string; adm_cd2: string; adm_nm: string; sgg_nm: string; dong_nm: string; area_km2: number };
  layers: Record<string, { total: number; facets: Record<string, DongFacetCount[]> }>;
  subway: { total: number; stations: DongStation[] };
};

// 이름표는 동이 구분될 만큼 확대했을 때만 그립니다. EPSG:3857 resolution 25는 대략 zoom 13입니다.
const LABEL_MAX_RESOLUTION = 25;

const boundaryStroke = new Stroke({ color: 'rgba(180,83,9,0.7)', width: 1.2 });
const boundaryFill = new Fill({ color: 'rgba(180,83,9,0.04)' });
const boundaryStyle = new Style({ stroke: boundaryStroke, fill: boundaryFill });
const boundarySelectedStyle = new Style({
  stroke: new Stroke({ color: '#b45309', width: 2.6 }),
  fill: new Fill({ color: 'rgba(180,83,9,0.14)' }),
});
const boundaryLabelStyle = new Style({
  stroke: boundaryStroke,
  fill: boundaryFill,
  text: new Text({
    font: '600 11px system-ui, sans-serif',
    fill: new Fill({ color: '#7c3d09' }),
    stroke: new Stroke({ color: 'rgba(255,255,255,0.85)', width: 3 }),
    overflow: true,
  }),
});

type SelectedDong = { admCd: string; admNm: string; dongNm: string; sggNm: string };

type Selected = {
  layer: LayerKey | typeof SUBWAY.stationKey;
  sourceId: string;
  name: string;
  lon: number;
  lat: number;
  attributes: Record<string, unknown>;
};

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

// 지도를 움직일 때마다 Style을 새로 만들지 않도록 레이어·색상 조합으로 캐시합니다.
const styleCache: Record<string, Style> = {};

function styleFor(def: LayerDef, color: string): Style {
  const cacheKey = `${def.key}|${color}`;
  return (styleCache[cacheKey] ??= new Style({
    image: new CircleStyle({
      radius: def.radius,
      fill: new Fill({ color }),
      stroke: new Stroke({ color: '#ffffff', width: 1.5 }),
    }),
  }));
}

// 순서 미검증 노선은 점선으로 그립니다. 형상이 역번호 순서를 그대로 믿고 만든 것이라
// 실선과 같은 무게로 보이면 안 됩니다.
const subwayLineStyles: Record<string, Style> = {};
function subwayLineStyle(lineName: string, verified: boolean): Style {
  const color = lineColor(lineName);
  return (subwayLineStyles[`${color}|${verified}`] ??= new Style({
    stroke: new Stroke({
      color,
      width: verified ? 3 : 2,
      lineDash: verified ? undefined : [6, 6],
    }),
  }));
}

const subwayStationStyles: Record<string, Style> = {};
function subwayStationStyle(lineName: string, withLabel: boolean): Style {
  const color = lineColor(lineName);
  return (subwayStationStyles[`${color}|${withLabel}`] ??= new Style({
    image: new CircleStyle({
      radius: 4,
      fill: new Fill({ color: '#ffffff' }),
      stroke: new Stroke({ color, width: 2 }),
    }),
    text: withLabel
      ? new Text({
          font: '600 11px system-ui, sans-serif',
          offsetY: -12,
          fill: new Fill({ color: '#1e293b' }),
          stroke: new Stroke({ color: 'rgba(255,255,255,0.9)', width: 3 }),
        })
      : undefined,
  }));
}

// 좌표계 오용 재현용 표식. 실제 위치는 채운 점, 잘못 찍힌 위치는 빈 붉은 점으로 두고
// 둘을 점선으로 잇습니다.
const misreadTrueStyle = new Style({
  image: new CircleStyle({
    radius: 6,
    fill: new Fill({ color: '#0f172a' }),
    stroke: new Stroke({ color: '#ffffff', width: 2 }),
  }),
  text: new Text({
    text: '실제 위치', offsetY: -16, font: '600 11px system-ui, sans-serif',
    fill: new Fill({ color: '#0f172a' }),
    stroke: new Stroke({ color: 'rgba(255,255,255,0.9)', width: 3 }),
  }),
});
const misreadWrongStyle = new Style({
  image: new CircleStyle({
    radius: 7,
    fill: new Fill({ color: 'rgba(220,38,38,0.15)' }),
    stroke: new Stroke({ color: '#dc2626', width: 2.5 }),
  }),
  text: new Text({
    offsetY: -17, font: '600 11px system-ui, sans-serif',
    fill: new Fill({ color: '#b91c1c' }),
    stroke: new Stroke({ color: 'rgba(255,255,255,0.9)', width: 3 }),
  }),
});
const misreadLinkStyle = new Style({
  stroke: new Stroke({ color: '#dc2626', width: 1.8, lineDash: [5, 5] }),
});

// 1 km 미만은 m, 그 이상은 km. 313 m와 13,000 km를 한 목록에 같이 세워야 합니다.
function formatDistance(m: number): string {
  if (m < 1000) return `${m.toFixed(1)} m`;
  if (m < 100000) return `${(m / 1000).toFixed(2)} km`;
  return `${Math.round(m / 1000).toLocaleString('ko-KR')} km`;
}

export default function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const sourcesRef = useRef<Record<LayerKey, VectorSource>>({ bus: new VectorSource(), bike: new VectorSource() });
  const layersRef = useRef<Partial<Record<LayerKey, VectorLayer>>>({});
  const abortRef = useRef<Partial<Record<LayerKey, AbortController>>>({});
  const visibleRef = useRef<Record<LayerKey, boolean>>({ bus: true, bike: true });
  // 선택 상태와 분류 색상은 OpenLayers 콜백 안에서 읽으므로 state와 ref를 함께 둡니다.
  const facetsRef = useRef<Partial<Record<LayerKey, FacetData>>>({});
  const filtersRef = useRef<Record<LayerKey, Record<string, string[]>>>({ bus: {}, bike: {} });
  const colorsRef = useRef<Record<LayerKey, Record<string, string>>>({ bus: {}, bike: {} });
  const [center, setCenter] = useState(SEOUL);
  const [tileError, setTileError] = useState(false);
  const [visible, setVisible] = useState<Record<LayerKey, boolean>>({ bus: true, bike: true });
  const [counts, setCounts] = useState<Record<LayerKey, number | null>>({ bus: null, bike: null });
  const [apiError, setApiError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [crs, setCrs] = useState<CrsCode>(DEFAULT_CRS);
  // 재현을 켤 때 기준점을 고정합니다. 지도 중심을 그대로 쓰면 view.fit이 중심을 옮기고
  // 그 중심이 다시 기준점이 되어 표식이 끝없이 따라다닙니다.
  const [misreadOrigin, setMisreadOrigin] = useState<[number, number] | null>(null);
  const [misreadTarget, setMisreadTarget] = useState<CrsCode | null>(null);
  const misreadSourceRef = useRef(new VectorSource());
  const misreadLayerRef = useRef<VectorLayer | null>(null);
  const boundarySourceRef = useRef(new VectorSource());
  const boundaryLayerRef = useRef<VectorLayer | null>(null);
  const boundaryAbortRef = useRef<AbortController | null>(null);
  const boundaryVisibleRef = useRef(false);
  const [boundaryVisible, setBoundaryVisible] = useState(false);
  const [boundaryCount, setBoundaryCount] = useState<number | null>(null);
  // 노선과 역은 한 토글로 묶여 항상 같이 갱신되므로 AbortController도 하나만 둡니다.
  const subwayLineSourceRef = useRef(new VectorSource());
  const subwayStationSourceRef = useRef(new VectorSource());
  const subwayLineLayerRef = useRef<VectorLayer | null>(null);
  const subwayStationLayerRef = useRef<VectorLayer | null>(null);
  const subwayAbortRef = useRef<AbortController | null>(null);
  const subwayVisibleRef = useRef(false);
  const unverifiedRef = useRef(false);
  const [subwayVisible, setSubwayVisible] = useState(false);
  const [includeUnverified, setIncludeUnverified] = useState(false);
  const [subwayCounts, setSubwayCounts] = useState<{ lines: number; stations: number } | null>(null);
  const [subwayLineInfos, setSubwayLineInfos] = useState<SubwayLineInfo[]>([]);
  const selectedDongRef = useRef<SelectedDong | null>(null);
  const [selectedDong, setSelectedDong] = useState<SelectedDong | null>(null);
  const summaryAbortRef = useRef<AbortController | null>(null);
  const [dongSummary, setDongSummary] = useState<DongSummary | null>(null);
  const [facets, setFacets] = useState<Partial<Record<LayerKey, FacetData>>>({});
  const [filters, setFilters] = useState<Record<LayerKey, Record<string, string[]>>>({ bus: {}, bike: {} });

  function currentBbox(): string | null {
    const map = mapRef.current;
    const size = map?.getSize();
    if (!map || !size) return null;
    const [minLon, minLat, maxLon, maxLat] = transformExtent(
      map.getView().calculateExtent(size), 'EPSG:3857', 'EPSG:4326');
    const b = [clamp(minLon, -180, 180), clamp(minLat, -90, 90), clamp(maxLon, -180, 180), clamp(maxLat, -90, 90)];
    if (b[0] >= b[2] || b[1] >= b[3]) return null;
    return b.map((v) => v.toFixed(6)).join(',');
  }

  // 선택한 값이 없는 다중 선택 필터는 조회 자체를 건너뛰고(null), 전체 선택이면 파라미터를 보내지 않습니다.
  function buildQuery(def: LayerDef, bbox: string): URLSearchParams | null {
    const params = new URLSearchParams({ bbox });
    if (selectedDongRef.current) params.set('adm_cd', selectedDongRef.current.admCd);
    const selectedValues = filtersRef.current[def.key];
    for (const facet of def.facets) {
      const values = selectedValues[facet.key];
      if (values === undefined) continue;
      if (facet.mode === 'multi') {
        if (values.length === 0) return null;
        if (values.length === (facetsRef.current[def.key]?.[facet.key]?.length ?? -1)) continue;
      }
      for (const value of values) params.append(facet.key, value);
    }
    return params;
  }

  async function refreshLayer(key: LayerKey) {
    const bbox = currentBbox();
    const def = LAYERS.find((l) => l.key === key)!;
    if (!bbox) return;
    abortRef.current[key]?.abort();
    const params = buildQuery(def, bbox);
    if (!params) {
      sourcesRef.current[key].clear(true);
      setCounts((prev) => ({ ...prev, [key]: 0 }));
      return;
    }
    const controller = new AbortController();
    abortRef.current[key] = controller;
    try {
      const res = await fetch(`${layerUrl(def.slug)}?${params}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const features = new GeoJSON().readFeatures(data, { featureProjection: 'EPSG:3857' });
      const source = sourcesRef.current[key];
      source.clear(true);
      source.addFeatures(features);
      setCounts((prev) => ({ ...prev, [key]: features.length }));
      setApiError(null);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setApiError('데이터를 불러오지 못했습니다. API 서버 상태를 확인해 주세요.');
    }
  }

  async function refreshBoundary() {
    const bbox = currentBbox();
    if (!bbox) return;
    boundaryAbortRef.current?.abort();
    const controller = new AbortController();
    boundaryAbortRef.current = controller;
    try {
      const res = await fetch(`${layerUrl(BOUNDARY.slug)}?bbox=${bbox}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const features = new GeoJSON().readFeatures(data, { featureProjection: 'EPSG:3857' });
      boundarySourceRef.current.clear(true);
      boundarySourceRef.current.addFeatures(features);
      setBoundaryCount(features.length);
      setApiError(null);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setApiError('행정동 경계를 불러오지 못했습니다. API 서버 상태를 확인해 주세요.');
    }
  }

  async function refreshSubway() {
    const bbox = currentBbox();
    if (!bbox) return;
    subwayAbortRef.current?.abort();
    const controller = new AbortController();
    subwayAbortRef.current = controller;
    // verified=false는 "미검증까지 전부"라는 뜻입니다(기본값 true가 검증된 것만).
    const lineQuery = `bbox=${bbox}${unverifiedRef.current ? '&verified=false' : ''}`;
    try {
      const responses = await Promise.all([
        fetch(`${layerUrl(SUBWAY.linesSlug)}?${lineQuery}`, { signal: controller.signal }),
        fetch(`${layerUrl(SUBWAY.stationsSlug)}?bbox=${bbox}`, { signal: controller.signal }),
      ]);
      for (const res of responses) if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const [lineData, stationData] = await Promise.all(responses.map((res) => res.json()));
      const format = new GeoJSON();
      const lines = format.readFeatures(lineData, { featureProjection: 'EPSG:3857' });
      const stations = format.readFeatures(stationData, { featureProjection: 'EPSG:3857' });
      subwayLineSourceRef.current.clear(true);
      subwayLineSourceRef.current.addFeatures(lines);
      subwayStationSourceRef.current.clear(true);
      subwayStationSourceRef.current.addFeatures(stations);
      setSubwayCounts({ lines: lines.length, stations: stations.length });
      setSubwayLineInfos(lines.map((feature) => ({
        lineCode: String(feature.get('line_code')),
        lineName: String(feature.get('line_name')),
        branch: String(feature.get('branch') ?? ''),
        stationCount: Number(feature.get('station_count')),
        maxGapM: Number(feature.get('max_gap_m')),
        orderVerified: Boolean(feature.get('order_verified')),
      })));
      setApiError(null);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setApiError('지하철 데이터를 불러오지 못했습니다. API 서버 상태를 확인해 주세요.');
    }
  }

  function refreshVisibleLayers() {
    for (const { key } of LAYERS) if (visibleRef.current[key]) void refreshLayer(key);
    if (boundaryVisibleRef.current) void refreshBoundary();
    if (subwayVisibleRef.current) void refreshSubway();
  }

  useEffect(() => {
    const controller = new AbortController();
    for (const def of LAYERS) {
      fetch(`${layerUrl(def.slug)}/facets`, { signal: controller.signal })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json() as Promise<FacetData>;
        })
        .then((data) => {
          facetsRef.current[def.key] = data;
          setFacets((prev) => ({ ...prev, [def.key]: data }));

          const colors: Record<string, string> = {};
          (data[def.colorBy] ?? []).forEach((option, index) => {
            colors[option.value] = def.palette[index % def.palette.length];
          });
          colorsRef.current[def.key] = colors;
          layersRef.current[def.key]?.changed();

          const initial: Record<string, string[]> = {};
          for (const facet of def.facets) {
            if (facet.mode === 'multi') initial[facet.key] = (data[facet.key] ?? []).map((o) => o.value);
          }
          filtersRef.current[def.key] = { ...filtersRef.current[def.key], ...initial };
          setFilters((prev) => ({ ...prev, [def.key]: { ...prev[def.key], ...initial } }));
        })
        .catch((err) => {
          if ((err as Error).name !== 'AbortError') setApiError('필터 목록을 불러오지 못했습니다. API 서버 상태를 확인해 주세요.');
        });
    }
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const source = new OSM();
    source.on('tileloaderror', () => setTileError(true));

    const vectorLayers = LAYERS.map((def) => {
      const layer = new VectorLayer({
        source: sourcesRef.current[def.key],
        style: (feature) => {
          const attributes = feature.get('attributes') as Record<string, unknown> | undefined;
          const value = attributes?.[def.colorBy];
          const color = (typeof value === 'string' && colorsRef.current[def.key][value]) || def.color;
          return styleFor(def, color);
        },
        properties: { key: def.key },
      });
      layersRef.current[def.key] = layer;
      return layer;
    });

    // 경계는 시설 점보다 아래에 깔아야 점이 가려지지 않습니다.
    const boundaryLayer = new VectorLayer({
      source: boundarySourceRef.current,
      visible: boundaryVisibleRef.current,
      style: (feature, resolution) => {
        if (feature.get('adm_cd') === selectedDongRef.current?.admCd) return boundarySelectedStyle;
        if (resolution > LABEL_MAX_RESOLUTION) return boundaryStyle;
        boundaryLabelStyle.getText()!.setText(String(feature.get('dong_nm') ?? ''));
        return boundaryLabelStyle;
      },
      properties: { key: BOUNDARY.key },
    });
    boundaryLayerRef.current = boundaryLayer;

    const subwayLineLayer = new VectorLayer({
      source: subwayLineSourceRef.current,
      visible: subwayVisibleRef.current,
      style: (feature) => subwayLineStyle(
        String(feature.get('line_name') ?? ''), Boolean(feature.get('order_verified'))),
      properties: { key: SUBWAY.lineKey },
    });
    subwayLineLayerRef.current = subwayLineLayer;

    const subwayStationLayer = new VectorLayer({
      source: subwayStationSourceRef.current,
      visible: subwayVisibleRef.current,
      style: (feature, resolution) => {
        const withLabel = resolution <= STATION_LABEL_MAX_RESOLUTION;
        const style = subwayStationStyle(String(feature.get('line_name') ?? ''), withLabel);
        if (withLabel) style.getText()!.setText(String(feature.get('name') ?? ''));
        return style;
      },
      properties: { key: SUBWAY.stationKey },
    });
    subwayStationLayerRef.current = subwayStationLayer;

    const misreadLayer = new VectorLayer({
      source: misreadSourceRef.current,
      style: (feature) => {
        const role = feature.get('role');
        if (role === 'link') return misreadLinkStyle;
        if (role === 'true') return misreadTrueStyle;
        misreadWrongStyle.getText()!.setText(String(feature.get('label') ?? ''));
        return misreadWrongStyle;
      },
      properties: { key: 'misread' },
    });
    misreadLayerRef.current = misreadLayer;

    const map = new Map({
      target: containerRef.current,
      // 노선은 경계 위·시설 점 아래, 역은 맨 위입니다. 버스정류소가 화면당 수천 개라
      // 역을 그 아래 두면 묻혀서 보이지도 눌리지도 않습니다.
      layers: [new TileLayer({ source }), boundaryLayer, subwayLineLayer, ...vectorLayers, subwayStationLayer, misreadLayer],
      controls: defaultControls({
        attributionOptions: { collapsible: false },
        zoomOptions: { zoomInTipLabel: '확대', zoomOutTipLabel: '축소' },
      }).extend([new ScaleLine()]),
      view: new View({ center: fromLonLat(SEOUL), zoom: INITIAL_ZOOM, minZoom: 2, maxZoom: 19 }),
    });
    mapRef.current = map;
    // 개발 모드 전용: 브라우저 콘솔·E2E 검증에서 지도 상태를 조회하기 위한 핸들.
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__kamogisMap = map;

    map.on('moveend', () => {
      const coordinate = map.getView().getCenter();
      if (coordinate) setCenter(toLonLat(coordinate));
      refreshVisibleLayers();
    });

    // 시설 레이어가 경계보다 위에 있으므로 점을 맞히면 그 자리에서 멈추고, 빈 곳을 눌렀을 때만
    // 아래 깔린 행정동이 잡힙니다. 점을 클릭하는 경우 행정동 선택은 건드리지 않습니다.
    map.on('singleclick', (event) => {
      let found: Selected | null = null;
      const dongs: SelectedDong[] = [];
      map.forEachFeatureAtPixel(
        event.pixel,
        (feature, layer) => {
          const key = layer?.get('key') as string | undefined;
          // 오용 재현 표식은 설명용이라 클릭 대상이 아닙니다.
          if (key === 'misread') return undefined;
          if (key === BOUNDARY.key) {
            if (dongs.length === 0) dongs.push({
              admCd: String(feature.get('adm_cd')),
              admNm: String(feature.get('adm_nm')),
              dongNm: String(feature.get('dong_nm')),
              sggNm: String(feature.get('sgg_nm')),
            });
            return undefined;
          }
          const geometry = feature.getGeometry();
          // 노선은 LineString이라 여기서 걸러집니다. 선을 눌러도 아무것도 선택되지 않습니다.
          if (!key || !(geometry instanceof Point)) return undefined;
          const [lon, lat] = toLonLat(geometry.getCoordinates());
          if (key === SUBWAY.stationKey) {
            found = {
              layer: SUBWAY.stationKey,
              sourceId: String(feature.get('station_code')),
              name: String(feature.get('name')),
              lon,
              lat,
              attributes: {
                노선: String(feature.get('line_name')),
                노선번호: String(feature.get('line_code')),
              },
            };
            return true;
          }
          found = {
            layer: key as LayerKey,
            sourceId: String(feature.get('source_id')),
            name: String(feature.get('name')),
            lon,
            lat,
            attributes: (feature.get('attributes') ?? {}) as Record<string, unknown>,
          };
          return true;
        },
        { hitTolerance: 5 },
      );
      if (found) {
        setSelected(found);
        return;
      }
      setSelected(null);
      // 같은 동을 다시 누르면 해제합니다.
      const dong = dongs[0];
      if (dong) selectDong(dong.admCd === selectedDongRef.current?.admCd ? null : dong);
    });

    map.on('pointermove', (event) => {
      const hit = map.hasFeatureAtPixel(event.pixel, { hitTolerance: 5 });
      map.getTargetElement().style.cursor = hit ? 'pointer' : '';
    });

    const observer = new ResizeObserver(() => map.updateSize());
    observer.observe(containerRef.current);
    refreshVisibleLayers();

    const aborts = abortRef.current;
    return () => {
      observer.disconnect();
      for (const { key } of LAYERS) aborts[key]?.abort();
      boundaryAbortRef.current?.abort();
      subwayAbortRef.current?.abort();
      summaryAbortRef.current?.abort();
      // StrictMode의 재마운트 시 중복 지도·이벤트가 남지 않도록 정리합니다.
      map.dispose();
      source.dispose();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 기준점에서 현재 좌표계로 계산한 숫자를 다른 6종으로 각각 잘못 읽어 본 결과.
  const misreadRows = misreadOrigin
    ? CRS_LIST.filter((info) => info.code !== crs).map((info) => {
        const landed = misreadAs(misreadOrigin[0], misreadOrigin[1], crs, info.code);
        return { info, landed, distance: landed ? getDistance(misreadOrigin, landed) : null };
      })
    : [];

  useEffect(() => {
    const source = misreadSourceRef.current;
    source.clear(true);
    const row = misreadRows.find((r) => r.info.code === misreadTarget);
    if (!misreadOrigin || !row?.landed) return;
    const from = fromLonLat(misreadOrigin);
    const to = fromLonLat(row.landed);
    source.addFeatures([
      new Feature({ geometry: new LineString([from, to]), role: 'link' }),
      new Feature({ geometry: new Point(from), role: 'true' }),
      new Feature({
        geometry: new Point(to),
        role: 'wrong',
        label: `${row.info.code.replace('EPSG:', '')}로 읽으면 · ${formatDistance(row.distance!)}`,
      }),
    ]);
    // 패널이 왼쪽 300px를 가리므로 그만큼 padding을 더 줍니다.
    mapRef.current?.getView().fit([
      Math.min(from[0], to[0]), Math.min(from[1], to[1]),
      Math.max(from[0], to[0]), Math.max(from[1], to[1]),
    ], { padding: [70, 70, 70, 340], maxZoom: 17, duration: 600 });
    // misreadRows는 매 렌더 새로 만들어지므로 의존성에 넣으면 매번 다시 fit합니다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [misreadOrigin, misreadTarget, crs]);

  function toggleMisread() {
    if (misreadOrigin) {
      setMisreadOrigin(null);
      setMisreadTarget(null);
      return;
    }
    setMisreadOrigin(selected ? [selected.lon, selected.lat] : [center[0], center[1]]);
    setMisreadTarget(null);
  }

  function toggleLayer(key: LayerKey) {
    const next = !visibleRef.current[key];
    visibleRef.current[key] = next;
    setVisible((prev) => ({ ...prev, [key]: next }));
    layersRef.current[key]?.setVisible(next);
    if (next) void refreshLayer(key);
    else if (selected?.layer === key) setSelected(null);
  }

  function selectDong(dong: SelectedDong | null) {
    selectedDongRef.current = dong;
    setSelectedDong(dong);
    boundaryLayerRef.current?.changed();
    summaryAbortRef.current?.abort();
    setDongSummary(null);
    if (dong) {
      const controller = new AbortController();
      summaryAbortRef.current = controller;
      fetch(`${layerUrl(BOUNDARY.slug)}/${dong.admCd}/summary`, { signal: controller.signal })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json() as Promise<DongSummary>;
        })
        .then(setDongSummary)
        .catch((err) => {
          if ((err as Error).name !== 'AbortError') setApiError('행정동 요약을 불러오지 못했습니다.');
        });
    }
    // 선택한 동이 화면 밖이면 bbox 조건에 걸려 아무것도 안 보이므로 지도를 그 동에 맞춥니다.
    const extent = dong && boundarySourceRef.current
      .getFeatures().find((f) => f.get('adm_cd') === dong.admCd)?.getGeometry()?.getExtent();
    if (extent) mapRef.current?.getView().fit(extent, { padding: [40, 40, 40, 40], maxZoom: 16, duration: 450 });
    // fit이 끝나면 moveend가 다시 조회하지만, 이동이 없을 때는 moveend가 안 오므로 여기서도 부릅니다.
    refreshVisibleLayers();
  }

  function toggleBoundary() {
    const next = !boundaryVisibleRef.current;
    boundaryVisibleRef.current = next;
    setBoundaryVisible(next);
    boundaryLayerRef.current?.setVisible(next);
    if (next) void refreshBoundary();
    // 경계를 끄면 보이지 않는 필터가 남지 않도록 동 선택도 해제합니다.
    else if (selectedDongRef.current) selectDong(null);
  }

  function toggleSubway() {
    const next = !subwayVisibleRef.current;
    subwayVisibleRef.current = next;
    setSubwayVisible(next);
    subwayLineLayerRef.current?.setVisible(next);
    subwayStationLayerRef.current?.setVisible(next);
    if (next) void refreshSubway();
    else if (selected?.layer === SUBWAY.stationKey) setSelected(null);
  }

  function toggleUnverified() {
    const next = !unverifiedRef.current;
    unverifiedRef.current = next;
    setIncludeUnverified(next);
    if (subwayVisibleRef.current) void refreshSubway();
  }

  function applyFilter(key: LayerKey, facetKey: string, values: string[]) {
    filtersRef.current[key] = { ...filtersRef.current[key], [facetKey]: values };
    setFilters((prev) => ({ ...prev, [key]: { ...prev[key], [facetKey]: values } }));
    if (selected?.layer === key) setSelected(null);
    if (visibleRef.current[key]) void refreshLayer(key);
  }

  function toggleFacetValue(key: LayerKey, facetKey: string, value: string) {
    const current = filtersRef.current[key][facetKey] ?? [];
    applyFilter(key, facetKey, current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value]);
  }

  function resetView() {
    mapRef.current?.getView().animate({ center: fromLonLat(SEOUL), zoom: INITIAL_ZOOM, duration: 450 });
  }

  function retryTiles() {
    const layer = mapRef.current?.getLayers().item(0);
    if (layer instanceof TileLayer) {
      setTileError(false);
      layer.getSource()?.refresh();
    }
  }

  const isSubwayStation = selected?.layer === SUBWAY.stationKey;
  const selectedLabel = selected
    && (isSubwayStation ? '지하철역' : LAYERS.find((l) => l.key === selected.layer)?.label);
  const selectedColor = !selected ? undefined
    : isSubwayStation ? lineColor(String(selected.attributes.노선 ?? ''))
    : LAYERS.find((l) => l.key === selected.layer)?.color;
  const unverifiedShown = subwayLineInfos.filter((line) => !line.orderVerified);
  const crsInfo = getCrs(crs);
  const centerCoord = formatCoordinate(center[0], center[1], crs);
  const selectedCoord = selected && formatCoordinate(selected.lon, selected.lat, crs);

  return (
    <>
      <section className="filters" aria-label="데이터 레이어와 세부 필터">
        {LAYERS.map((def) => (
          <div className="filter-row" key={def.key}>
            <label className="filter-layer">
              <input type="checkbox" checked={visible[def.key]} onChange={() => toggleLayer(def.key)} />
              {def.label}
              <span className="filter-shown">
                {visible[def.key] && counts[def.key] !== null ? `화면 ${counts[def.key]!.toLocaleString()}개` : ''}
              </span>
            </label>
            {def.facets.map((facet) => {
              const options = facets[def.key]?.[facet.key] ?? [];
              const chosen = filters[def.key][facet.key] ?? [];
              if (facet.mode === 'single') {
                return (
                  <label className="facet-single" key={facet.key}>
                    <span>{facet.label}</span>
                    <select
                      value={chosen[0] ?? ''}
                      disabled={!visible[def.key]}
                      onChange={(event) =>
                        applyFilter(def.key, facet.key, event.target.value ? [event.target.value] : [])}
                    >
                      <option value="">전체</option>
                      {options.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.value} ({option.count.toLocaleString()})
                        </option>
                      ))}
                    </select>
                  </label>
                );
              }
              const allChosen = options.length > 0 && chosen.length === options.length;
              return (
                <div className="facet-multi" key={facet.key} role="group" aria-label={facet.label}>
                  <span className="facet-label">{facet.label}</span>
                  {options.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className="chip"
                      disabled={!visible[def.key]}
                      aria-pressed={chosen.includes(option.value)}
                      onClick={() => toggleFacetValue(def.key, facet.key, option.value)}
                    >
                      <span className="layer-dot" style={{ background: colorsRef.current[def.key][option.value] ?? def.color }} aria-hidden="true" />
                      {option.value}
                      <span className="chip-count">{option.count.toLocaleString()}</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    className="facet-all"
                    disabled={!visible[def.key] || options.length === 0}
                    onClick={() => applyFilter(def.key, facet.key, allChosen ? [] : options.map((o) => o.value))}
                  >
                    {allChosen ? '모두 해제' : '모두 선택'}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
        <div className="filter-row">
          <label className="filter-layer">
            <input type="checkbox" checked={subwayVisible} onChange={toggleSubway} />
            {SUBWAY.label}
            <span className="filter-shown">
              {subwayVisible && subwayCounts
                ? `화면 노선 ${subwayCounts.lines.toLocaleString()}개 · 역 ${subwayCounts.stations.toLocaleString()}개`
                : ''}
            </span>
          </label>
          <label className="facet-toggle">
            <input
              type="checkbox"
              checked={includeUnverified}
              disabled={!subwayVisible}
              onChange={toggleUnverified}
            />
            순서 미검증 노선 포함
          </label>
          <span className="facet-note">
            {includeUnverified && unverifiedShown.length > 0
              ? `점선 ${unverifiedShown.map((l) => l.lineName).join('·')}: 역번호가 운행 순서와 달라 형상이 실제와 다릅니다.`
              : '역을 순서대로 이은 모식도입니다. 실제 선로 형상이 아닙니다.'}
          </span>
        </div>
        <div className="filter-row">
          <label className="filter-layer">
            <input type="checkbox" checked={boundaryVisible} onChange={toggleBoundary} />
            {BOUNDARY.label}
            <span className="filter-shown">
              {boundaryVisible && boundaryCount !== null ? `화면 ${boundaryCount.toLocaleString()}개` : ''}
            </span>
          </label>
          {selectedDong ? (
            <>
              <span className="facet-label">선택한 동</span>
              <button type="button" className="chip" aria-pressed="true" onClick={() => selectDong(null)}>
                {selectedDong.sggNm} {selectedDong.dongNm}
                <span className="chip-count" aria-hidden="true">×</span>
              </button>
              <span className="facet-note">이 동 안의 시설만 조회합니다.</span>
            </>
          ) : (
            <span className="facet-note">
              {boundaryVisible ? '경계를 클릭하면 그 동 안의 시설만 조회합니다.' : '확대하면 동 이름이 표시됩니다.'}
            </span>
          )}
        </div>
      </section>
      <section className="map-panel" aria-label="서울 지도 탐색">
        <div ref={containerRef} className="map" tabIndex={0} aria-label="지도. 방향키로 이동하고 더하기와 빼기 키로 확대 및 축소할 수 있습니다." />
        <button className="reset-button" onClick={resetView}>
          <span aria-hidden="true">⌖</span> 서울로 돌아가기
        </button>
        {selected && (
          <aside className="detail-panel" aria-label="선택한 시설 정보">
            <header>
              <span className="layer-dot" style={{ background: selectedColor }} aria-hidden="true" />
              <strong>{selected.name}</strong>
              <button onClick={() => setSelected(null)} aria-label="닫기">×</button>
            </header>
            <dl>
              <dt>종류</dt><dd>{selectedLabel}</dd>
              <dt>ID</dt><dd>{selected.sourceId}</dd>
              <dt>원본 좌표 (4326)</dt><dd>위도 {selected.lat.toFixed(6)}° · 경도 {selected.lon.toFixed(6)}°</dd>
              {crs !== 'EPSG:4326' && selectedCoord && (
                <span className="detail-row">
                  <dt>{crsInfo.code.replace('EPSG:', '')} 좌표</dt>
                  <dd>{crsInfo.axisX} {selectedCoord.x}<br />{crsInfo.axisY} {selectedCoord.y}</dd>
                </span>
              )}
              {Object.entries(selected.attributes).map(([k, v]) => (
                <span key={k} className="detail-row"><dt>{k}</dt><dd>{String(v)}</dd></span>
              ))}
            </dl>
          </aside>
        )}
        {/* 시설 상세가 우선입니다. 점을 닫으면 선택한 동 요약으로 돌아옵니다. */}
        {!selected && selectedDong && (
          <aside className="detail-panel dong-panel" aria-label="선택한 행정동 요약">
            <header>
              <span className="layer-dot dong-dot" aria-hidden="true" />
              <strong>{selectedDong.sggNm} {selectedDong.dongNm}</strong>
              <button onClick={() => selectDong(null)} aria-label="행정동 선택 해제">×</button>
            </header>
            {dongSummary ? (
              <div className="dong-body">
                <p className="dong-meta">
                  면적 {dongSummary.dong.area_km2} km² · 행정표준코드 {dongSummary.dong.adm_cd2}
                </p>
                {LAYERS.map((def) => {
                  const entry = dongSummary.layers[def.slug];
                  if (!entry) return null;
                  return (
                    <section className="dong-layer" key={def.key}>
                      <h3>
                        <span className="layer-dot" style={{ background: def.color }} aria-hidden="true" />
                        {def.label}
                        <b>{entry.total.toLocaleString()}</b>
                      </h3>
                      {entry.total === 0
                        ? <p className="dong-empty">이 동에는 없습니다.</p>
                        : def.facets.map((facet) => (
                            <div className="dong-facet" key={facet.key}>
                              <span className="facet-label">{facet.label}</span>
                              <ul>
                                {(entry.facets[facet.key] ?? []).map((option) => (
                                  <li key={option.value}>
                                    <span
                                      className="layer-dot"
                                      style={{ background: colorsRef.current[def.key][option.value] ?? def.color }}
                                      aria-hidden="true"
                                    />
                                    {option.value}
                                    <b>{option.count.toLocaleString()}</b>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ))}
                    </section>
                  );
                })}
                {/* 역은 개수보다 어느 역·어느 노선인지가 쓸모 있어 목록으로 보여줍니다. */}
                <section className="dong-layer">
                  <h3>
                    <span className="layer-dot station-dot" aria-hidden="true" />
                    지하철역
                    <b>{dongSummary.subway.total.toLocaleString()}</b>
                  </h3>
                  {dongSummary.subway.total === 0 ? (
                    <p className="dong-empty">이 동에는 없습니다.</p>
                  ) : (
                    <ul className="dong-stations">
                      {dongSummary.subway.stations.map((station) => (
                        <li key={station.name}>
                          <span className="station-name">{station.name}</span>
                          <span className="station-lines">
                            {station.lines.map((line) => (
                              <span key={line} className="line-chip" style={{ background: lineColor(line) }}>
                                {line}
                              </span>
                            ))}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                <p className="dong-note">동 전체 기준입니다. 지도에 그려진 개수는 화면 범위와 속성 필터에 따라 더 적을 수 있습니다.</p>
              </div>
            ) : (
              <p className="dong-body dong-empty">불러오는 중…</p>
            )}
          </aside>
        )}
        <aside className="crs-panel" aria-label="좌표계 선택과 설명">
          <label className="crs-select">
            <span>좌표계</span>
            <select value={crs} onChange={(event) => setCrs(event.target.value as CrsCode)}>
              {CRS_LIST.map((info) => (
                <option key={info.code} value={info.code}>{info.label}</option>
              ))}
            </select>
          </label>
          <div className="crs-readout">
            <span>지도 중심</span>
            <strong>{crsInfo.axisX}<b>{centerCoord.x}</b></strong>
            <strong>{crsInfo.axisY}<b>{centerCoord.y}</b></strong>
            <em>단위 {crsInfo.unit} · 기준 {crsInfo.datum}</em>
          </div>
          <div className="crs-misread">
            <label className="facet-toggle">
              <input type="checkbox" checked={misreadOrigin !== null} onChange={toggleMisread} />
              좌표계를 잘못 지정하면
            </label>
            {misreadOrigin && (
              <>
                <p className="crs-misread-lead">
                  기준점을 {crsInfo.code.replace('EPSG:', '')}로 계산한 숫자를 다른 좌표계라고
                  알려줬을 때 실제로 찍히는 곳입니다. 눌러서 지도에서 확인하세요.
                </p>
                <ul>
                  {misreadRows.map(({ info, landed, distance }) => (
                    <li key={info.code}>
                      <button
                        type="button"
                        className="chip"
                        disabled={!landed}
                        aria-pressed={misreadTarget === info.code}
                        onClick={() => setMisreadTarget(info.code)}
                      >
                        {info.code.replace('EPSG:', '')}
                        <span className="chip-count">
                          {landed ? formatDistance(distance!) : '무효'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="crs-misread-note">
                  '무효'는 투영 미터를 경위도로 읽어 위도가 90°를 넘은 경우입니다. 한국에서는 이
                  실수가 값 자체로 드러나지만, 위도·경도가 모두 90 이하인 지역에서는 조용히 통과합니다.
                  거리는 브라우저의 구면 근사값이라 PostGIS 타원체 계산과 조금 다릅니다(5174를 5181로 읽는 경우 313.5 m 대 313.02 m).
                </p>
              </>
            )}
          </div>
          <dl className="crs-info">
            <dt>{crsInfo.name}</dt>
            <dd>{crsInfo.summary}</dd>
            <dt>이럴 때 쓴다</dt>
            <dd>{crsInfo.useWhen}</dd>
            <dt>주의할 점</dt>
            <dd className="crs-caution">{crsInfo.caution}</dd>
          </dl>
        </aside>
        {tileError && (
          <div className="map-error" role="alert">
            배경지도 일부를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.
            <button onClick={retryTiles}>다시 시도</button>
          </div>
        )}
        {apiError && (
          <div className="map-error" role="alert">
            {apiError}
            <button onClick={refreshVisibleLayers}>다시 시도</button>
          </div>
        )}
      </section>
    </>
  );
}
