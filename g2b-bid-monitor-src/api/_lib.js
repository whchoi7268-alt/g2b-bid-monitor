/**
 * 공용 모듈 — 인증, 나라장터 API 호출, 정규화·필터·분류
 * (파일명이 _ 로 시작하므로 Vercel 라우트로 노출되지 않습니다)
 */

import crypto from 'node:crypto';

// ── 상수 ────────────────────────────────────────────────────────────
// 조달청 입찰공고 서비스 base 경로 2종.
// 개편 전후 경로가 공존하며 반환 범위가 다를 수 있어 둘 다 조회 후 병합합니다.
export const BID_BASES = [
  'https://apis.data.go.kr/1230000/ad/BidPublicInfoService',
  'https://apis.data.go.kr/1230000/BidPublicInfoService',
];
export const BID_BASE = BID_BASES[0];

export const ENDPOINTS = {
  thng: 'getBidPblancListInfoThng',
  servc: 'getBidPblancListInfoServc',
  cnstwk: 'getBidPblancListInfoCnstwk',
  frgcpt: 'getBidPblancListInfoFrgcpt',
};

// 나라장터 웹 검색창과 동일한 검색 엔진 (조달청 검색조건에 의한 조회)
export const SEARCH_ENDPOINTS = {
  thng: 'getBidPblancListInfoThngPPSSrch',
  servc: 'getBidPblancListInfoServcPPSSrch',
  cnstwk: 'getBidPblancListInfoCnstwkPPSSrch',
  frgcpt: 'getBidPblancListInfoFrgcptPPSSrch',
};

export const LABELS = { thng: '물품', servc: '용역', cnstwk: '공사', frgcpt: '외자' };

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const MAX_PAGES = 20;
const ROWS = 999;
const BUDGET_MS = 45_000; // 함수 제한(60s) 안쪽에서 안전하게 멈추기 위한 예산

// ── 인증 ────────────────────────────────────────────────────────────
export function authToken() {
  const pw = process.env.APP_PASSWORD || '';
  if (!pw) return null;
  return crypto.createHash('sha256').update(`g2b::${pw}`).digest('hex');
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** 인증 통과 여부. 통과하지 못하면 res에 오류를 쓰고 false 반환. */
export function requireAuth(req, res) {
  const expected = authToken();
  if (!expected) {
    res.status(503).json({
      error: 'NOT_CONFIGURED',
      message:
        '환경변수 APP_PASSWORD 가 설정되지 않았습니다. ' +
        'Vercel 프로젝트 → Settings → Environment Variables 에서 설정한 뒤 재배포하세요.',
    });
    return false;
  }
  const got = readCookie(req, 'g2b_auth') || '';
  const a = Buffer.from(got.padEnd(expected.length, '0').slice(0, expected.length));
  const b = Buffer.from(expected);
  if (got.length !== expected.length || !crypto.timingSafeEqual(a, b)) {
    res.status(401).json({ error: 'UNAUTHORIZED', message: '로그인이 필요합니다.' });
    return false;
  }
  return true;
}

// ── 날짜 유틸 (KST 기준) ────────────────────────────────────────────
export function nowKst() {
  return new Date();
}

/** 'YYYY-MM-DD HH:mm:ss' / 'YYYYMMDDHHmm' 등을 KST로 해석해 Date 반환 */
export function parseKst(value) {
  if (!value) return null;
  const d = String(value).replace(/\D/g, '');
  if (d.length < 8) return null;
  const y = +d.slice(0, 4);
  const mo = +d.slice(4, 6);
  const dd = +d.slice(6, 8);
  const hh = +(d.slice(8, 10) || 0);
  const mi = +(d.slice(10, 12) || 0);
  const ss = +(d.slice(12, 14) || 0);
  if (!y || !mo || !dd) return null;
  const t = Date.UTC(y, mo - 1, dd, hh, mi, ss) - KST_OFFSET_MS;
  const dt = new Date(t);
  return isNaN(dt.getTime()) ? null : dt;
}

/** Date → 'YYYYMMDDHHmm' (KST 벽시계) */
export function fmtKst(date) {
  const k = new Date(date.getTime() + KST_OFFSET_MS);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    k.getUTCFullYear() +
    p(k.getUTCMonth() + 1) +
    p(k.getUTCDate()) +
    p(k.getUTCHours()) +
    p(k.getUTCMinutes())
  );
}

/** Date → 'YYYY-MM-DD HH:mm' (KST 벽시계) */
export function displayKst(date) {
  const s = fmtKst(date);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}`;
}

/** KST 달력 기준 날짜 차이(일) */
function calDayDiff(from, to) {
  const a = new Date(from.getTime() + KST_OFFSET_MS);
  const b = new Date(to.getTime() + KST_OFFSET_MS);
  const da = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const db = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.round((db - da) / 86400000);
}

export function toNum(v) {
  const n = parseFloat(String(v ?? '').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// ── 나라장터 호출 ───────────────────────────────────────────────────
/**
 * 요청 URL 생성.
 * keyword 가 있으면 나라장터 웹 검색과 동일한 PPSSrch 오퍼레이션을 사용합니다
 * (공고명 검색을 조달청 서버가 직접 수행 → 누락 감소, 응답량 축소).
 */
/**
 * 인증키 후보 2종.
 * 공공데이터포털은 같은 키를 Encoding(퍼센트 인코딩 완료) / Decoding(원문) 두 형태로 제공합니다.
 *  · Encoding 키 → URL에 그대로 넣어야 함 (다시 인코딩하면 % 가 %25 로 깨짐)
 *  · Decoding 키 → encodeURIComponent 로 인코딩해서 넣어야 함 (+ / = 가 그대로 들어가면 깨짐)
 * 어느 형태를 등록했는지 알 수 없으므로 둘 다 시도하고, 성공한 형태를 기억합니다.
 */
export function keyLiterals(key) {
  const k = String(key || '').trim();
  const out = [];
  const add = (label, value) => {
    if (value && !out.some((x) => x.value === value)) out.push({ label, value });
  };
  add('as-is(Encoding키)', k);
  add('encoded(Decoding키)', encodeURIComponent(k));
  return out;
}

let KEY_LITERAL = null; // 이번 인스턴스에서 검증된 인증키 표기법

/** 인증키 미등록/미승인 계열 오류인지 */
function isKeyError(msg) {
  const s = String(msg || '');
  return (
    /등록되지\s*않은\s*서비스/.test(s) ||
    /NOT_REGISTERED/i.test(s) ||
    /SERVICE_KEY/i.test(s) ||
    /등록되지\s*않은\s*인증/.test(s) ||
    /활용신청/.test(s)
  );
}

export function buildBidUrl(key, type, begin, end, page, keyword, inqryDiv, baseIdx, literal) {
  const op = keyword ? SEARCH_ENDPOINTS[type] : ENDPOINTS[type];
  const base = BID_BASES[Number(baseIdx) || 0] || BID_BASES[0];
  const p = new URLSearchParams();
  p.set('type', 'json');
  p.set('inqryDiv', String(inqryDiv || '1'));
  p.set('inqryBgnDt', fmtKst(begin));
  p.set('inqryEndDt', fmtKst(end));
  p.set('numOfRows', String(ROWS));
  p.set('pageNo', String(page));
  if (keyword) p.set('bidNtceNm', keyword);
  // serviceKey 는 URLSearchParams 로 넣으면 재인코딩되어 깨지므로 직접 이어붙입니다.
  const lit = literal != null ? literal : keyLiterals(key)[0].value;
  return `${base}/${op}?serviceKey=${lit}&${p.toString()}`;
}

/** 조달청 응답 원문 → { items, totalCount } · 오류는 반드시 throw (조용한 0건 금지) */
export function parseBidResponse(text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('조달청이 빈 응답을 반환했습니다.');

  if (t.startsWith('<')) {
    const m = t.match(/<returnAuthMsg>(.*?)<\/returnAuthMsg>/);
    const c = t.match(/<returnReasonCode>(.*?)<\/returnReasonCode>/);
    const rc = t.match(/<resultCode>(.*?)<\/resultCode>/);
    const rm = t.match(/<resultMsg>(.*?)<\/resultMsg>/);
    throw new Error(
      `조달청 API 오류 [${(c && c[1]) || (rc && rc[1]) || '-'}] ${
        (m && m[1]) || (rm && rm[1]) || t.slice(0, 160)
      }`
    );
  }

  let json;
  try {
    json = JSON.parse(t);
  } catch {
    throw new Error(`조달청 응답을 해석할 수 없습니다: ${t.slice(0, 160)}`);
  }

  if (json['nkoneps.com.response.ResponseError']) {
    const h = json['nkoneps.com.response.ResponseError'].header || {};
    throw new Error(`조달청 API 오류 [${h.resultCode}] ${h.resultMsg}`);
  }

  const resp = json.response;
  if (!resp || typeof resp !== 'object') {
    // 인증키 오류 등이 JSON 으로 오는 경우 — 예전 코드는 이걸 0건으로 삼켰습니다.
    const code =
      json.resultCode ?? json.returnReasonCode ?? json.errCode ?? json.code ?? '-';
    const msg =
      json.resultMsg ?? json.returnAuthMsg ?? json.errMsg ?? json.message ?? t.slice(0, 160);
    throw new Error(`조달청 API 오류 [${code}] ${msg}`);
  }

  const header = resp.header || {};
  const code = String(header.resultCode ?? '00');
  if (code !== '00' && code !== '0') {
    throw new Error(`조달청 API 오류 [${code}] ${header.resultMsg || ''}`);
  }
  const body = resp.body || {};
  let items = body.items || [];
  if (!Array.isArray(items)) items = items.item ? [].concat(items.item) : [];
  return { items, totalCount: toNum(body.totalCount) };
}

async function rawGet(url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'g2b-bid-monitor/1.0', Accept: 'application/json' },
    });
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPage(key, type, begin, end, page, keyword, inqryDiv, baseIdx, timeoutMs = 12_000) {
  const cands = KEY_LITERAL ? [{ label: 'cached', value: KEY_LITERAL }] : keyLiterals(key);
  let lastErr = null;

  for (const cand of cands) {
    const url = buildBidUrl(key, type, begin, end, page, keyword, inqryDiv, baseIdx, cand.value);
    try {
      const out = parseBidResponse(await rawGet(url, timeoutMs));
      KEY_LITERAL = cand.value; // 통한 표기법을 기억 → 이후 재시도 없음
      return out;
    } catch (e) {
      lastErr = e;
      if (!isKeyError(e.message)) throw e; // 인증키 문제가 아니면 즉시 실패
      KEY_LITERAL = null;
    }
  }
  throw new Error(
    `${lastErr ? lastErr.message : '인증키 오류'} — 공공데이터포털에서 발급받은 인증키가 ` +
      `이 서비스(조달청_나라장터 입찰공고정보서비스)에 활용신청·승인되어 있는지 확인하십시오.`
  );
}

/** 인증키 자가진단 — 최근 1일치 물품 공고 1건만 요청해 어느 표기법이 통하는지 확인 */
export async function selfTestKey(key) {
  const now = new Date();
  const begin = new Date(now.getTime() - 86400000);
  const results = [];
  for (const cand of keyLiterals(key)) {
    const base = BID_BASES[0];
    const p = new URLSearchParams({
      type: 'json',
      inqryDiv: '1',
      inqryBgnDt: fmtKst(begin),
      inqryEndDt: fmtKst(now),
      numOfRows: '1',
      pageNo: '1',
    });
    const url = `${base}/${ENDPOINTS.thng}?serviceKey=${cand.value}&${p.toString()}`;
    try {
      const out = parseBidResponse(await rawGet(url, 12_000));
      results.push({ form: cand.label, ok: true, totalCount: out.totalCount });
      KEY_LITERAL = cand.value;
      break;
    } catch (e) {
      results.push({ form: cand.label, ok: false, error: String(e.message || e) });
    }
  }
  const win = results.find((r) => r.ok);
  return {
    keyLength: String(key || '').trim().length,
    working: win ? win.form : null,
    verdict: win
      ? `인증키 정상 (${win.form} 형태로 통신). 최근 1일 물품 공고 ${Number(
          win.totalCount
        ).toLocaleString()}건 확인.`
      : '인증키가 조달청 API에서 거부되었습니다. 공공데이터포털 → 마이페이지 → 활용신청 현황에서 ' +
        '"조달청_나라장터 입찰공고정보서비스"가 승인 상태인지, 인증키를 정확히 복사했는지 확인하십시오.',
    results,
  };
}

/** 이번 인스턴스에서 통하는 인증키 표기법을 확정해 돌려줌 (진단 모듈용) */
export async function resolveKeyLiteral(key) {
  if (KEY_LITERAL) return KEY_LITERAL;
  try {
    await selfTestKey(key);
  } catch {
    /* 자가진단 실패해도 기본 표기법으로 진행 */
  }
  return KEY_LITERAL || keyLiterals(key)[0].value;
}

/** 한 (업무구분 × 기간구간 [× 검색어])을 페이지 끝까지 수집 */
export async function fetchChunk(key, type, begin, end, keyword, inqryDiv, baseIdx) {
  const started = Date.now();
  const out = [];
  let total = 0;
  let truncated = false;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const { items, totalCount } = await fetchPage(key, type, begin, end, page, keyword, inqryDiv, baseIdx);
    total = totalCount;
    out.push(...items);
    if (!items.length || out.length >= totalCount) break;
    if (page === MAX_PAGES || Date.now() - started > BUDGET_MS) {
      truncated = out.length < totalCount;
      break;
    }
  }
  return { rows: out, totalCount: total, truncated };
}

// ── 정규화 · 분류 ───────────────────────────────────────────────────
export function normalize(raw, type) {
  return {
    type,
    typeLabel: LABELS[type] || type,
    no: String(raw.bidNtceNo ?? '').trim(),
    ord: String(raw.bidNtceOrd ?? '').trim(),
    title: String(raw.bidNtceNm ?? '').trim(),
    noticeOrg: String(raw.ntceInsttNm ?? '').trim(),
    demandOrg: String(raw.dminsttNm ?? '').trim(),
    noticeDt: String(raw.bidNtceDt ?? '').trim(),
    closeDt: String(raw.bidClseDt ?? '').trim(),
    openingDt: String(raw.opengDt ?? '').trim(),
    bidMethod: String(raw.bidMethdNm ?? '').trim(),
    contractMethod: String(raw.cntrctCnclsMthdNm ?? '').trim(),
    estPrice: toNum(raw.presmptPrce),
    budget: toNum(raw.asignBdgtAmt),
    clsfcNo: String(raw.dtilPrdctClsfcNo ?? '').trim(),
    clsfcNm: String(raw.dtilPrdctClsfcNoNm ?? '').trim(),
    officer: String(raw.ntceInsttOfclNm ?? '').trim(),
    tel: String(raw.ntceInsttOfclTelNo ?? '').trim(),
    url: String(raw.bidNtceDtlUrl ?? '').trim(),
    reNotice: String(raw.reNtceYn ?? '').trim(),
  };
}

/** 품목 매칭 — 키워드 OR 품명번호 앞자리, 제외어 우선 */
export function matchItems(rec, itemSpecs) {
  if (!itemSpecs?.length) return ['전체'];
  // 공고번호까지 포함 — 공고번호를 그대로 붙여넣어 검색할 수 있게 합니다.
  const hay = `${rec.title} ${rec.clsfcNm} ${rec.no}`.replace(/\s/g, '');
  const hits = [];
  for (const spec of itemSpecs) {
    const excl = (spec.exclude || []).filter(Boolean);
    if (excl.some((x) => hay.includes(x.replace(/\s/g, '')))) continue;
    const kw = (spec.keywords || []).filter(Boolean).some((k) => hay.includes(k.replace(/\s/g, '')));
    const pf =
      !!rec.clsfcNo &&
      (spec.prefixes || []).filter(Boolean).some((p) => rec.clsfcNo.startsWith(p));
    if (kw || pf) hits.push(spec.name || '미분류');
  }
  return hits;
}

/** 마감 미도래 + 품목 매칭 필터를 적용하고 D-Day 정보를 붙임 */
export function filterAndEnrich(records, itemSpecs, now, imminentHours = 48) {
  const out = [];
  let expired = 0;
  let noClose = 0;

  for (const rec of records) {
    const close = parseKst(rec.closeDt);
    if (!close) {
      noClose++;
      continue;
    }
    if (close <= now) {
      expired++;
      continue;
    }
    const items = matchItems(rec, itemSpecs);
    if (!items.length) continue;

    const hoursLeft = (close - now) / 3600000;
    const calDays = calDayDiff(now, close);
    out.push({
      ...rec,
      items,
      itemLabel: items.join(', '),
      hoursLeft: Math.round(hoursLeft * 10) / 10,
      daysLeft: calDays,
      dday: calDays === 0 ? 'D-DAY(오늘)' : `D-${calDays}`,
      imminent: hoursLeft <= imminentHours,
    });
  }
  return { matched: out, expired, noClose };
}

// ── 데모 데이터 (서비스키 미설정 시) ────────────────────────────────
export function demoRows(now) {
  const at = (h) => {
    const d = new Date(now.getTime() + h * 3600000 + KST_OFFSET_MS);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00`;
  };
  return [
    ['20260801001', '○○병원 산업용 세탁기 구매', '국립○○병원', 20, 185000000, '4713150101', '업무용세탁기', '일반경쟁'],
    ['20260805002', '△△시설 세탁건조기 및 린넨카트 구입', '△△시청', 310, 62000000, '4713150202', '건조기', '제한경쟁'],
    ['20260806003', '세탁기 수리 및 유지보수 용역', '□□공사', 150, 18000000, '', '', '일반경쟁'],
    ['20260710004', '구형 세탁장비 교체 구매(마감경과)', '◇◇대학교', -48, 95000000, '4713150101', '업무용세탁기', '일반경쟁'],
    ['20260807005', '노트북 및 모니터 구매', '◎◎청', 200, 44000000, '4321150301', '노트북컴퓨터', '일반경쟁'],
    ['20260808006', '청사 집기류 일괄 구매(재공고)', '☆☆교육청', 95, 128000000, '5610150101', '사무용책상', '일반경쟁'],
    ['20260809007', '2026년 청사 청소 및 환경미화 용역', '▽▽구청', 40, 340000000, '', '', '협상에의한계약'],
  ].map(([no, nm, org, h, price, cno, cnm, method]) => ({
    bidNtceNo: no,
    bidNtceOrd: '00',
    bidNtceNm: nm,
    ntceInsttNm: org,
    dminsttNm: org,
    bidNtceDt: at(-240),
    bidClseDt: at(h),
    opengDt: at(h + 6),
    bidMethdNm: '전자입찰',
    cntrctCnclsMthdNm: method,
    presmptPrce: String(price),
    asignBdgtAmt: String(Math.round(price * 1.1)),
    dtilPrdctClsfcNo: cno,
    dtilPrdctClsfcNoNm: cnm,
    bidNtceDtlUrl: 'https://www.g2b.go.kr',
    ntceInsttOfclNm: '담당자',
    ntceInsttOfclTelNo: '000-0000-0000',
  }));
}

export function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}
