import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { createJxaDriver } from '../../src/driver/jxa-driver.js';
import type { SafariDriver, TabInfo } from '../../src/driver/types.js';
import { createGateFromEnv } from '../../src/gate/gate.js';
import { createReplSession, type ReplSession } from '../../src/repl/context.js';
import { describeIt, fixture, startFixtures, stopFixtures } from '../helpers/it.js';

// 이 파일이 연 탭에만 붙는 꼬리표(it=…). 시험은 이 꼬리표가 든 탭만 만지고 닫는다(사용자 탭은 건드리지 않는다).
vi.setConfig({ testTimeout: 40_000, hookTimeout: 30_000 });

const RUN = `it=gate-${process.pid}-${Date.now()}`;
let seq = 0;
const mine = (name: string) => `${fixture(name)}?${RUN}&n=${seq++}`;
const isMine = (t: TabInfo) => t.url.includes(RUN);

type Line = Record<string, unknown>;

/** 시험용 관문 서버(앱 대신). 한 줄 JSON 요청을 받아 allow 함수의 답을 한 줄로 돌려준다. */
async function startGateServer(allow: (req: Line) => boolean): Promise<{ path: string; requests: Line[]; close(): Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'sa-gate-'));
  const path = join(dir, 'g.sock');
  const requests: Line[] = [];
  const conns = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    conns.add(sock);
    sock.on('close', () => conns.delete(sock));
    sock.on('error', () => undefined);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (c: string) => {
      buf += c;
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const req = JSON.parse(buf.slice(0, nl)) as Line;
        buf = buf.slice(nl + 1);
        requests.push(req);
        const ok = allow(req);
        sock.write(JSON.stringify(ok ? { id: req.id, allow: true } : { id: req.id, allow: false, reason: '시험이 거절했어요' }) + '\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    path,
    requests,
    close: async () => {
      for (const c of conns) c.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const TOKEN = 'ab'.repeat(32);

describeIt('동작 관문(실제 사파리 · 자기 탭만)', () => {
  let d: SafariDriver;
  let session: ReplSession | undefined;
  let gateServer: Awaited<ReturnType<typeof startGateServer>> | undefined;

  beforeAll(async () => {
    await startFixtures();
    d = createJxaDriver();
  });

  async function closeMine(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      const found = (await d.listTabs()).find(isMine);
      if (!found) return;
      await d.closeTab(found.key);
    }
  }

  afterEach(async () => {
    try {
      await session?.dispose(); // 세션이 연 탭을 닫는다
    } finally {
      session = undefined;
      await gateServer?.close();
      gateServer = undefined;
      await closeMine();
    }
  });
  afterAll(async () => {
    try {
      await closeMine();
      expect((await d.listTabs()).filter(isMine)).toEqual([]); // 이 파일이 연 탭이 하나도 남지 않았다
    } finally {
      await d.close();
      await stopFixtures();
    }
  });

  /** 관문 서버 + 그 관문을 쓰는 서버 세션을 만들고, 자기 탭에 관문 시험 페이지를 연다. */
  async function setup(allow: (req: Line) => boolean): Promise<{ key: string }> {
    gateServer = await startGateServer(allow);
    const gate = createGateFromEnv({ SAFARI_ATTRACTION_GATE: gateServer.path, SAFARI_ATTRACTION_GATE_TOKEN: TOKEN });
    expect(gate).not.toBeNull();
    session = createReplSession(d, { gate });
    const r = await session.run(`await openTab(${JSON.stringify(mine('gate.html'))}); console.log(page.key)`);
    expect(r.error).toBeUndefined();
    return { key: r.output.split('\n').pop()! };
  }
  const read = (key: string, expr: string) => d.runJs(key, expr); // 관문을 거치지 않는 직접 읽기(드라이버)

  test('「결제하기」 클릭은 되돌릴 수 없음으로 묻고, 거절하면 ACTION_DENIED · 안 눌림, 허락하면 눌린다', async () => {
    let allowPay = false;
    const { key } = await setup(() => allowPay);

    const denied = await session!.run(`await page.click('#pay')`);
    expect(denied.errorCode).toBe('ACTION_DENIED');
    expect(denied.error).toContain('사용자가 거절했어요: 시험이 거절했어요');
    expect(await read(key, 'String(window.__paid)')).toBe('0'); // 안 눌렸다

    const asked = gateServer!.requests.filter((q) => q.action === 'click');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ v: 1, token: TOKEN, host: '127.0.0.1', action: 'click', target: '결제하기', irreversible: true });

    allowPay = true; // 허락으로 한 번 더
    const ok = await session!.run(`await page.click('#pay')`);
    expect(ok.error).toBeUndefined();
    expect(await read(key, 'String(window.__paid)')).toBe('1'); // 눌렸다
    expect(gateServer!.requests.filter((q) => q.action === 'click')).toHaveLength(2);
  });

  test('보통 단추는 irreversible:false 로 묻고, 비밀번호 칸 값은 (비밀) 로만 간다', async () => {
    const { key } = await setup(() => true);
    expect((await session!.run(`await page.click('#plain')`)).error).toBeUndefined();
    expect(await read(key, 'String(window.__plain)')).toBe('1');
    expect((await session!.run(`await page.fill('#pw', 'hunter2-secret')`)).error).toBeUndefined();

    const [click, fill] = gateServer!.requests.filter((q) => q.action === 'click' || q.action === 'fill');
    expect(click).toMatchObject({ action: 'click', target: '그냥 누르기', irreversible: false });
    expect(fill).toMatchObject({ action: 'fill', value: '(비밀)', irreversible: false });
    expect(JSON.stringify(gateServer!.requests)).not.toContain('hunter2'); // 값이 관문 줄에 없다
  });

  test('읽기 전용으로 확실하지 않은 evaluate 는 irreversible:null 로 묻고 거절되면 실행되지 않는다', async () => {
    const { key } = await setup((req) => req.action !== 'evaluate');
    const r = await session!.run(`await page.evaluate(() => { window.__paid = 1; return 1 })`);
    expect(r.errorCode).toBe('ACTION_DENIED');
    expect(await read(key, 'String(window.__paid)')).toBe('0');
    const ev = gateServer!.requests.filter((q) => q.action === 'evaluate');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ irreversible: null });
  });

  test('관문이 없으면(환경값 없음) 묻지 않고 지금처럼 바로 눌린다', async () => {
    expect(createGateFromEnv({})).toBeNull();
    session = createReplSession(d, { gate: createGateFromEnv({}) });
    const r = await session.run(`await openTab(${JSON.stringify(mine('gate.html'))}); console.log(page.key); await page.click('#pay')`);
    expect(r.error).toBeUndefined();
    expect(await read(r.output.split('\n')[0]!, 'String(window.__paid)')).toBe('1');
  });
});
