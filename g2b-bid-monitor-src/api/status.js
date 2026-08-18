/** 설정 상태 확인 — 비밀 값은 절대 반환하지 않습니다. */
import { authToken, displayKst, nowKst, selfTestKey } from './_lib.js';
import { probeEndpoint, probeDateShape, currentPath, kaptKeySource } from './_kapt.js';

export default async function handler(req, res) {
  const expected = authToken();
  const cookie = req.headers.cookie || '';
  const authed = !!expected && cookie.includes(`g2b_auth=${expected}`);

  const out = {
    passwordConfigured: !!expected,
    serviceKeyConfigured: !!process.env.G2B_SERVICE_KEY,
    demoMode: !process.env.G2B_SERVICE_KEY,
    mcpEnabled: !!process.env.MCP_TOKEN,
    kaptEndpoint: process.env.KAPT_ENDPOINT || null,
    kaptKeySource: kaptKeySource(),
    authed,
    serverTime: displayKst(nowKst()),
  };

  // ?selftest=1 — 인증키가 조달청에서 실제로 통하는지 1회 호출로 검증.
  // 반환값에 인증키 자체는 포함되지 않습니다(길이·성공 형태·응답코드만).
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.get('selftest') === '1' && process.env.G2B_SERVICE_KEY) {
    try {
      out.keyTest = await selfTestKey(process.env.G2B_SERVICE_KEY);
    } catch (e) {
      out.keyTest = { working: null, verdict: String(e.message || e), results: [] };
    }
  }

  // ?kaptprobe=1 — K-apt 입찰공고 API의 실제 엔드포인트·날짜파라미터를 탐지한다.
  // 공공데이터포털은 상황별 오류 문구가 달라, 이를 근거로 정답을 좁힐 수 있다.
  if (url.searchParams.get('kaptprobe') === '1' && kaptKeySource()) {
    try {
      const ep = await probeEndpoint(null, 35000);
      const probe = { keySource: kaptKeySource(), envOverride: process.env.KAPT_ENDPOINT || null, detected: ep.path, bestKind: ep.bestKind, candidates: ep.rows };
      if (ep.path) {
        const now = nowKst();
        const begin = new Date(now.getTime() - 14 * 86400000);
        const ds = await probeDateShape(null, ep.path, begin, now, 18000);
        probe.dateShape = ds.shape ? ds.shape.begin + (ds.shape.end ? '/' + ds.shape.end : '') : null;
        probe.dateTotalCount = ds.totalCount ?? null;
        probe.dateCandidates = ds.rows;
      }
      probe.willUse = currentPath();
      out.kaptProbe = probe;
    } catch (e) {
      out.kaptProbe = { error: String((e && e.message) || e).slice(0, 300) };
    }
  }

  res.status(200).json(out);
}
