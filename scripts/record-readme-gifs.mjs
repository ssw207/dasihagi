/**
 * README 사용법 GIF — 실제 dist 확장을 로드해 스크린샷을 찍고 ffmpeg로 이어 붙인다.
 * 실행: npm run gif
 */
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, mkdtemp, mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const OUT_DIR = path.join(ROOT, 'docs', 'gif');
const PORT = 8766;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveFfmpeg() {
  const require = createRequire(import.meta.url);
  const p = require('ffmpeg-static');
  if (!p || !existsSync(p)) throw new Error('ffmpeg-static이 없습니다. npm i -D ffmpeg-static');
  return p;
}

function framesToGif(ffmpeg, frameDir, output, fps, scale) {
  execFileSync(
    ffmpeg,
    [
      '-y',
      '-framerate',
      String(fps),
      '-i',
      path.join(frameDir, '%04d.png'),
      '-vf',
      `scale=${scale}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=single[p];[s1][p]paletteuse=dither=bayer`,
      output
    ],
    { stdio: 'inherit' }
  );
}

async function snap(page, frameDir, state) {
  const file = path.join(frameDir, String(state.n).padStart(4, '0') + '.png');
  state.n += 1;
  await page.screenshot({ path: file, animations: 'disabled' });
}

async function hold(page, frameDir, state, times) {
  for (let i = 0; i < times; i++) await snap(page, frameDir, state);
}

async function typeSlow(page, selector, text, frameDir, state) {
  await page.click(selector);
  await snap(page, frameDir, state);
  for (const ch of text) {
    await page.keyboard.type(ch);
    await snap(page, frameDir, state);
  }
}

async function main() {
  if (!existsSync(path.join(DIST, 'manifest.json'))) {
    throw new Error('dist/가 없습니다. 먼저 npm run build');
  }
  const ffmpeg = resolveFfmpeg();
  await mkdir(OUT_DIR, { recursive: true });

  const pages = {
    '/': 'demo-form.html',
    '/j/home': 'journey-home.html',
    '/j/results': 'journey-results.html',
    '/j/compare': 'journey-compare.html',
    '/j/product': 'journey-product.html'
  };
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url || '/', BASE).pathname;
      const file = pages[pathname];
      if (!file) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(await readFile(path.join(ROOT, 'test', file)));
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'fp-gif-'));
  const work = await mkdtemp(path.join(os.tmpdir(), 'fp-gif-frames-'));
  const dirPreset = path.join(work, 'preset');
  const dirRecord = path.join(work, 'record');
  const dirJourney = path.join(work, 'journey');
  await mkdir(dirPreset);
  await mkdir(dirRecord);
  await mkdir(dirJourney);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 680, height: 500 },
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`]
  });

  try {
    let sw = context.serviceWorkers()[0];
    for (let i = 0; i < 80 && !sw; i++) {
      await sleep(150);
      sw = context.serviceWorkers()[0];
    }
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30000 });
    const extId = new URL(sw.url()).hostname;

    const form = await context.newPage();
    await form.setViewportSize({ width: 680, height: 500 });
    await form.goto(BASE + '/');
    await form.waitForSelector('input[name="name"]');
    await form.bringToFront();

    // 1) 프리셋 만들기
    const s1 = { n: 0 };
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 400, height: 560 });
    await form.bringToFront();
    await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
    await popup.reload();
    await popup.waitForSelector('#btn-new-preset');
    await hold(popup, dirPreset, s1, 3);
    await popup.click('#btn-new-preset');
    await popup.waitForSelector('#ed-name');
    await hold(popup, dirPreset, s1, 2);
    await typeSlow(popup, '#ed-name', '회원가입', dirPreset, s1);
    await popup.fill('#ed-pattern', `127.0.0.1:${PORT}`);
    await hold(popup, dirPreset, s1, 2);
    await popup.click('#btn-save-preset');
    await popup.waitForSelector('#toast.show');
    await hold(popup, dirPreset, s1, 6);
    await popup.close();

    // 2) 녹화 + 재생 (폼 페이지)
    const s2 = { n: 0 };
    const popup2 = await context.newPage();
    await form.bringToFront();
    await popup2.goto(`chrome-extension://${extId}/popup/popup.html`);
    await popup2.reload();
    await popup2.waitForSelector('.preset-card [data-menu-toggle]');
    await popup2.click('.preset-card [data-menu-toggle]');
    await popup2.waitForSelector('.preset-card [data-act="record"]');
    await popup2.click('.preset-card [data-act="record"]');
    await sleep(400);
    await popup2.close().catch(() => {});
    await form.bringToFront();
    await form.waitForSelector('.fp-record-chip', { timeout: 10000 });
    await hold(form, dirRecord, s2, 3);
    await typeSlow(form, 'input[name="name"]', '홍길동', dirRecord, s2);
    await typeSlow(form, 'input[name="email"]', 'hong@test.com', dirRecord, s2);
    await form.selectOption('select[name="dept"]', 'eng');
    await hold(form, dirRecord, s2, 2);
    await form.check('input[name="agree"]');
    await hold(form, dirRecord, s2, 3);
    await form.click('#fp-record-stop');
    await sleep(500);
    await hold(form, dirRecord, s2, 4);
    await form.evaluate(() => document.querySelector('form')?.reset());
    await hold(form, dirRecord, s2, 3);
    const popup3 = await context.newPage();
    await form.bringToFront();
    await popup3.goto(`chrome-extension://${extId}/popup/popup.html`);
    await popup3.reload();
    await popup3.waitForSelector('[data-act="replay"]');
    await popup3.click('[data-act="replay"]');
    await form.waitForFunction(
      () =>
        document.querySelector('input[name="name"]')?.value === '홍길동' &&
        document.querySelector('input[name="email"]')?.value === 'hong@test.com' &&
        document.querySelector('select[name="dept"]')?.value === 'eng' &&
        document.querySelector('input[name="agree"]')?.checked,
      { timeout: 25000 }
    );
    await popup3.close().catch(() => {});
    await hold(form, dirRecord, s2, 10);
    await form.close();

    // 3) 여정
    const s3 = { n: 0 };
    const journey = await context.newPage();
    await journey.setViewportSize({ width: 680, height: 500 });
    await journey.goto(BASE + '/j/home');
    await journey.waitForSelector('#q');
    const popup4 = await context.newPage();
    await journey.bringToFront();
    await popup4.goto(`chrome-extension://${extId}/popup/popup.html`);
    await popup4.reload();
    await popup4.click('#btn-new-preset');
    await popup4.fill('#ed-name', '쇼핑 여정');
    await popup4.fill('#ed-pattern', `127.0.0.1:${PORT}`);
    await popup4.click('#btn-save-preset');
    await popup4.waitForSelector('#toast.show');
    await popup4.click('#btn-record');
    await sleep(400);
    await popup4.close().catch(() => {});
    await journey.bringToFront();
    await journey.waitForSelector('.fp-record-chip', { timeout: 10000 });
    await hold(journey, dirJourney, s3, 2);
    await typeSlow(journey, '#q', '수저세트', dirJourney, s3);
    await Promise.all([journey.waitForURL(/\/j\/results/), journey.click('#search-btn')]);
    await journey.waitForSelector('.fp-record-chip', { timeout: 10000 });
    await hold(journey, dirJourney, s3, 3);
    await Promise.all([journey.waitForURL(/\/j\/compare/), journey.click('#price-more')]);
    await journey.waitForSelector('.fp-record-chip', { timeout: 10000 });
    await hold(journey, dirJourney, s3, 3);
    await typeSlow(journey, '#q2', '인기 수저세트', dirJourney, s3);
    await journey.click('#confirm-btn');
    await hold(journey, dirJourney, s3, 2);
    await Promise.all([journey.waitForURL(/\/j\/product/), journey.click('#product-1')]);
    await journey.waitForSelector('#product-id');
    await hold(journey, dirJourney, s3, 6);
    await journey.close();
  } finally {
    await context.close().catch(() => {});
    await new Promise((r) => server.close(r));
  }

  const jobs = [
    [dirPreset, '01-preset.gif', 6, 400],
    [dirRecord, '02-record-replay.gif', 8, 640],
    [dirJourney, '03-journey.gif', 7, 640]
  ];
  for (const [dir, name, fps, scale] of jobs) {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.png'));
    if (files.length === 0) throw new Error('프레임 없음: ' + name);
    const dest = path.join(OUT_DIR, name);
    framesToGif(ffmpeg, dir, dest, fps, scale);
    console.log('작성:', dest, '(' + files.length + '프레임)');
  }

  await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  await rm(work, { recursive: true, force: true }).catch(() => {});
  console.log('README GIF 완료 → ' + OUT_DIR);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
