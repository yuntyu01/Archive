// KoDeploy 시연 영상 녹화 - 실제 app.kodeploy.com에서 배포 한 번을 처음부터 끝까지 찍는다.
//
//   node record.mjs login    처음 한 번. 브라우저가 열리면 GitHub로 로그인하고 창을 닫는다 (profile/에 남음)
//   node record.mjs record   시나리오를 돌리며 녹화 → out/frames/*.jpg(1920×1080), out/frames.json, out/timeline.json
//   node record.mjs edit     빌드 구간만 빨리 감아 30초 안팎으로 → ../../public/capstone/demo.mp4
//   node record.mjs all      record 다음 edit
//
// 시나리오 (웹 코드 기준: web/src/components/deploy/*)
//   1 저장소     /deploy 마법사 1단계에 저장소 링크 입력 → 브랜치 선택 → "다음: 실행 환경"
//   2 실행 환경  앱 이름 입력 → 런타임(pom.xml로 Java 자동 추정, 아니면 직접 고름) → DB 선택 → "다음: 최종 확인"
//   3 배포       "배포 시작" → /apps/<id>/deploy/progress 에서 "앱이 준비됐어요"까지 기다림 (이 구간을 빨리 감음)
//   4 접속       https://<앱 이름>.kodeploy.com 열기 (영상엔 주소창이 안 찍혀서 주소 띠를 화면에 얹는다)
//   5 DB 확인    작업 공간 → 데이터베이스 터미널에서 SHOW TABLES; (Spring이 만든 테이블이 보임)
//
// 환경변수 (전부 선택)
//   KD_BASE        https://app.kodeploy.com
//   KD_REPO        https://github.com/yuntyu01/kodeploy-test-spring
//   KD_BRANCH      master
//   KD_APP_NAME    capstone-demo      소문자·숫자·하이픈. 이미 있는 앱 이름이면 실패하니 지우거나 바꾼다
//   KD_DB          MySQL 8.4          배포 폼 DB 드롭다운에 보이는 이름 그대로
//   KD_SQL         SHOW TABLES;
//   KD_TARGET      30                 완성 영상 목표 길이(초). 빌드 구간을 여기에 맞춰 줄인다
//   KD_OUT         ../../public/capstone/demo.mp4
//   KD_W, KD_H     1280, 720          브라우저 화면 크기(CSS px). 작을수록 화면 속 글씨가 크게 찍힌다
//   KD_SCALE       1.5                화면 배율. W×H×배율이 실제 녹화 픽셀 (기본 1280×720×1.5 = 1920×1080)
//   KD_APP_URL     https://<KD_APP_NAME>.kodeploy.com   커스텀 도메인을 보여 주고 싶을 때
//   KD_HEADLESS    0                  1이면 창 없이 녹화 (로그인은 창이 있어야 한다)

import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = (k, d) => (process.env[k] ?? '').trim() || d;
const BASE = env('KD_BASE', 'https://app.kodeploy.com').replace(/\/$/, '');
const REPO = env('KD_REPO', 'https://github.com/yuntyu01/kodeploy-test-spring');
const BRANCH = env('KD_BRANCH', 'master');
const APP = env('KD_APP_NAME', 'capstone-demo');
const DB = env('KD_DB', 'MySQL 8.4');
const SQL = env('KD_SQL', 'SHOW TABLES;');
const TARGET = Number(env('KD_TARGET', '30'));
const OUT = path.resolve(HERE, env('KD_OUT', '../../public/capstone/demo.mp4'));
const W = Number(env('KD_W', '1280')), H = Number(env('KD_H', '720'));
const DSF = Number(env('KD_SCALE', '1.5'));
const APP_URL = env('KD_APP_URL', `https://${APP}.kodeploy.com`);
const HEADLESS = env('KD_HEADLESS', '0') === '1';
const PROFILE = path.join(HERE, 'profile');
const OUTDIR = path.join(HERE, 'out');
const BUILD_TIMEOUT = 25 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

// 영상에는 마우스 커서가 안 찍힌다. 보이는 커서와 클릭 물결을 페이지에 그린다.
const CURSOR = `(() => {
  if (window.__kdCursor) return; window.__kdCursor = true;
  const add = () => {
    const c = document.createElement('div');
    c.id = '__kd_cursor';
    c.style.cssText = 'position:fixed;left:-40px;top:-40px;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;' +
      'background:rgba(255,255,255,.9);border:2px solid #1f2328;box-shadow:0 2px 8px rgba(0,0,0,.35);z-index:2147483647;pointer-events:none;transition:transform .12s';
    document.documentElement.appendChild(c);
    addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', (e) => {
      c.style.transform = 'scale(.75)';
      const r = document.createElement('div');
      r.style.cssText = 'position:fixed;left:' + e.clientX + 'px;top:' + e.clientY + 'px;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;' +
        'border:2px solid #5b84d6;z-index:2147483646;pointer-events:none;transition:all .45s ease-out;opacity:1';
      document.documentElement.appendChild(r);
      requestAnimationFrame(() => { r.style.width = r.style.height = '56px'; r.style.margin = '-28px 0 0 -28px'; r.style.opacity = '0'; });
      setTimeout(() => r.remove(), 500);
    }, true);
    addEventListener('mouseup', () => { c.style.transform = ''; }, true);
  };
  if (document.documentElement) add(); else addEventListener('DOMContentLoaded', add);
})();`;

// 화면에 얹는 띠: 빨리 감기 표시, 주소 표시
function overlay(page, id, html, css) {
  return page.evaluate(([id, html, css]) => {
    document.getElementById(id)?.remove();
    const d = document.createElement('div');
    d.id = id; d.innerHTML = html;
    d.style.cssText = 'position:fixed;z-index:2147483640;pointer-events:none;font:700 18px Pretendard,-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;' + css;
    document.documentElement.appendChild(d);
  }, [id, html, css]);
}
const unoverlay = (page, id) => page.evaluate((id) => document.getElementById(id)?.remove(), id).catch(() => {});

// 커서를 천천히 옮겨서 누른다 (영상에서 무엇을 눌렀는지 보이게)
async function press(page, locator, { pause = 350 } = {}) {
  await locator.waitFor({ state: 'visible' });
  await locator.scrollIntoViewIfNeeded();
  const b = await locator.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 18 });
  await sleep(pause);
  await page.mouse.down(); await sleep(70); await page.mouse.up();
}
async function typeInto(page, locator, text) {
  await press(page, locator, { pause: 200 });
  await locator.fill('');
  await locator.pressSequentially(text, { delay: 28 });
}
// 마법사의 드롭다운(wizardParts.jsx Select): 버튼 → role=listbox 안의 role=option
async function choose(page, id, optionName) {
  const btn = page.locator('#' + id);
  if ((await btn.innerText()).trim() === optionName) return;   // "Java"와 "JavaScript"를 헷갈리지 않게 정확히 비교
  await press(page, btn);
  await press(page, page.getByRole('option', { name: optionName, exact: true }));
}

// 녹화기 - Playwright 내장 녹화와 Chrome 스크린캐스트는 화면 배율을 무시하고 CSS 크기(1280×720)로만 찍는다.
// 배율을 준 스크린샷(clip.scale)만 실제 픽셀(1920×1080)로 선명하게 나와서, CDP 스크린샷을 계속 찍어 프레임으로 쌓는다.
//   live  초당 20장 목표 (입력·클릭·화면 전환)
//   slow  1.5초에 한 장 (빌드를 기다리는 몇 분 - 어차피 빨리 감는 구간)
async function recorder(ctx, page) {
  const dir = path.join(OUTDIR, 'frames');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const frames = [];
  const cdp = await ctx.newCDPSession(page);
  let n = 0, mode = 'off', loop = null;
  // 페이지를 옮기는 순간에는 캡처 요청이 응답 없이 멈출 수 있어서, 0.8초 넘게 걸리면 버리고 다음 장으로 간다
  const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);
  async function grab() {
    const s = Date.now();
    try {
      // 이 CDP 연결에는 Playwright의 배율 설정이 안 걸려 있어서 clip.scale로 배율을 준다.
      // clip은 문서 좌표라 스크롤된 만큼 옮긴다 (보이는 화면을 찍는다)
      const m = await within(cdp.send('Page.getLayoutMetrics'), 800);
      const vv = m.cssVisualViewport || m.visualViewport || { pageX: 0, pageY: 0 };
      const { data } = await within(cdp.send('Page.captureScreenshot', {
        format: 'jpeg', quality: 90, optimizeForSpeed: true,
        clip: { x: vv.pageX, y: vv.pageY, width: W, height: H, scale: DSF },
      }), 800);
      const f = `f${String(++n).padStart(6, '0')}.jpg`;
      fs.writeFileSync(path.join(dir, f), Buffer.from(data, 'base64'));
      frames.push({ f, t: (s + Date.now()) / 2000 });
    } catch { /* 페이지를 옮기는 순간에는 실패할 수 있다 - 다음 장으로 */ }
  }
  async function run() {
    while (mode !== 'off') {
      const s = Date.now();
      await grab();
      const rest = (mode === 'live' ? 50 : 1500) - (Date.now() - s);
      if (rest > 0) await sleep(rest);
    }
  }
  const go = (m) => { mode = m; if (!loop) loop = run().finally(() => { loop = null; }); };
  return {
    frames,
    live: () => go('live'),
    slow: () => go('slow'),
    async off() { mode = 'off'; if (loop) await loop; },
  };
}

async function login() {
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, viewport: { width: W, height: H }, deviceScaleFactor: DSF });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(BASE + '/deploy');
  log('브라우저에서 GitHub로 로그인한 뒤 창을 닫으세요. 로그인 상태는 profile/ 폴더에 남습니다.');
  await new Promise((r) => ctx.on('close', r));
}

const FF_BADGE = '<svg width="22" height="16" viewBox="0 0 22 16" style="flex:none"><path d="M1 1l9 7-9 7zM11 1l9 7-9 7z" fill="#fff"/></svg><span>빌드 구간 빨리 감기</span>';

async function record() {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: HEADLESS,
    viewport: { width: W, height: H },
    deviceScaleFactor: DSF,
  });
  await ctx.addInitScript(CURSOR);
  const page = ctx.pages()[0] || (await ctx.newPage());
  const rec = await recorder(ctx, page);
  const now = () => Date.now() / 1000;
  const tl = { app: APP, repo: REPO, size: [Math.round(W * DSF), Math.round(H * DSF)] };
  let failed = null;

  try {
    // 1 저장소
    await page.goto(BASE + '/deploy', { waitUntil: 'domcontentloaded' });
    const repo = page.locator('#wz-repo');
    try { await repo.waitFor({ timeout: 20000 }); }
    catch { throw new Error('배포 폼이 안 보여요. 먼저 `node record.mjs login`으로 로그인하세요.'); }
    await page.mouse.move(W / 2, H / 2);
    rec.live();
    await sleep(1200);
    tl.start = now();
    log('1 저장소 입력');
    await typeInto(page, repo, REPO);
    await page.locator('#wz-branch').waitFor();
    await sleep(1500);                                   // 저장소 확인 · 브랜치 목록 · 런타임 추정이 끝날 시간
    const branch = page.locator('#wz-branch');
    if ((await branch.evaluate((el) => el.tagName)) === 'BUTTON') await choose(page, 'wz-branch', BRANCH);
    else if ((await branch.inputValue()) !== BRANCH) await typeInto(page, branch, BRANCH);
    const next1 = page.getByRole('button', { name: '다음: 실행 환경' });
    await next1.waitFor(); await page.waitForFunction((el) => !el.disabled, await next1.elementHandle(), { timeout: 30000 });
    await press(page, next1);

    // 2 실행 환경
    log('2 실행 환경');
    await typeInto(page, page.locator('#wz-name'), APP);
    await sleep(500);
    await choose(page, 'wz-runtime', 'Java');           // 보통은 pom.xml로 이미 Java
    await choose(page, 'wz-db', DB);
    await sleep(700);
    await press(page, page.getByRole('button', { name: '다음: 최종 확인' }));

    // 3 배포
    log('3 배포 시작');
    await sleep(1400);
    await press(page, page.getByRole('button', { name: '배포 시작' }));
    await page.waitForURL(/\/apps\/[^/]+\/deploy\/progress/, { timeout: 60000 });
    tl.appId = page.url().match(/\/apps\/([^/]+)\//)[1];
    await sleep(2500);                                   // 4단계 표시와 로그가 뜨는 모습은 정상 속도로
    await overlay(page, '__kd_ff', FF_BADGE,
      'left:24px;bottom:24px;display:flex;align-items:center;gap:10px;white-space:nowrap;padding:10px 20px 10px 16px;border-radius:999px;background:rgba(31,35,40,.9);color:#fff');
    tl.buildStart = now();
    rec.slow();
    log('빌드 기다리는 중 (최대 25분)…');
    const ready = page.getByText('앱이 준비됐어요', { exact: false });
    const fail = page.getByText(/빌드가 실패했어요|배포가 중지됐어요/);
    while (true) {
      if (await ready.first().isVisible().catch(() => false)) break;
      if (await fail.first().isVisible().catch(() => false)) throw new Error('빌드가 실패했어요. 진행 화면의 AI 분석을 확인하세요.');
      if (now() - tl.buildStart > BUILD_TIMEOUT / 1000) throw new Error('빌드가 25분 안에 안 끝났어요.');
      await sleep(1500);
    }
    await unoverlay(page, '__kd_ff');
    tl.buildEnd = now();
    rec.live();
    log('빌드 완료');
    await sleep(2500);                                   // "완료" 체크와 상태 문구를 보여 준다

    // 4 접속
    log('4 앱 주소 열기');
    const appUrl = APP_URL;
    await page.goto(appUrl, { waitUntil: 'load', timeout: 60000 });
    await overlay(page, '__kd_url', `<span style="color:#2f9e63">●</span> ${appUrl.replace(/^(https?:\/\/)/, '<span style="opacity:.55">$1</span>')}`,
      'left:50%;top:18px;transform:translateX(-50%);display:flex;gap:10px;align-items:center;white-space:nowrap;padding:10px 22px;border-radius:12px;background:#fff;color:#1f2328;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.25);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:20px');
    await page.mouse.move(W * 0.6, H * 0.55, { steps: 12 });
    await sleep(4200);

    // 5 DB 확인
    log('5 DB 터미널');
    await page.goto(`${BASE}/apps/${tl.appId}/workspace?panel=db`, { waitUntil: 'domcontentloaded' });
    const term = page.locator('.xterm').first();
    await term.waitFor({ timeout: 30000 });
    await page.getByText('DB 연결됨').first().waitFor({ timeout: 30000 }).catch(() => {});
    await sleep(1800);                                   // mysql 프롬프트가 뜰 시간
    await press(page, term);
    await page.keyboard.type(SQL, { delay: 45 });
    await page.keyboard.press('Enter');
    await sleep(3500);
    tl.end = now();
  } catch (e) {
    failed = e;
    tl.end = now();
    await page.screenshot({ path: path.join(OUTDIR, 'error.png') }).catch(() => {});
  }

  await rec.off();
  await ctx.close();
  rec.frames.sort((x, y) => x.t - y.t);
  fs.writeFileSync(path.join(OUTDIR, 'frames.json'), JSON.stringify(rec.frames));
  fs.writeFileSync(path.join(OUTDIR, 'timeline.json'), JSON.stringify(tl, null, 2));
  if (failed) { console.error('녹화 중단:', failed.message, '\n화면: out/error.png'); process.exit(1); }
  log(`녹화 끝 → out/frames (${rec.frames.length}장)`);
}

// H.264 인코더: libx264가 없으면 openh264를 높은 비트레이트로 (낮은 비트레이트면 화면 글씨가 뭉개진다)
function h264() {
  const enc = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout || '';
  if (/\blibx264\b/.test(enc)) return ['-c:v', 'libx264', '-crf', '16', '-preset', 'slow', '-profile:v', 'high', '-tune', 'stillimage'];
  if (/\blibopenh264\b/.test(enc)) return ['-c:v', 'libopenh264', '-b:v', '10M', '-maxrate', '14M'];
  throw new Error('ffmpeg에 H.264 인코더(libx264 또는 libopenh264)가 없어요. libx264가 들어 있는 ffmpeg를 설치하세요.');
}

function edit() {
  const frames = JSON.parse(fs.readFileSync(path.join(OUTDIR, 'frames.json'), 'utf8'));
  const tl = JSON.parse(fs.readFileSync(path.join(OUTDIR, 'timeline.json'), 'utf8'));
  if (!frames.length || tl.buildStart == null || tl.buildEnd == null) throw new Error('out/frames.json, timeline.json이 없어요. record부터 하세요.');
  // 프레임마다 다음 프레임까지 머무는 시간을 적은 목록 → ffmpeg concat
  const t0 = frames[0].t;
  const list = frames.map((fr, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].t : tl.end;
    return `file 'frames/${fr.f}'\nduration ${Math.max(0.001, next - fr.t).toFixed(4)}`;
  });
  list.push(`file 'frames/${frames[frames.length - 1].f}'`);   // concat은 마지막 항목의 duration을 무시해서 한 번 더 넣는다
  fs.writeFileSync(path.join(OUTDIR, 'frames.txt'), list.join('\n') + '\n');
  const rel = (t) => Math.max(0, t - t0);
  const a = [rel(tl.start ?? t0), rel(tl.buildStart)];
  const b = [rel(tl.buildStart), rel(tl.buildEnd)];
  const c = [rel(tl.buildEnd), rel(tl.end)];
  const keep = (a[1] - a[0]) + (c[1] - c[0]);
  const bTarget = Math.max(4, TARGET - keep);            // 빌드 구간은 최소 4초는 남긴다
  const speed = Math.max(1, (b[1] - b[0]) / bTarget);
  const f = (n) => n.toFixed(3);
  const filter =
    `[0:v]fps=30,split=3[s0][s1][s2];` +
    `[s0]trim=start=${f(a[0])}:end=${f(a[1])},setpts=PTS-STARTPTS[a];` +
    `[s1]trim=start=${f(b[0])}:end=${f(b[1])},setpts=(PTS-STARTPTS)/${speed.toFixed(4)},fps=30[b];` +
    `[s2]trim=start=${f(c[0])}:end=${f(c[1])},setpts=PTS-STARTPTS[c];` +
    `[a][b][c]concat=n=3:v=1:a=0,scale=1920:1080:flags=lanczos,format=yuv420p[v]`;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const args = ['-hide_banner', '-loglevel', 'warning', '-stats', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(OUTDIR, 'frames.txt'),
    '-filter_complex', filter, '-map', '[v]', ...h264(), '-r', '30', '-movflags', '+faststart', '-an', OUT];
  log(`편집: 빌드 ${f(b[1] - b[0])}초 → ${f(bTarget)}초 (×${speed.toFixed(1)}), 완성 약 ${f(keep + bTarget)}초`);
  const r = spawnSync('ffmpeg', args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ffmpeg 실패');
  log('완성 →', OUT);
}

const cmd = process.argv[2];
try {
  if (cmd === 'login') await login();
  else if (cmd === 'record') await record();
  else if (cmd === 'edit') edit();
  else if (cmd === 'all') { await record(); edit(); }
  else console.log('사용법: node record.mjs login | record | edit | all');
} catch (e) { console.error(e.message); process.exit(1); }
