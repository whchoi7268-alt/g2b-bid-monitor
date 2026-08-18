/**
 * 입찰공고 수집 (한 업무구분 × 한 기간구간)
 * 클라이언트가 구간을 나눠 여러 번 호출합니다 — 서버리스 실행시간 초과를 막기 위함.
 *
 * POST /api/bids
 *   { type, beginMs, endMs, items:[{name,keywords,exclude,prefixes}], imminentHours }
 * →  { matched:[...], rawCount, expired, noClose, truncated, demo }
 */
import { fetchKaptChunk, classifyLaundry, kaptKeySource } from './_kapt.js';
import {
  demoRows,
  fetchChunk,
  filterAndEnrich,
  normalize,
  nowKst,
  readJsonBody,
  requireAuth,
  ENDPOINTS,
  matchItems,
  parseKst,
} from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  if (!requireAuth(req, res)) return;

  const body = readJsonBody(req);
  const source = String(body.source || 'g2b');
  const type = String(body.type || 'thng');
  const keyword = String(body.keyword || '').trim();
  const inqryDiv = String(body.inqryDiv || '1');
  const baseIdx = Number(body.baseIdx) || 0;
  const items = Array.isArray(body.items) ? body.items : [];
  const imminentHours = Number(body.imminentHours) || 48;
  const now = nowKst();

  // ── K-apt(공동주택) 분기 ──────────────────────────────────────────
  if (source === 'kapt') {
    if (!kaptKeySource()) {
      return res.status(200).json({ source: 'kapt', matched: [], rawCount: 0, expired: 0, noClose: 0, demo: true });
    }
    const begin = new Date(Number(body.beginMs));
    const end = new Date(Number(body.endMs));
    if (isNaN(begin.getTime()) || isNaN(end.getTime()) || begin >= end) {
      return res.status(400).json({ error: 'BAD_RANGE', message: '조회 기간이 올바르지 않습니다.' });
    }
    try {
      const { rows, totalCount, truncated, path, dateParam } = await fetchKaptChunk(null, begin, end);

      // 마감 미도래 + 세탁 판정
      const useLaundry = String(body.kaptRule || 'laundry') === 'laundry';
      const excl = [];
      for (const sp of items) for (const x of sp.exclude || []) if (x) excl.push(x.replace(/\s/g, ''));

      const out = [];
      let expired = 0;
      let noClose = 0;
      for (const rec of rows) {
        const close = parseKst(rec.closeDt);
        if (!close) { noClose++; continue; }
        if (close <= now) { expired++; continue; }

        let label = null;
        if (useLaundry) {
          const v = classifyLaundry(rec);
          if (!v.match) continue;
          label = v.category;
        } else {
          const hits = matchItems(rec, items);
          if (!hits.length) continue;
          label = hits.join(', ');
        }
        // 사용자 제외어는 어느 규칙에서든 최종 적용
        const hay = `${rec.title} ${rec.clsfcNm}`.replace(/\s/g, '');
        if (excl.some((x) => hay.includes(x))) continue;

        const hoursLeft = (close - now) / 3600000;
        const days = Math.max(0, Math.ceil(hoursLeft / 24));
        out.push({
          ...rec,
          items: [label],
          itemLabel: label,
          hoursLeft: Math.round(hoursLeft * 10) / 10,
          daysLeft: days,
          dday: days === 0 ? 'D-DAY(오늘)' : `D-${days}`,
          imminent: hoursLeft <= imminentHours,
        });
      }
      out.sort((a, b) => a.hoursLeft - b.hoursLeft);

      return res.status(200).json({
        source: 'kapt',
        matched: out,
        rawCount: rows.length,
        totalCount,
        expired,
        noClose,
        truncated,
        endpoint: path,
        dateParam,
        operation: 'K-apt 공동주택 입찰공고',
        keySource: kaptKeySource(),
        demo: false,
      });
    } catch (err) {
      return res.status(502).json({
        source: 'kapt',
        error: 'KAPT_FAILED',
        message: String((err && err.message) || err).slice(0, 400),
      });
    }
  }

  if (!ENDPOINTS[type]) {
    return res.status(400).json({ error: 'BAD_TYPE', message: `알 수 없는 업무구분: ${type}` });
  }

  const key = process.env.G2B_SERVICE_KEY;

  // ── 데모 모드: 서비스키 미설정 시 모의 데이터로 동작 확인 ──
  if (!key) {
    if (type !== 'thng') {
      return res.status(200).json({ matched: [], rawCount: 0, expired: 0, noClose: 0, demo: true });
    }
    const raw = demoRows(now).map((r) => normalize(r, 'thng'));
    const { matched, expired, noClose } = filterAndEnrich(raw, items, now, imminentHours);
    return res.status(200).json({
      matched,
      rawCount: raw.length,
      expired,
      noClose,
      truncated: false,
      demo: true,
    });
  }

  const begin = new Date(Number(body.beginMs));
  const end = new Date(Number(body.endMs));
  if (isNaN(begin.getTime()) || isNaN(end.getTime()) || begin >= end) {
    return res.status(400).json({ error: 'BAD_RANGE', message: '조회 기간이 올바르지 않습니다.' });
  }

  try {
    const { rows, totalCount, truncated } = await fetchChunk(key, type, begin, end, keyword, inqryDiv, baseIdx);
    const normalized = rows.map((r) => normalize(r, type));
    const { matched, expired, noClose } = filterAndEnrich(normalized, items, now, imminentHours);

    return res.status(200).json({
      matched,
      rawCount: normalized.length,
      totalCount,
      expired,
      noClose,
      truncated,
      keyword,
      inqryDiv,
      baseIdx,
      source: 'g2b',
      operation: keyword ? 'PPSSrch(나라장터 검색)' : 'List(기간 목록)',
      demo: false,
    });
  } catch (err) {
    return res.status(502).json({
      error: 'UPSTREAM_FAILED',
      message: String(err?.message || err).slice(0, 300),
    });
  }
}
