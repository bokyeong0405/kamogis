# KAMOGIS 지도 프론트엔드

React + TypeScript + Vite + OpenLayers로 만든 지도 화면입니다.
OpenStreetMap 배경 위에 버스정류소·따릉이 대여소·행정동 경계·도시철도 역과 노선을 그립니다.
데이터는 백엔드 조회 API(127.0.0.1:58080)에서 받아오며, Vite dev 서버가 `/api`를 그쪽으로 프록시합니다.

기능은 레이어 토글, 지도 이동(`moveend`) 시 bbox 재조회, 속성 필터 칩, 행정동 클릭 필터와 요약 패널,
좌표계 7종 전환과 오용 재현입니다. 백엔드를 띄우지 않으면 배경지도만 보입니다.

## 실행

Node.js 22.12 이상을 권장합니다.

```sh
cd frontend
npm ci
npm run dev
```

터미널에 표시된 주소(기본 http://127.0.0.1:5173)를 엽니다.
API 키는 필요 없으며 배경지도 로딩에는 인터넷 연결이 필요합니다.

```sh
npm run build    # TypeScript 검사 및 프로덕션 빌드
npm run preview  # 빌드 결과 확인
```

## 코드 읽는 순서

- `src/main.tsx`: React 진입점과 OpenLayers CSS 로딩.
- `src/App.tsx`: 페이지 구성.
- `src/components/MapView.tsx`: 지도 생성, 배경 타일, 레이어와 스타일, bbox 재조회, 필터와 패널.
- `src/crs.ts`: 좌표계 7종 정의와 변환, 오용 재현(`misreadAs()`).
- `src/styles.css`: 지도 컨테이너 크기와 반응형 스타일.

OpenLayers의 `Map`은 지도를 담는 객체, `View`는 중심과 확대 수준,
`TileLayer`는 배경 레이어, `OSM`은 배경 타일 공급원입니다.
`useEffect`에서 지도를 만들고 언마운트 시 `dispose()`로 정리합니다.
지도를 담는 DOM에는 반드시 높이가 있어야 합니다.

API와 GeoJSON은 `[경도, 위도]`인 EPSG:4326 좌표를 사용하고,
지도 화면은 EPSG:3857을 사용합니다. 초기 중심은 `fromLonLat()`로 변환합니다.
`moveend`에서 화면 영역을 EPSG:4326으로 되돌려
`GET /api/layers/bus-stops?bbox=minLon,minLat,maxLon,maxLat` 형태로 조회하고
응답 GeoJSON을 레이어별 벡터 소스에 싣습니다.

레이어 순서는 **행정동 경계 → 노선 → 시설 점 → 역**입니다.
버스정류소가 화면당 수천 개라 역을 그 아래 두면 묻혀서 보이지도 눌리지도 않습니다.
같은 이유로 경계를 맨 아래 깔아, 빈 곳을 눌렀을 때만 행정동이 잡히게 했습니다.
미검증 노선(`order_verified=false`)은 `lineDash`로 점선 처리해 실선과 같은 무게로 보이지 않게 합니다.
근거는 [도시철도 노선 문서](../docs/research/2026-09-26-subway-lines.md)에 있습니다.

## 배경지도 출처

지도에 OpenStreetMap 저작자 표시를 항상 노출합니다.
공개 타일 서버는 소규모 학습용으로 사용하며, 대량 다운로드·오프라인 저장·사전 수집은 구현하지 않습니다.
공개 서비스로 확장할 때는 트래픽에 맞는 타일 제공자를 선택하세요.

- https://openlayers.org/doc/quickstart.html
- https://operations.osmfoundation.org/policies/tiles/
