/**
 * 나라장터 입찰공고 MCP 서버 (Streamable HTTP · stateless)
 *
 *   POST /mcp/<MCP_TOKEN>        ← Claude 커스텀 커넥터에 등록할 주소
 *   POST /api/mcp?token=<TOKEN>  ← 동일
 *
 * 설계 원칙 (한국 공공 API 관습 대응)
 *  · 조용한 실패 금지 — 인증키/스키마 오류는 반드시 텍스트로 표면화
 *  · 한글 검색어를 조달청 서버로 보내지 않음 — 전량 수신 후 서버가 직접 필터
 *    (기본 오퍼레이션은 bidNtceNm 을 에러 없이 무시하므로)
 *  · 쿼터 방어 — 동일 요청 10분 캐시, 조회기간 상한, 시간 예산 후 절삭 보고
 */
import {
  ENDPOINTS,
  LABELS,
  fetchChunk,
  filterAndEnrich,
  normalize,
  nowKst,
  displayKst,
  readJsonBody,
  selfTestKey,
} from './_lib.js';

const SERVER_NAME = 'g2b-bid-monitor';
const SERVER_VERSION = '1.0.0';
const DEFAULT_PROTOCOL = '2025-06-18';

const WINDOW_MS = 30 * 86400000; // 한 요청 구간 크기
const TIME_BUDGET_MS = 45000;
const CHUNK_CONCURRENCY = 6;
const CACHE_TTL_MS = 10 * 60 * 1000;

// ── 쿼터 방어용 인메모리 캐시 (람다 인스턴스 재사용 구간에서만 유효) ──
const cache = new Map();
function cacheGet(k) {
  const hit = cache.get(k);
  if (!hit) return null;
  if (Date.now() - hit.t > CACHE_TTL_MS) {
    cache.delete(k);
    return null;
  }
  return hit.v;
}
function cacheSet(k, v) {
  if (cache.size > 200) cache.clear();
  cache.set(k, { t: Date.now(), v });
}

// ── 수집 ────────────────────────────────────────────────────────────
async function runPool(jobs, limit) {
  const out = [];
  let i = 0;
  async function worker() {
    while (i < jobs.length) {
      const my = i++;
      try {
        out[my] = await jobs[my]();
      } catch (e) {
        out[my] = { error: String((e && e.message) || e) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return out;
}

/**
 * @param {object} o
 * @param {string[]} o.keywords  포함 키워드 (공고명·세부품명·공고번호 대상)
 * @param {string[]} o.exclude   제외 키워드
 * @param {string[]} o.prefixes  세부품명번호 앞자리
 */
async function collectBids(o) {
  const key = process.env.G2B_SERVICE_KEY;
  if (!key) {
    return { rows: [], warning: '환경변수 G2B_SERVICE_KEY 가 설정되지 않았습니다. 조회를 수행하지 않았습니다.' };
  }

  const now = nowKst();
  const types = (o.types && o.types.length ? o.types : ['thng', 'servc', 'cnstwk']).filter(
    (t) => ENDPOINTS[t]
  );
  const lookbackDays = Math.min(Math.max(Number(o.lookbackDays) || 30, 1), 90);
  // 조회 구간 경계를 10분 단위로 반올림 → 같은 질문을 반복해도 캐시가 적중해 API 호출을 아낀다
  const anchor = Math.ceil(now.getTime() / CACHE_TTL_MS) * CACHE_TTL_MS;
  const beginMs = anchor - lookbackDays * 86400000;

  const specs = [
    {
      name: o.label || '검색',
      keywords: o.keywords || [],
      exclude: o.exclude || [],
      prefixes: o.prefixes || [],
    },
  ];

  const started = Date.now();
  // 실측(2026-08-18): '기본' 경로는 미존재(NO_OPENAPI_SERVICE_ERROR), inqryDiv=2 는 [08] 필수값 에러.
  // → /ad/ 경로 + inqryDiv=1 만 호출한다.
  const DIV = '1';
  const mode = o.mode === 'search' || o.mode === 'list' ? o.mode : 'both';
  const kws = (o.keywords || []).filter(Boolean);
  const jobs = [];

  // (가) 나라장터 검색(PPSSrch) — 조달청이 공고명을 직접 검색. 응답이 작아 호출 비용이 낮다.
  if (mode !== 'list' && kws.length) {
    for (const type of types) {
      for (const kw of kws) {
        for (let s = beginMs; s < anchor; s += WINDOW_MS) {
          const b = new Date(s);
          const e = new Date(Math.min(s + WINDOW_MS, anchor));
          jobs.push(async () => {
            if (Date.now() - started > TIME_BUDGET_MS) return { skipped: true };
            const ck = `S|${type}|${kw}|${b.getTime()}|${e.getTime()}`;
            const hit = cacheGet(ck);
            if (hit) return { ...hit, cached: true };
            const r = await fetchChunk(key, type, b, e, kw, DIV, 0);
            const packed = { rows: r.rows.map((x) => normalize(x, type)), truncated: r.truncated };
            cacheSet(ck, packed);
            return packed;
          });
        }
      }
    }
  }

  // (나) 전체 목록 — 공고명 외에 세부품명·공고번호까지 매칭하려면 필요하다.
  if (mode !== 'search') {
    for (const type of types) {
      for (let s = beginMs; s < anchor; s += WINDOW_MS) {
        const b = new Date(s);
        const e = new Date(Math.min(s + WINDOW_MS, anchor));
        jobs.push(async () => {
          if (Date.now() - started > TIME_BUDGET_MS) return { skipped: true };
          const ck = `L|${type}|${b.getTime()}|${e.getTime()}`;
          const hit = cacheGet(ck);
          if (hit) return { ...hit, cached: true };
          const r = await fetchChunk(key, type, b, e, '', DIV, 0);
          const packed = { rows: r.rows.map((x) => normalize(x, type)), truncated: r.truncated };
          cacheSet(ck, packed);
          return packed;
        });
      }
    }
  }

  const results = await runPool(jobs, CHUNK_CONCURRENCY);

  const errors = [];
  let received = 0;
  let truncated = false;
  let skipped = 0;
  let cachedCount = 0;
  const all = [];
  for (const r of results) {
    if (!r) continue;
    if (r.error) {
      errors.push(r.error);
      continue;
    }
    if (r.skipped) {
      skipped++;
      continue;
    }
    if (r.cached) cachedCount++;
    truncated = truncated || !!r.truncated;
    received += r.rows.length;
    all.push(...r.rows);
  }

  // 인증키·스키마 오류로 전량 실패한 경우 조용히 0건으로 넘기지 않는다
  if (errors.length && received === 0) {
    return { rows: [], error: [...new Set(errors)].slice(0, 2).join(' / ') };
  }

  const { matched, expired, noClose } = filterAndEnrich(
    all,
    specs,
    now,
    Number(o.imminentHours) || 48
  );

  const byNo = new Map();
  for (const rec of matched) {
    const prev = byNo.get(rec.no);
    if (!prev || (+rec.ord || 0) >= (+prev.ord || 0)) byNo.set(rec.no, rec);
  }
  const rows = [...byNo.values()].sort((a, b) => a.hoursLeft - b.hoursLeft);

  return {
    rows,
    stats: {
      queriedAt: displayKst(now),
      lookbackDays,
      businessTypes: types.map((t) => LABELS[t]).join('·'),
      mode,
      received,
      expired,
      noClose,
      matched: rows.length,
      truncated,
      skippedWindows: skipped,
      cachedChunks: cachedCount,
      failedChunks: errors.length,
    },
    warning: errors.length ? `일부 구간 조회 실패: ${[...new Set(errors)][0]}` : null,
  };
}

// ── 결과 포맷 ───────────────────────────────────────────────────────
const won = (n) => (n ? Number(n).toLocaleString('ko-KR') : '-');

function renderRows(rows, limit) {
  const shown = rows.slice(0, limit);
  if (!shown.length) return '조건에 맞는 (마감 전) 공고가 없습니다.';
  const head =
    '| D-Day | 마감일시 | 구분 | 공고명 | 수요기관 | 추정가격(원) | 계약방법 | 공고번호 |\n' +
    '|---|---|---|---|---|---|---|---|';
  const body = shown
    .map(
      (d) =>
        `| ${d.dday}${d.imminent ? ' ⚠' : ''} | ${d.closeDt} | ${d.typeLabel} | ${String(
          d.title
        ).replace(/\|/g, '/')} | ${d.demandOrg} | ${won(d.estPrice)} | ${d.contractMethod} | ${d.no}-${d.ord} |`
    )
    .join('\n');
  return `${head}\n${body}`;
}

function renderStats(s) {
  if (!s) return '';
  return (
    `조회시각 ${s.queriedAt} (KST) · 최근 ${s.lookbackDays}일 · ${s.businessTypes} · 방식 ${({search:'나라장터 검색',list:'전체 목록',both:'검색+목록'})[s.mode] || s.mode}\n` +
    `수신 ${s.received.toLocaleString()}건 → 마감경과 ${s.expired.toLocaleString()}건 제외 → 매칭 ${s.matched.toLocaleString()}건` +
    (s.cachedChunks ? ` · 캐시 적중 ${s.cachedChunks}구간(API 미호출)` : '') +
    (s.truncated ? '\n※ 일부 구간이 절삭되었습니다. lookbackDays 를 줄이십시오.' : '') +
    (s.skippedWindows ? `\n※ 시간 초과로 ${s.skippedWindows}개 구간을 건너뛰었습니다.` : '')
  );
}

function textResult(text, isError) {
  return { content: [{ type: 'text', text }], isError: !!isError };
}

// ── 도구 정의 ───────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'search_active_bids',
    title: '유효 입찰공고 키워드 검색',
    description:
      '조달청 나라장터에서 조회 시점 기준으로 입찰마감이 아직 지나지 않은 공고만 키워드로 찾습니다. ' +
      '공고명·세부품명·공고번호를 모두 대상으로 하며, 키워드는 짧을수록 넓게 잡힙니다 ' +
      '(예: "세탁기"는 "세탁물 처리 용역"을 놓치지만 "세탁"은 둘 다 잡습니다). ' +
      '마감이 지난 공고는 반환하지 않습니다.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: '검색어. 쉼표로 여러 개 지정 가능(OR 조건). 예: "세탁, 건조기"',
        },
        exclude: {
          type: 'string',
          description: '제외할 단어. 쉼표 구분. 예: "수리, 유지보수". 포함 키워드보다 우선합니다.',
        },
        businessTypes: {
          type: 'array',
          items: { type: 'string', enum: ['thng', 'servc', 'cnstwk', 'frgcpt'] },
          description: '업무구분. thng=물품(내자 포함), servc=용역, cnstwk=공사, frgcpt=외자. 기본 [thng,servc,cnstwk]',
        },
        lookbackDays: {
          type: 'integer',
          minimum: 1,
          maximum: 90,
          description: '몇 일 전 공고까지 훑을지. 기본 30. 살아있는 공고는 통상 최근 2주치입니다.',
        },
        mode: {
          type: 'string',
          enum: ['both', 'search', 'list'],
          description:
            "수집 방식. both=검색+목록(기본, 누락 최소) / search=조달청 서버가 공고명만 검색(가장 빠름, 호출 최소) / " +
            "list=기간 전량 수신 후 직접 필터(세부품명·공고번호까지 매칭)",
        },
        imminentHours: { type: 'integer', description: '마감임박 표시 기준(시간). 기본 48' },
        limit: { type: 'integer', description: '반환 최대 건수. 기본 30, 최대 100' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'search_bids_by_classification',
    title: '세부품명번호로 유효 공고 검색',
    description:
      '세부품명번호(물품분류번호) 앞자리로 마감 전 입찰공고를 찾습니다. ' +
      '키워드 검색이 공고명 표기 차이로 놓치는 건을 잡을 때 씁니다. 예: 4713 = 세탁·건조 장비 계열.',
    inputSchema: {
      type: 'object',
      properties: {
        classificationPrefix: {
          type: 'string',
          description: '세부품명번호 앞자리. 쉼표로 여러 개 지정 가능. 예: "4713, 4721"',
        },
        lookbackDays: { type: 'integer', minimum: 1, maximum: 90 },
        limit: { type: 'integer' },
      },
      required: ['classificationPrefix'],
    },
  },
  {
    name: 'get_bid_detail',
    title: '공고번호로 상세 조회',
    description:
      '공고번호(예: R26BK01666597)로 해당 입찰공고의 전체 항목을 가져옵니다. ' +
      '마감이 지난 공고도 반환하며, 최근 lookbackDays 범위 안에 게시된 공고만 찾을 수 있습니다.',
    inputSchema: {
      type: 'object',
      properties: {
        bidNtceNo: { type: 'string', description: '공고번호. 차수(-000)는 있어도 없어도 됩니다.' },
        lookbackDays: { type: 'integer', minimum: 1, maximum: 90, description: '기본 60' },
      },
      required: ['bidNtceNo'],
    },
  },
  {
    name: 'diagnose_api_key',
    title: '조달청 인증키 상태 진단',
    description:
      '공공데이터포털 인증키가 조달청 API에서 실제로 통하는지 1회 호출로 확인합니다. ' +
      '조회 결과가 계속 0건일 때 가장 먼저 실행하십시오. 인증키 값 자체는 반환하지 않습니다.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ── 도구 실행 ───────────────────────────────────────────────────────
const splitList = (s) =>
  String(s || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

async function callTool(name, args) {
  const a = args || {};

  if (name === 'diagnose_api_key') {
    if (!process.env.G2B_SERVICE_KEY) {
      return textResult('환경변수 G2B_SERVICE_KEY 가 설정되지 않았습니다.', true);
    }
    const t = await selfTestKey(process.env.G2B_SERVICE_KEY);
    const lines = [
      `등록된 인증키 길이: ${t.keyLength}자 ${t.keyLength < 40 ? '← 비정상 (정상 인증키는 80~100자)' : ''}`,
      `판정: ${t.verdict}`,
      ...t.results.map((r) => `  · ${r.form}: ${r.ok ? `성공 (총 ${r.totalCount}건)` : `실패 — ${r.error}`}`),
    ];
    if (!t.working) {
      lines.push(
        '',
        '조치 순서:',
        '1) 공공데이터포털 → 마이페이지 → 개발계정 상세보기에서 "조달청_나라장터 입찰공고정보서비스" 승인 여부 확인',
        '2) 일반 인증키(Decoding)를 복사 버튼으로 전체 복사해 환경변수 G2B_SERVICE_KEY 에 재등록 후 재배포',
        '3) 그래도 403이면 게이트웨이 권한 반영 대기 — 1~2시간 뒤 재시도 (코드 수정 불필요)'
      );
    }
    return textResult(lines.join('\n'), !t.working);
  }

  if (name === 'search_active_bids') {
    const keywords = splitList(a.keyword);
    if (!keywords.length) return textResult('keyword 를 지정하십시오.', true);
    const r = await collectBids({
      label: keywords.join('·'),
      keywords,
      exclude: splitList(a.exclude),
      prefixes: [],
      types: a.businessTypes,
      lookbackDays: a.lookbackDays,
      imminentHours: a.imminentHours,
      mode: a.mode,
    });
    if (r.error) return textResult(`조달청 조회 실패: ${r.error}`, true);
    if (r.warning && !r.rows.length) return textResult(r.warning, true);
    const limit = Math.min(Math.max(Number(a.limit) || 30, 1), 100);
    return textResult(
      [
        `# "${keywords.join(', ')}" 마감 전 입찰공고 ${r.rows.length}건`,
        renderStats(r.stats),
        r.warning ? `\n※ ${r.warning}` : '',
        '',
        renderRows(r.rows, limit),
        r.rows.length > limit ? `\n(상위 ${limit}건만 표시)` : '',
        '',
        '※ 수집 시점 스냅샷입니다. 투찰 전 나라장터 원문 공고에서 마감일시와 자격요건을 반드시 확인하십시오.',
      ]
        .filter(Boolean)
        .join('\n')
    );
  }

  if (name === 'search_bids_by_classification') {
    const prefixes = splitList(a.classificationPrefix);
    if (!prefixes.length) return textResult('classificationPrefix 를 지정하십시오.', true);
    const r = await collectBids({
      label: prefixes.join('·'),
      keywords: [],
      exclude: [],
      prefixes,
      types: ['thng', 'frgcpt'],
      lookbackDays: a.lookbackDays,
      mode: 'list',
    });
    if (r.error) return textResult(`조달청 조회 실패: ${r.error}`, true);
    const limit = Math.min(Math.max(Number(a.limit) || 30, 1), 100);
    return textResult(
      [
        `# 세부품명번호 ${prefixes.join(', ')} 계열 마감 전 공고 ${r.rows.length}건`,
        renderStats(r.stats),
        '',
        renderRows(r.rows, limit),
      ].join('\n')
    );
  }

  if (name === 'get_bid_detail') {
    const no = String(a.bidNtceNo || '').trim();
    if (!no) return textResult('bidNtceNo 를 지정하십시오.', true);
    const bare = no.split('-')[0];
    const r = await collectBids({
      label: bare,
      keywords: [bare],
      exclude: [],
      prefixes: [],
      types: ['thng', 'servc', 'cnstwk', 'frgcpt'],
      lookbackDays: a.lookbackDays || 60,
      imminentHours: 48,
      mode: 'list',
    });
    if (r.error) return textResult(`조달청 조회 실패: ${r.error}`, true);
    const hit = r.rows.find((x) => x.no.includes(bare));
    if (!hit) {
      return textResult(
        `공고번호 ${no} 을(를) 최근 ${r.stats ? r.stats.lookbackDays : 60}일 범위에서 찾지 못했습니다.\n` +
          '이미 마감된 공고이거나(이 도구는 마감 전 공고만 반환합니다) 조회 기간 밖일 수 있습니다. ' +
          'lookbackDays 를 늘려 다시 시도하십시오.',
        true
      );
    }
    const kv = [
      ['공고번호', `${hit.no}-${hit.ord}`],
      ['공고명', hit.title],
      ['업무구분', hit.typeLabel],
      ['공고기관', hit.noticeOrg],
      ['수요기관', hit.demandOrg],
      ['공고일시', hit.noticeDt],
      ['입찰마감일시', `${hit.closeDt} (${hit.dday})`],
      ['개찰일시', hit.openingDt],
      ['계약방법', hit.contractMethod],
      ['입찰방법', hit.bidMethod],
      ['추정가격', won(hit.estPrice) + '원'],
      ['배정예산', won(hit.budget) + '원'],
      ['세부품명', hit.clsfcNm],
      ['품명번호', hit.clsfcNo],
      ['담당자', `${hit.officer} ${hit.tel}`],
      ['재공고 여부', hit.reNotice],
      ['원문', hit.url],
    ];
    return textResult(
      `# ${hit.title}\n\n| 항목 | 내용 |\n|---|---|\n` +
        kv.map(([k, v]) => `| ${k} | ${String(v || '-').replace(/\|/g, '/')} |`).join('\n')
    );
  }

  return textResult(`알 수 없는 도구: ${name}`, true);
}

// ── JSON-RPC ────────────────────────────────────────────────────────
const rpcOk = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function handleRpc(msg) {
  const { id, method, params } = msg || {};

  if (method === 'initialize') {
    const want = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
    return rpcOk(id, {
      protocolVersion: want || DEFAULT_PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, title: '나라장터 유효 입찰공고', version: SERVER_VERSION },
      instructions:
        '조달청 나라장터의 입찰공고를 조회합니다. 이 서버는 조회 시점 기준으로 ' +
        '입찰마감이 지나지 않은 공고만 돌려줍니다. 결과가 계속 0건이면 diagnose_api_key 를 먼저 실행하십시오.',
    });
  }
  if (method === 'ping') return rpcOk(id, {});
  if (method === 'tools/list') return rpcOk(id, { tools: TOOLS });
  if (method === 'resources/list') return rpcOk(id, { resources: [] });
  if (method === 'prompts/list') return rpcOk(id, { prompts: [] });

  if (method === 'tools/call') {
    const name = params && params.name;
    try {
      return rpcOk(id, await callTool(name, params && params.arguments));
    } catch (e) {
      return rpcOk(id, textResult(`도구 실행 중 오류: ${String((e && e.message) || e)}`, true));
    }
  }

  return rpcErr(id, -32601, `Method not found: ${method}`);
}

// ── HTTP 핸들러 ─────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'content-type, authorization, mcp-protocol-version, mcp-session-id, last-event-id'
  );
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, mcp-protocol-version');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const expected = process.env.MCP_TOKEN || '';
  if (!expected) {
    return res
      .status(503)
      .json({ error: '환경변수 MCP_TOKEN 이 설정되지 않아 MCP 서버가 비활성 상태입니다.' });
  }

  const url = new URL(req.url, 'http://x');
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const given = url.searchParams.get('token') || bearer;
  if (given !== expected) return res.status(404).json({ error: 'not found' });

  if (req.method === 'GET') {
    // stateless 서버 — SSE 스트림을 열지 않습니다.
    return res.status(405).json({ error: 'Method Not Allowed. POST 로 JSON-RPC 를 보내십시오.' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const body = readJsonBody(req);

  // 알림(notification)은 id 가 없고 응답 본문이 없어야 합니다.
  const isNotification = (m) => m && m.id === undefined;

  if (Array.isArray(body)) {
    const out = [];
    for (const m of body) {
      const r = await handleRpc(m);
      if (!isNotification(m)) out.push(r);
    }
    if (!out.length) return res.status(202).end();
    return res.status(200).json(out);
  }

  if (isNotification(body)) return res.status(202).end();

  const result = await handleRpc(body);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(200).json(result);
}
