/**
 * 화면에 표시된 결과를 엑셀(xlsx) 또는 CSV로 내보냅니다.
 * POST /api/export  { format: 'xlsx'|'csv', rows:[...], itemNames:[...], meta:{...} }
 */
import ExcelJS from 'exceljs';
import { displayKst, nowKst, readJsonBody, requireAuth } from './_lib.js';

const COLUMNS = [
  { key: 'dday', header: 'D-Day', width: 12 },
  { key: 'closeDt', header: '입찰마감일시', width: 20 },
  { key: 'itemLabel', header: '품목', width: 16 },
  { key: 'typeLabel', header: '구분', width: 8 },
  { key: 'title', header: '공고명', width: 58 },
  { key: 'no', header: '공고번호', width: 18 },
  { key: 'demandOrg', header: '수요기관', width: 24 },
  { key: 'noticeOrg', header: '공고기관', width: 24 },
  { key: 'estPrice', header: '추정가격(원)', width: 17, num: true },
  { key: 'budget', header: '배정예산(원)', width: 17, num: true },
  { key: 'contractMethod', header: '계약방법', width: 18 },
  { key: 'bidMethod', header: '입찰방법', width: 15 },
  { key: 'clsfcNm', header: '세부품명', width: 22 },
  { key: 'clsfcNo', header: '품명번호', width: 14 },
  { key: 'noticeDt', header: '공고일시', width: 20 },
  { key: 'officer', header: '담당자', width: 12 },
  { key: 'tel', header: '연락처', width: 16 },
  { key: 'url', header: '상세링크', width: 14 },
];

const FONT = { name: 'Arial', size: 10 };

function styleSheet(ws, rows) {
  ws.columns = COLUMNS.map((c) => ({ key: c.key, width: c.width }));

  const head = ws.getRow(1);
  COLUMNS.forEach((c, i) => (head.getCell(i + 1).value = c.header));
  head.eachCell((cell) => {
    cell.font = { ...FONT, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFD0D0D0' } },
      left: { style: 'thin', color: { argb: 'FFD0D0D0' } },
      bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } },
      right: { style: 'thin', color: { argb: 'FFD0D0D0' } },
    };
  });

  rows.forEach((r) => {
    const row = ws.addRow(
      COLUMNS.reduce((acc, c) => {
        acc[c.key] = c.key === 'url' ? (r.url ? '상세보기' : '') : (r[c.key] ?? '');
        return acc;
      }, {})
    );
    row.eachCell((cell, col) => {
      const spec = COLUMNS[col - 1];
      cell.font = { ...FONT };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFF0F0F0' } },
        left: { style: 'thin', color: { argb: 'FFF0F0F0' } },
        bottom: { style: 'thin', color: { argb: 'FFF0F0F0' } },
        right: { style: 'thin', color: { argb: 'FFF0F0F0' } },
      };
      if (spec.num) cell.numFmt = '#,##0;-#,##0;-';
      if (spec.key === 'url' && r.url) {
        cell.value = { text: '상세보기', hyperlink: r.url };
        cell.font = { ...FONT, color: { argb: 'FF0563C1' }, underline: true };
      }
    });
    if (r.imminent) {
      row.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4E4' } };
      });
    }
  });

  ws.views = [{ state: 'frozen', ySplit: 1 }];
  if (rows.length) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: rows.length + 1, column: COLUMNS.length } };
  }
}

function safeSheetName(name, fallback) {
  const cleaned = String(name || '').replace(/[\[\]\*\?\/\\:]/g, '_').slice(0, 28);
  return cleaned || fallback;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  if (!requireAuth(req, res)) return;

  const body = readJsonBody(req);
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const itemNames = Array.isArray(body.itemNames) ? body.itemNames : [];
  const format = body.format === 'csv' ? 'csv' : 'xlsx';
  const now = nowKst();
  const stamp = displayKst(now).replace(/[-: ]/g, '').slice(0, 12);

  if (format === 'csv') {
    const esc = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [COLUMNS.map((c) => c.header).join(',')];
    for (const r of rows) lines.push(COLUMNS.map((c) => esc(r[c.key])).join(','));
    const csv = '﻿' + lines.join('\r\n'); // BOM — 엑셀에서 한글 정상 표시
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bids_${stamp}.csv"`);
    return res.status(200).send(csv);
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = '나라장터 입찰공고 모니터';
  wb.created = now;

  // ── 요약 시트 ──
  const sum = wb.addWorksheet('요약');
  sum.getCell('A1').value = '품목별 유효 입찰공고 현황';
  sum.getCell('A1').font = { name: 'Arial', size: 14, bold: true };
  sum.getCell('A2').value = `조회기준시각: ${displayKst(now)} (KST) · 입찰마감일시가 이 시각 이후인 공고만 수록`;
  sum.getCell('A2').font = { name: 'Arial', size: 9, color: { argb: 'FF666666' } };
  sum.getCell('A3').value = String(body?.meta?.scope || '');
  sum.getCell('A3').font = { name: 'Arial', size: 9, color: { argb: 'FF666666' } };

  const heads = ['품목', '유효 공고 수', '마감임박', '추정가격 합계(원)'];
  heads.forEach((h, i) => {
    const cell = sum.getCell(5, i + 1);
    cell.value = h;
    cell.font = { ...FONT, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
    cell.alignment = { horizontal: 'center' };
  });

  const names = itemNames.length ? itemNames : ['전체'];
  let r = 6;
  for (const name of names) {
    const subset = rows.filter((x) => (x.itemLabel || '').split(', ').includes(name));
    sum.getCell(r, 1).value = name;
    sum.getCell(r, 2).value = subset.length;
    sum.getCell(r, 3).value = subset.filter((x) => x.imminent).length;
    sum.getCell(r, 4).value = subset.reduce((s, x) => s + (x.estPrice || 0), 0);
    sum.getCell(r, 4).numFmt = '#,##0';
    for (let c = 1; c <= 4; c++) sum.getCell(r, c).font = { ...FONT };
    r++;
  }
  // 합계는 수식으로 — 시트를 손봐도 다시 계산되도록
  sum.getCell(r, 1).value = '합계';
  for (let c = 2; c <= 4; c++) {
    const L = String.fromCharCode(64 + c);
    sum.getCell(r, c).value = { formula: `SUM(${L}6:${L}${r - 1})` };
    sum.getCell(r, c).font = { ...FONT, bold: true };
    if (c === 4) sum.getCell(r, c).numFmt = '#,##0';
  }
  sum.getCell(r, 1).font = { ...FONT, bold: true };
  sum.columns = [{ width: 20 }, { width: 15 }, { width: 12 }, { width: 22 }];

  const note = sum.getCell(r + 2, 1);
  note.value = '※ 품목이 둘 이상 매칭된 공고는 각 품목에 중복 계상됩니다. 본 자료는 생성 시점 스냅샷이며, 투찰 전 원문 공고를 반드시 확인하십시오.';
  note.font = { name: 'Arial', size: 9, italic: true, color: { argb: 'FF777777' } };

  // ── 전체 + 품목별 시트 ──
  styleSheet(wb.addWorksheet('전체'), rows);
  names.forEach((name, i) => {
    const subset = rows.filter((x) => (x.itemLabel || '').split(', ').includes(name));
    styleSheet(wb.addWorksheet(safeSheetName(name, `품목${i + 1}`)), subset);
  });

  const buf = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="bids_${stamp}.xlsx"`);
  return res.status(200).send(Buffer.from(buf));
}
