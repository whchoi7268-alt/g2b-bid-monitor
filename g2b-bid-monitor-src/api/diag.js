/**
 * 진단 엔드포인트
 *  - GET /api/diag?kw=세탁&type=thng&days=15&mode=search  → 단일 오퍼레이션 상세 진단
 *  - GET /api/diag?kw=세탁&type=all&days=15               → 전 오퍼레이션 전수 탐색
 *
 * 전수 탐색은 조달청이 제공하는(또는 제공할 가능성이 있는) 입찰공고 오퍼레이션을
 * 하나씩 호출해 ① 실제로 존재·승인되었는지 ② 해당 키워드 공고가 몇 건 있는지를 표로 돌려줍니다.
 * '내자' 공고가 어느 오퍼레이션에 들어 있는지 확정하는 용도입니다.
 */
import {
  BID_BASE,
  BID_BASES,
  ENDPOINTS,
  SEARCH_ENDPOINTS,
  LABELS,
  displayKst,
  fmtKst,
  nowKst,
  parseKst,
  requireAuth,
  resolveKeyLiteral,
  toNum,
} from './_lib.js';

const MAX_PAGES = 5;
const ROWS = 999;
const BUDGET_MS = 40000;
const PROBE_BUDGET_MS = 50000;   // 함수 제한 60초 안쪽 전체 예산
const PROBE_TARGET_MS = 22000;   // 오퍼레이션 1개가 독점할 수 있는 최대 시간
const PROBE_PAGES = 2;           // 목록 오퍼레이션이 훑는 페이지 수 (1페이지 999건)
const PROBE_CONCURRENCY = 5;     // 동시 실행 수 — 직렬 실행 시 앞줄이 예산을 다 써 '건너뜀'이 발생

// 전수 탐색 대상. '탐색' 표시는 존재 여부가 미확인인 후보입니다.
// 전수 탐색 대상: (오퍼레이션 × 기준일구분 inqryDiv) 조합.
// 검색어는 서버로 보내지 않고 받아온 원문에서 직접 찾습니다 (한글 파라미터 문제 배제).
// (base × 오퍼레이션 × 기준일) 전수 탐색.
const PROBE_TARGETS = [
  // 실측(2026-08-18)으로 유효 조합이 확정되어 죽은 조합을 제거했습니다.
  //  · '기본' 경로(/1230000/BidPublicInfoService) → NO_OPENAPI_SERVICE_ERROR (미존재)
  //  · inqryDiv=2 → [08] 필수값 입력 에러 (기간조회에 사용 불가)
  { b: 0, op: 'getBidPblancListInfoThng', label: '물품 · 목록', div: '1', note: '내자 포함' },
  { b: 0, op: 'getBidPblancListInfoThngPPSSrch', label: '물품 · 검색', div: '1', note: '검색어 서버전달', sendKw: true },
  { b: 0, op: 'getBidPblancListInfoServc', label: '용역 · 목록', div: '1', note: '' },
  { b: 0, op: 'getBidPblancListInfoServcPPSSrch', label: '용역 · 검색', div: '1', note: '검색어 서버전달', sendKw: true },
  { b: 0, op: 'getBidPblancListInfoCnstwk', label: '공사 · 목록', div: '1', note: '' },
  { b: 0, op: 'getBidPblancListInfoCnstwkPPSSrch', label: '공사 · 검색', div: '1', note: '검색어 서버전달', sendKw: true },
  { b: 0, op: 'getBidPblancListInfoFrgcpt', label: '외자 · 목록', div: '1', note: '' },
  { b: 0, op: 'getBidPblancListInfoEtc', label: '기타 · 목록', div: '1', note: '탐색' },
  { b: 0, op: 'getBidPblancListInfoLease', label: '리스 · 목록', div: '1', note: '탐색' },
];

const norm = (s) => String(s == null ? '' : s).replace(/\s/g, '');

// serviceKey 는 URLSearchParams 로 넣으면 재인코딩되어 깨지므로 검증된 표기법을 직접 이어붙입니다.
function makeUrl(keyLit, op, begin, end, page, keyword, rows, div, baseIdx) {
  const base = BID_BASES[Number(baseIdx) || 0] || BID_BASES[0];
  const p = new URLSearchParams();
  p.set('type', 'json');
  p.set('inqryDiv', String(div || '1'));
  p.set('inqryBgnDt', fmtKst(begin));
  p.set('inqryEndDt', fmtKst(end));
  p.set('numOfRows', String(rows || ROWS));
  p.set('pageNo', String(page));
  if (keyword) p.set('bidNtceNm', keyword);
  return `${base}/${op}?serviceKey=${keyLit}&${p.toString()}`;
}

function mask(url, key) {
  let s = String(url);
  const k = String(key || '').trim();
  if (k) s = s.split(encodeURIComponent(k)).join('***SERVICE_KEY***').split(k).join('***SERVICE_KEY***');
  return s;
}

/** 한 번 호출해서 items / totalCount 또는 오류 정보를 돌려줌 */
async function callOnce(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'g2b-bid-monitor/1.0', Accept: 'application/json' },
  });
  const text = await res.text();

  if (text.trim().charAt(0) === '<') {
    const m = text.match(/<returnAuthMsg>([^<]*)<\/returnAuthMsg>/);
    return { fail: 'XML', httpStatus: res.status, msg: m ? m[1] : text.slice(0, 160) };
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { fail: 'PARSE', httpStatus: res.status, msg: text.slice(0, 160) };
  }
  if (json['nkoneps.com.response.ResponseError']) {
    const h = json['nkoneps.com.response.ResponseError'].header || {};
    return { fail: 'ERROR', httpStatus: res.status, code: h.resultCode, msg: h.resultMsg };
  }
  if (!json || typeof json.response !== 'object' || json.response === null) {
    // 인증키 오류 등이 JSON 으로 오는 경우 — 0건으로 삼키지 않고 오류로 보고합니다.
    const c = json && (json.resultCode ?? json.returnReasonCode ?? json.errCode ?? json.code);
    const m = json && (json.resultMsg ?? json.returnAuthMsg ?? json.errMsg ?? json.message);
    return {
      fail: 'ERROR',
      httpStatus: res.status,
      code: c == null ? '-' : String(c),
      msg: m == null ? text.slice(0, 200) : String(m),
    };
  }
  const header = (json && json.response && json.response.header) || {};
  const code = String(header.resultCode == null ? '' : header.resultCode);
  if (code && code !== '00' && code !== '0') {
    return { fail: 'CODE', httpStatus: res.status, code, msg: header.resultMsg || '' };
  }
  const body = (json && json.response && json.response.body) || {};
  let items = body.items || [];
  if (!Array.isArray(items)) items = items.item ? [].concat(items.item) : [];
  return {
    httpStatus: res.status,
    code: code || '00',
    msg: header.resultMsg || '',
    items,
    totalCount: toNum(body.totalCount),
  };
}

/** 전 오퍼레이션 전수 탐색 */
async function probeAll(key, kw, begin, end, now) {
  const needle = norm(kw);
  const started = Date.now();
  const out = new Array(PROBE_TARGETS.length);
  const sample = [];
  const seenNo = {};

  async function probeOne(t) {
    const tStart = Date.now();
    let r = null;
    let scanned = [];
    let failed = null;
    const maxPages = t.sendKw ? 1 : PROBE_PAGES;

    for (let page = 1; page <= maxPages; page++) {
      let one;
      try {
        one = await callOnce(makeUrl(key, t.op, begin, end, page, t.sendKw ? kw : '', ROWS, t.div, t.b));
      } catch (e) {
        failed = { fail: 'NET', msg: String((e && e.message) || e) };
        break;
      }
      if (one.fail) {
        if (page === 1) failed = one;
        break;
      }
      r = one;
      scanned = scanned.concat(one.items);
      if (!one.items.length || scanned.length >= one.totalCount) break;
      // 이 오퍼레이션이 예산을 독점하지 못하도록 개별 상한을 둔다
      if (Date.now() - tStart > PROBE_TARGET_MS || Date.now() - started > PROBE_BUDGET_MS) break;
    }

    if (failed || !r) {
      const f = failed || { msg: '응답 없음' };
      return { ...t, status: f.fail === 'XML' ? '미제공/미승인' : '오류', detail: `${f.code ? '[' + f.code + '] ' : ''}${String(f.msg || '').slice(0, 120)}` };
    }

    let hit = 0;
    let hitAlive = 0;
    for (const it of scanned) {
      if (needle) {
        const hay = norm(it.bidNtceNm) + norm(it.dtilPrdctClsfcNoNm) + norm(it.bidNtceNo);
        if (hay.indexOf(needle) === -1) continue;
      }
      hit++;
      const dt = parseKst(it.bidClseDt);
      if (dt && dt > now) {
        hitAlive++;
        const key2 = String(it.bidNtceNo || '') + '|' + t.op;
        if (sample.length < 30 && !seenNo[key2]) {
          seenNo[key2] = 1;
          sample.push({
            op: t.op,
            opLabel: t.label,
            bidNtceNm: String(it.bidNtceNm || ''),
            bidNtceNo: String(it.bidNtceNo || ''),
            dminsttNm: String(it.dminsttNm || ''),
            ntceInsttNm: String(it.ntceInsttNm || ''),
            bidClseDt: String(it.bidClseDt || ''),
          });
        }
      }
    }

    return {
      ...t,
      baseLabel: 'ad',
      status: '정상',
      totalCount: r.totalCount,
      scanned: scanned.length,
      hit,
      hitAlive,
      elapsedMs: Date.now() - tStart,
      detail: r.totalCount > scanned.length
        ? '상위 ' + scanned.length.toLocaleString() + '건만 검사 (전체 ' + r.totalCount.toLocaleString() + '건)'
        : '전량 검사',
    };
  }

  // 직렬로 돌리면 앞 오퍼레이션이 전체 예산을 소진해 나머지가 모두 '건너뜀'이 된다.
  // → 동시 실행으로 바꿔 전체 소요시간을 '가장 느린 1개' 수준으로 낮춘다.
  let idx = 0;
  async function worker() {
    while (idx < PROBE_TARGETS.length) {
      const my = idx++;
      const t = PROBE_TARGETS[my];
      if (Date.now() - started > PROBE_BUDGET_MS) {
        out[my] = { ...t, status: '건너뜀', detail: '전체 시간 예산(' + Math.round(PROBE_BUDGET_MS / 1000) + '초) 초과 — 조회기간을 줄이면 해소됩니다' };
        continue;
      }
      try {
        out[my] = await probeOne(t);
      } catch (e) {
        out[my] = { ...t, status: '오류', detail: String((e && e.message) || e).slice(0, 120) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, PROBE_TARGETS.length) }, worker));

  return { rows: out.filter(Boolean), sample };
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;

  const q = req.query || {};
  const rawType = String(q.type || 'thng');
  const isAll = rawType === 'all';
  const type = ENDPOINTS[rawType] ? rawType : 'thng';
  const days = Math.min(Math.max(parseInt(q.days, 10) || 15, 1), 60);
  const kw = String(q.kw || '').trim();
  const useSearch = String(q.mode || 'search') === 'search' && !!kw;
  const opName = useSearch ? SEARCH_ENDPOINTS[type] : ENDPOINTS[type];
  const key = process.env.G2B_SERVICE_KEY;
  const now = nowKst();

  if (!key) {
    return res
      .status(200)
      .json({ ok: false, stage: 'CONFIG', message: '환경변수 G2B_SERVICE_KEY 가 설정되지 않았습니다.' });
  }

  const begin = new Date(now.getTime() - days * 86400000);
  const keyLit = await resolveKeyLiteral(key);

  // ══ 전수 탐색 모드 ══
  if (isAll) {
    let probe;
    try {
      probe = await probeAll(keyLit, kw, begin, now, now);
    } catch (err) {
      return res.status(200).json({
        ok: false,
        stage: 'NETWORK',
        message: String((err && err.message) || err).slice(0, 400),
      });
    }
    const working = probe.rows.filter((r) => r.status === '정상');
    const withHits = working.filter((r) => (r.hitAlive || 0) > 0);
    return res.status(200).json({
      ok: true,
      stage: 'PROBE',
      mode: 'probe',
      serverTime: displayKst(now),
      query: { keyword: kw, days, from: displayKst(begin), to: displayKst(now) },
      summary: {
        totalOps: probe.rows.length,
        workingOps: working.length,
        opsWithAliveHits: withHits.length,
      },
      operations: probe.rows,
      sample: probe.sample,
    });
  }

  // ══ 단일 오퍼레이션 상세 모드 ══
  const started = Date.now();
  const all = [];
  let totalCount = 0;
  let pages = 0;
  let header = { resultCode: '', resultMsg: '' };
  let httpStatus = 0;
  const divParam = String(q.div || '1');
  const baseIdx = Number(q.base) || 0;
  const maskedUrl = mask(makeUrl(keyLit, opName, begin, now, 1, useSearch ? kw : '', ROWS, divParam, baseIdx), key);

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await callOnce(makeUrl(keyLit, opName, begin, now, page, useSearch ? kw : '', ROWS, divParam, baseIdx));
      httpStatus = r.httpStatus;
      if (r.fail) {
        return res.status(200).json({
          ok: false,
          stage: r.fail === 'XML' ? 'UPSTREAM_XML' : r.fail === 'PARSE' ? 'PARSE_FAIL' : 'UPSTREAM_ERROR',
          message:
            r.fail === 'XML'
              ? `조달청이 JSON 대신 XML(오류)을 반환했습니다. 해당 오퍼레이션이 활용신청에 포함되지 않았을 수 있습니다. — ${r.msg}`
              : `${r.code ? '[' + r.code + '] ' : ''}${r.msg}`,
          requestUrl: maskedUrl,
          httpStatus,
          rawSnippet: String(r.msg || '').slice(0, 800),
        });
      }
      header = { resultCode: r.code, resultMsg: r.msg };
      totalCount = r.totalCount;
      all.push(...r.items);
      pages = page;
      if (!r.items.length || all.length >= r.totalCount) break;
      if (Date.now() - started > BUDGET_MS) break;
    }
  } catch (err) {
    return res.status(200).json({
      ok: false,
      stage: 'NETWORK',
      message: String((err && err.message) || err).slice(0, 400),
      requestUrl: maskedUrl,
    });
  }

  const fieldNames = all.length ? Object.keys(all[0]).sort() : [];
  const hasCloseField = fieldNames.indexOf('bidClseDt') !== -1;

  let parsed = 0;
  let unparsed = 0;
  let alive = 0;
  let expired = 0;
  const unparsedSamples = [];

  all.forEach((it) => {
    const dt = parseKst(it.bidClseDt);
    if (!dt) {
      unparsed++;
      if (unparsedSamples.length < 5) {
        unparsedSamples.push({
          bidNtceNo: it.bidNtceNo,
          bidNtceNm: it.bidNtceNm,
          bidClseDt: it.bidClseDt === undefined ? '(필드없음)' : String(it.bidClseDt),
        });
      }
      return;
    }
    parsed++;
    if (dt > now) alive++;
    else expired++;
  });

  const needle = norm(kw);
  const hits = [];
  let hitCount = 0;
  let hitAlive = 0;

  if (needle) {
    all.forEach((it) => {
      const hay = norm(it.bidNtceNm) + norm(it.dtilPrdctClsfcNoNm) + norm(it.bidNtceNo);
      if (hay.indexOf(needle) === -1) return;
      hitCount++;
      const dt = parseKst(it.bidClseDt);
      const isAlive = !!dt && dt > now;
      if (isAlive) hitAlive++;
      if (hits.length < 40) {
        hits.push({
          bidNtceNm: String(it.bidNtceNm || ''),
          bidNtceNo: String(it.bidNtceNo || ''),
          dminsttNm: String(it.dminsttNm || ''),
          bidClseDt: String(it.bidClseDt || ''),
          dtilPrdctClsfcNoNm: String(it.dtilPrdctClsfcNoNm || ''),
          status: !dt
            ? '마감일시 없음/해석불가'
            : isAlive
              ? '마감 미도래 (앱에 나와야 함)'
              : '마감 경과 (정상 제외)',
        });
      }
    });
  }

  return res.status(200).json({
    ok: true,
    stage: 'OK',
    mode: 'single',
    serverTime: displayKst(now),
    query: {
      type,
      typeLabel: LABELS[type],
      operation: opName,
      modeLabel: (useSearch ? '나라장터 검색(PPSSrch)' : '기간 목록(List)') + ' · 기준일 inqryDiv=' + divParam,
      days,
      keyword: kw,
      from: displayKst(begin),
      to: displayKst(now),
    },
    requestUrl: maskedUrl,
    httpStatus,
    resultCode: String(header.resultCode || ''),
    resultMsg: String(header.resultMsg || ''),
    totalCount,
    pagesFetched: pages,
    itemsScanned: all.length,
    truncated: all.length < totalCount,
    fieldCheck: { hasCloseField, fieldNames },
    closeDtStats: { parsed, unparsed, alive, expired, unparsedSamples },
    keywordResult: { keyword: kw, hitCount, hitAlive, hits },
    firstItem: all.length ? all[0] : null,
  });
}
