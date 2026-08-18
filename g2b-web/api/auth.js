/** 비밀번호 로그인 / 로그아웃 */
import crypto from 'node:crypto';
import { authToken, readJsonBody } from './_lib.js';

const MAX_AGE = 60 * 60 * 12; // 12시간

export default function handler(req, res) {
  const expected = authToken();

  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', 'g2b_auth=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  }

  if (!expected) {
    return res.status(503).json({
      error: 'NOT_CONFIGURED',
      message:
        '환경변수 APP_PASSWORD 가 설정되지 않았습니다. Vercel → Settings → Environment Variables 에서 추가한 뒤 재배포하세요.',
    });
  }

  const { password = '' } = readJsonBody(req);
  const given = crypto.createHash('sha256').update(`g2b::${password}`).digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    return res.status(401).json({ error: 'BAD_PASSWORD', message: '비밀번호가 일치하지 않습니다.' });
  }

  res.setHeader(
    'Set-Cookie',
    `g2b_auth=${expected}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`
  );
  return res.status(200).json({ ok: true });
}
