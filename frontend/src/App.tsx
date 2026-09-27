import MapView from './components/MapView';

export default function App() {
  return (
    <main className="app">
      <header className="header">
        <a className="brand" href="/" aria-label="KAMOGIS 홈">
          <span className="brand-icon" aria-hidden="true">K</span>
          KAMOGIS
        </a>
        <span className="header-label">서울 공공데이터 지도</span>
        <span className="badge">MAP EXPLORER</span>
      </header>
      <section className="intro">
        <div>
          <p className="eyebrow">SEOUL, SOUTH KOREA</p>
          <h1>서울을 지도 위에서 만나보세요.</h1>
          <p className="description">지도를 움직이면 현재 화면 영역의 버스정류소·따릉이 대여소·지하철을 다시 조회합니다. 정류소 유형·거치대 방식·자치구로 걸러 볼 수 있고, 행정동 경계를 켜고 동을 클릭하면 그 동 안의 시설만 남습니다. 지하철 노선은 역 좌표를 역번호 순서로 이은 모식도라 실제 선로 형상이 아니며, 역번호 순서가 운행 순서와 어긋나는 노선은 점선으로 구분합니다. 지점을 클릭하면 상세 정보를, 좌표계를 바꾸면 같은 위치가 7가지 좌표계로 어떻게 표현되는지 비교할 수 있고, 좌표계를 잘못 지정했을 때 그 점이 실제로 어디에 찍히는지도 지도 위에서 확인할 수 있습니다.</p>
        </div>
        <div className="map-label"><span aria-hidden="true" /> OpenStreetMap 배경지도</div>
      </section>
      <MapView />
      <footer className="footer">
        <span>PostgreSQL + PostGIS · 종류별 분리 테이블 · bbox + 속성 필터 조회 API</span>
        <span>출처: 서울열린데이터광장 버스정류소 위치정보(2026-09-02), 따릉이 대여소 정보(2026-06) · 행정동 경계 vuski/admdongkor ver20260701(CC BY 4.0, 원자료 통계청 SGIS 공공누리 제1유형) · 지하철 국가철도공단 전국도시철도역사정보표준데이터(2026-06-30, 이용허락범위 제한 없음)</span>
      </footer>
    </main>
  );
}
