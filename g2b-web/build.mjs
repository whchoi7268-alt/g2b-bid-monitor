/**
 * 배포용 산출물 생성 — dist/
 *   · api/*.js  → esbuild --minify (ESM 유지)
 *   · index.html → <style>·<script> 최소화 후 스크립트를 /app.js 로 분리
 *
 * 왜 필요한가: Vercel 배포 도구가 "전체 파일 트리"를 한 번에 받으므로
 * 원본(약 124KB)은 1회 전송 한도를 넘는다. 최소화하면 약 87KB로 줄어 안전하다.
 *
 *   node build.mjs        → dist/ 생성
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const DIST = path.join(ROOT, 'dist');
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, 'api'), { recursive: true });

const esbuild = (args) => execFileSync('npx', ['--yes', 'esbuild', ...args], { stdio: 'pipe' });

for (const f of fs.readdirSync(path.join(ROOT, 'api'))) {
  if (!f.endsWith('.js')) continue;
  esbuild([path.join(ROOT, 'api', f), '--format=esm', '--platform=node',
    '--minify', '--charset=utf8', '--legal-comments=none',
    `--outfile=${path.join(DIST, 'api', f)}`]);
}

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const grab = (tag) => html.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
const css = grab('style'), js = grab('script');

fs.writeFileSync('/tmp/_b.css', css[1]);
esbuild(['/tmp/_b.css', '--minify', '--charset=utf8', '--outfile=/tmp/_b.min.css']);
fs.writeFileSync('/tmp/_b.js', js[1]);
esbuild(['/tmp/_b.js', '--minify', '--charset=utf8', '--outfile=/tmp/_b.min.js']);

html = html.replace(css[1], fs.readFileSync('/tmp/_b.min.css', 'utf8'));
html = html.replace(js[0], '<script src="/app.js"></script>');
html = html.replace(/<!--[\s\S]*?-->/g, '').replace(/\n[ \t]+/g, '\n').replace(/\n{2,}/g, '\n');

fs.writeFileSync(path.join(DIST, 'index.html'), html);
fs.writeFileSync(path.join(DIST, 'app.js'), fs.readFileSync('/tmp/_b.min.js', 'utf8'));
for (const f of ['package.json', 'vercel.json']) {
  fs.copyFileSync(path.join(ROOT, f), path.join(DIST, f));
}

const files = ['package.json', 'vercel.json', 'index.html', 'app.js',
  ...fs.readdirSync(path.join(DIST, 'api')).map((f) => 'api/' + f)];
const total = files.reduce((s, f) => s + fs.readFileSync(path.join(DIST, f), 'utf8').length, 0);
console.log(`dist/ ${files.length}개 파일 · ${total.toLocaleString()}자`);
files.forEach((f) => console.log('  ' + f));
