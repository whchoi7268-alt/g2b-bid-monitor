/**
 * K-apt(공동주택관리정보시스템) 입찰공고 어댑터
 *
 * 기관코드 1611000 (국토교통부 공동주택 계열).
 * 입찰공고 서비스의 정확한 서비스명/오퍼레이션명은 공공데이터포털 활용신청 화면에서만
 * 확인되므로, 아래 3중 안전장치로 동작합니다.
 *
 *   ① 환경변수 KAPT_ENDPOINT 가 있으면 그대로 사용  (재배포 없이 교정 가능)
 *   ② 없으면 이번 인스턴스에서 자동 탐지된 엔드포인트 사용
 *   ③ 그래도 없으면 후보 목록을 순차 시도
 *
 * 탐지 원리 — 공공데이터포털은 상황별로 다른 오류를 돌려줍니다.
 *   NO_OPENAPI_SERVICE_ERROR        → 그 주소에 서비스가 없음 (후보 탈락)
 *   SERVICE_KEY_IS_NOT_REGISTERED   → 주소는 존재하나 활용신청이 안 됨 (후보 생존)
 *   필수값 누락 / APPLICATION_ERROR → 주소·키 모두 정상, 파라미터만 틀림 (정답에 가장 근접)
 *   resultCode 00                   → 완전 정상
 */
import { parseKst, toNum } from './_lib.js';

export const KAPT_ORG = 'https://apis.data.go.kr/1611000';

/** 서비스명 × 오퍼레이션명 후보 (자동 탐지용) */
const SERVICE_CANDIDATES = [
  'AptBidService',
  'AptBidInfoService',
  'AptBidPblancService',
  'AptNtcService',
  'HsmpBidService',
  'BidPblancService',
];
const OP_CANDIDATES = [
  'getBidPblancList',
  'getAptBidInfo',
  'getAphusBidInfo',
  'getBidInfo',
  'getBidList',
];

/** 날짜 파라미터 이름 후보 (서비스마다 다름) */
const DATE_PARAM_SHAPES = [
  { begin: 'searchBeginDe', end: 'searchEndDe', fmt: 'YMD' },
  { begin: 'bidBeginDe', end: 'bidEndDe', fmt: 'YMD' },
  { begin: 'startDt', end: 'endDt', fmt: 'YMD' },
  { begin: 'inqryBgnDt', end: 'inqryEndDt', fmt: 'YMDHM' },
  { begin: 'searchDate', end: null, fmt: 'YMD' },
];

let DETECTED = null; // { path, dateShape }

const p2 = (n) => String(n).padStart(2, '0');
function ymd(d) {
  const k = new Date(d.getTime() + 9 * 3600000);
  return `${k.getUTCFullYear()}${p2(k.getUTCMonth() + 1)}${p2(k.getUTCDate())}`;
}
function ymdhm(d) {
  const k = new Date(d.getTime() + 9 * 3600000);
  return `${k.getUTCFullYear()}${p2(k.getUTCMonth() + 1)}${p2(k.getUTCDate())}${p2(k.getUTCHours())}${p2(k.getUTCMinutes())}`;
}
const fmtBy = (shape, d) => (shape.fmt === 'YMDHM' ? ymdhm(d) : ymd(d));

/** 응답 원문을 진단 가능한 형태로 분류 */
export function classify(text) {
  const t = String(text || '').trim();
  if (!t) return { kind: 'empty', msg: '빈 응답' };

  const grab = (tag) => {
    const m = t.match(new RegExp('<' + tag + '>(.*?)</' + tag + '>'));
    return m ? m[1] : null;
  };

  if (t.startsWith('<')) {
    const auth = grab('returnAuthMsg') || grab('errMsg') || grab('resultMsg') || '';
    const code = grab('returnReasonCode') || grab('resultCode') || '-';
    if (/NO_OPENAPI_SERVICE/i.test(auth)) return { kind: 'no-service', code, msg: auth };
    if (/SERVICE_KEY_IS_NOT_REGISTERED|등록되지\s*않은/.test(auth)) return { kind: 'key-not-applied', code, msg: auth };
    if (/필수|APPLICATION_ERROR|INVALID_REQUEST|PARAMETER/i.test(auth)) return { kind: 'param-error', code, msg: auth };
    // XML 정상 응답
    if (/<items>|<item>/.test(t)) return { kind: 'ok-xml', code, msg: auth, text: t };
    return { kind: 'other', code, msg: auth || t.slice(0, 160) };
  }

  let j;
  try {
    j = JSON.parse(t);
  } catch {
    return { kind: 'unparsable', msg: t.slice(0, 160) };
  }
  const err = j.OpenAPI_ServiceResponse || j['nkoneps.com.response.ResponseError'];
  if (err) {
    const h = err.cmmMsgHeader || err.header || {};
    const m = h.errMsg || h.returnAuthMsg || h.resultMsg || '';
    if (/NO_OPENAPI_SERVICE/i.test(m + (h.returnAuthMsg || ''))) return { kind: 'no-service', code: h.returnReasonCode, msg: m };
    if (/SERVICE_KEY|등록되지\s*않은/.test(m + (h.returnAuthMsg || ''))) return { kind: 'key-not-applied', code: h.returnReasonCode, msg: m };
    return { kind: 'param-error', code: h.returnReasonCode, msg: m || h.returnAuthMsg };
  }
  const resp = j.response;
  if (!resp) return { kind: 'other', msg: t.slice(0, 160) };
  const code = String((resp.header && resp.header.resultCode) ?? '00');
  if (code !== '00' && code !== '0') {
    return { kind: 'param-error', code, msg: (resp.header && resp.header.resultMsg) || '' };
  }
  return { kind: 'ok', code, body: resp.body || {} };
}

async function get(url, timeoutMs = 10000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'g2b-bid-monitor/1.0' } });
    return { status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * K-apt 인증키 — 전용 키가 있으면 그것을, 없으면 조달청 키를 재사용한다.
 * 공공데이터포털은 같은 키를 Encoding/Decoding 두 형태로 제공하므로 통하는 쪽을 기억한다.
 */
export function kaptKeySource() {
  return process.env.KAPT_SERVICE_KEY ? 'KAPT_SERVICE_KEY' : (process.env.G2B_SERVICE_KEY ? 'G2B_SERVICE_KEY' : null);
}
function rawKey() {
  return String(process.env.KAPT_SERVICE_KEY || process.env.G2B_SERVICE_KEY || '').trim();
}
let KEY_LIT = null;
function keyCandidates() {
  if (KEY_LIT) return [KEY_LIT];
  const k = rawKey();
  if (!k) return [''];
  const enc = encodeURIComponent(k);
  return enc === k ? [k] : [k, enc];
}

/** 한 요청을 인증키 표기법 후보만큼 시도한다. 통한 표기법은 기억한다. */
async function req(path, params, timeoutMs = 10000) {
  let last = null;
  for (const lit of keyCandidates()) {
    const r = await get(build(path, lit, params), timeoutMs);
    const c = classify(r.text);
    last = { r, c };
    if (c.kind !== 'key-not-applied') { KEY_LIT = lit; return last; }
  }
  return last;
}

/** serviceKey 는 재인코딩되면 깨지므로 직접 이어붙입니다. */
function build(path, keyLit, params) {
  const p = new URLSearchParams();
  p.set('type', 'json');
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') p.set(k, String(v));
  return `${KAPT_ORG}/${path}?serviceKey=${keyLit}&${p.toString()}`;
}

/**
 * 엔드포인트 자동 탐지.
 * 후보 (서비스 × 오퍼레이션) 을 훑어 'no-service' 가 아닌 것을 찾습니다.
 * @returns {{path:string|null, rows:Array}}
 */
export async function probeEndpoint(keyLit, budgetMs = 40000) {
  const started = Date.now();
  const rows = [];
  let best = null;

  outer: for (const svc of SERVICE_CANDIDATES) {
    for (const op of OP_CANDIDATES) {
      if (Date.now() - started > budgetMs) {
        rows.push({ path: `${svc}/${op}`, kind: 'skipped', msg: '시간 예산 초과' });
        continue;
      }
      const path = `${svc}/${op}`;
      let out;
      try {
        out = await req(path, { numOfRows: 1, pageNo: 1 }, 8000);
      } catch (e) {
        rows.push({ path, kind: 'net-error', msg: String((e && e.message) || e).slice(0, 80) });
        continue;
      }
      const c = out.c;
      rows.push({ path, http: out.r.status, kind: c.kind, code: c.code, msg: String(c.msg || '').slice(0, 100) });

      // ok > param-error > key-not-applied 순으로 유력
      const rank = { ok: 3, 'ok-xml': 3, 'param-error': 2, 'key-not-applied': 1 }[c.kind] || 0;
      if (rank > 0 && (!best || rank > best.rank)) best = { path, rank, kind: c.kind };
      if (rank === 3) break outer; // 완전 정상이면 즉시 확정
    }
  }

  if (best) DETECTED = { path: best.path, dateShape: null };
  return { path: best ? best.path : null, bestKind: best ? best.kind : null, rows };
}

/** 날짜 파라미터 이름 탐지 — 엔드포인트가 확정된 뒤 사용 */
export async function probeDateShape(keyLit, path, begin, end, budgetMs = 20000) {
  const started = Date.now();
  const rows = [];
  for (const shape of DATE_PARAM_SHAPES) {
    if (Date.now() - started > budgetMs) break;
    const params = { numOfRows: 5, pageNo: 1, [shape.begin]: fmtBy(shape, begin) };
    if (shape.end) params[shape.end] = fmtBy(shape, end);
    let out;
    try {
      out = await req(path, params, 8000);
    } catch (e) {
      rows.push({ shape: shape.begin, kind: 'net-error', msg: String((e && e.message) || e).slice(0, 80) });
      continue;
    }
    const c = out.c;
    const cnt = c.kind === 'ok' ? toNum(c.body.totalCount) : null;
    rows.push({ shape: shape.begin + (shape.end ? '/' + shape.end : ''), kind: c.kind, code: c.code, totalCount: cnt, msg: String(c.msg || '').slice(0, 100) });
    if (c.kind === 'ok' && cnt > 0) {
      if (DETECTED) DETECTED.dateShape = shape;
      return { shape, totalCount: cnt, rows };
    }
  }
  return { shape: null, rows };
}

/** 현재 사용할 엔드포인트 경로 (환경변수 > 자동탐지 > 첫 후보) */
export function currentPath() {
  const env = String(process.env.KAPT_ENDPOINT || '').trim().replace(/^\/+|\/+$/g, '');
  if (env) return env;
  if (DETECTED && DETECTED.path) return DETECTED.path;
  return `${SERVICE_CANDIDATES[0]}/${OP_CANDIDATES[0]}`;
}

function currentDateShape() {
  const envB = String(process.env.KAPT_DATE_BEGIN || '').trim();
  const envE = String(process.env.KAPT_DATE_END || '').trim();
  if (envB) return { begin: envB, end: envE || null, fmt: /Dt$/.test(envB) ? 'YMDHM' : 'YMD' };
  if (DETECTED && DETECTED.dateShape) return DETECTED.dateShape;
  return DATE_PARAM_SHAPES[0];
}

/** K-apt 응답 1건 → 앱 공통 스키마 */
export function normalizeKapt(raw) {
  const pick = (...keys) => {
    for (const k of keys) if (raw[k] != null && String(raw[k]).trim() !== '') return String(raw[k]).trim();
    return '';
  };
  const title = pick('bidNm', 'bidTitle', 'pblancNm', 'bidPblancNm', 'title', 'sbjt');
  const close = pick('bidClsDe', 'bidCloseDate', 'clsDt', 'bidEndDe', 'endDt', 'bidClseDt');
  const notice = pick('bidBeginDe', 'pblancDe', 'regDt', 'startDt', 'bidNtceDt');
  return {
    source: 'kapt',
    sourceLabel: 'K-apt',
    type: 'kapt',
    typeLabel: '공동주택',
    no: pick('bidNum', 'bidNo', 'pblancNo', 'id'),
    ord: '',
    title,
    noticeOrg: pick('kaptName', 'aptNm', 'kaptNm', 'hsmpNm'),
    demandOrg: pick('kaptName', 'aptNm', 'kaptNm', 'hsmpNm'),
    noticeDt: notice,
    closeDt: close,
    openingDt: pick('opengDt', 'openDt'),
    bidMethod: pick('bidMth', 'bidMethod', 'bidTy'),
    contractMethod: pick('cntrctMth', 'contractMethod', 'bidClsfc'),
    estPrice: toNum(pick('bidAmt', 'presmptPrce', 'baseAmt', 'amount')),
    budget: 0,
    clsfcNo: '',
    clsfcNm: pick('bidCtgry', 'category', 'bidClsfcNm'),
    officer: '',
    tel: pick('telNo', 'tel'),
    url: pick('bidUrl', 'detailUrl') || 'https://www.k-apt.go.kr',
    reNotice: '',
    kaptCode: pick('kaptCode', 'kaptCd', 'complexCode'),
    region: pick('area', 'sido', 'addr', 'as1'),
  };
}

/** 기간 조회 — 페이지 끝까지 수집 */
export async function fetchKaptChunk(keyLit, begin, end, opts = {}) {
  const path = currentPath();
  const shape = currentDateShape();
  const rows = [];
  const maxPages = opts.maxPages || 10;
  const rowsPerPage = opts.rowsPerPage || 500;
  const budget = opts.budgetMs || 40000;
  const started = Date.now();
  let total = 0;
  let truncated = false;

  for (let page = 1; page <= maxPages; page++) {
    const params = { numOfRows: rowsPerPage, pageNo: page, [shape.begin]: fmtBy(shape, begin) };
    if (shape.end) params[shape.end] = fmtBy(shape, end);
    if (opts.kaptCode) params.kaptCode = opts.kaptCode;

    const c = (await req(path, params, 12000)).c;

    if (c.kind !== 'ok') {
      // 조용한 실패 금지 — 무엇이 왜 실패했는지 그대로 올린다
      throw new Error(
        `K-apt 조회 실패 [${c.kind}] ${String(c.msg || '').slice(0, 160)} · 사용 경로: ${path} · 날짜파라미터: ${shape.begin} · 인증키: ${kaptKeySource() || '(미설정)'}`
      );
    }

    let items = c.body.items || [];
    if (!Array.isArray(items)) items = items.item ? [].concat(items.item) : [];
    total = toNum(c.body.totalCount);
    rows.push(...items);

    if (!items.length || rows.length >= total) break;
    if (page === maxPages || Date.now() - started > budget) {
      truncated = rows.length < total;
      break;
    }
  }

  return { rows: rows.map(normalizeKapt), totalCount: total, truncated, path, dateParam: shape.begin };
}

/**
 * 세탁 관련 공고 판정 — 단순 제외어로는 '세탁실 무인세탁기 설치 공사'가 통째로 빠진다.
 * 장비명이 있으면 '공사'가 붙어도 포함하고, 장비명 없이 보수성 단어만 있으면 제외한다.
 */
const EQUIP = ['세탁기', '건조기', '세탁장비', '세탁설비', '무인세탁', '코인세탁', '셀프세탁', '빨래방', '린넨'];
const BUILD = ['세탁실', '세탁장', '세탁소'];
const REPAIR = ['방수', '누수', '배관', '타일', '도장', '철거', '미장', '보수', '수선', '교체공사', '리모델링'];
const BUILDUP = ['설치', '구축', '신설', '조성', '개설', '구매', '구입', '임대', '위탁', '운영'];

export function classifyLaundry(rec) {
  const hay = `${rec.title} ${rec.clsfcNm}`.replace(/\s/g, '');
  const hasEquip = EQUIP.some((w) => hay.includes(w));
  const hasRoom = BUILD.some((w) => hay.includes(w));
  if (!hasEquip && !hasRoom) return { match: false, category: null, reason: '세탁 관련 키워드 없음' };

  const hasRepair = REPAIR.some((w) => hay.includes(w));
  const hasBuildup = BUILDUP.some((w) => hay.includes(w));

  if (hasEquip) {
    return { match: true, category: hasBuildup ? '장비구매·설치' : '장비관련', reason: '장비명 포함' };
  }
  // 세탁실만 언급된 경우 — 보수성 단어만 있으면 제외
  if (hasRepair && !hasBuildup) return { match: false, category: '보수공사', reason: '장비명 없이 보수성 단어만 존재' };
  if (hasBuildup) return { match: true, category: '시설구축', reason: '세탁실 + 구축성 단어' };
  return { match: true, category: '판단유보', reason: '세탁실 언급 (수동 확인 권장)' };
}
