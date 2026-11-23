import { afterAll, beforeAll, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createJxaDriver } from '../../src/driver/jxa-driver.js';
import type { SafariDriver, TabInfo } from '../../src/driver/types.js';
import { MemoryHome } from '../../src/memory/home.js';
import { GUIDES, fullText } from '../../src/guides/index.js';
import { createSafariServer, type SafariServer } from '../../src/server.js';
import { describeIt } from '../helpers/it.js';
import { makeTempHome, type TempHome } from '../helpers/memory-home.js';

// 이 파일이 연 탭에만 붙는 꼬리표. 시험은 서버가 연(owned) 탭 · 이 꼬리표가 든 탭만 닫는다(사용자 탭은 건드리지 않는다).
const RUN = `it=guides-${process.pid}-${Date.now()}`;
const COUPANG = `https://www.coupang.com/?${RUN}`;
const GITHUB = `https://github.com/gulzzaang/safari-attraction?${RUN}`;
const textOf = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0]?.text ?? '';
const count = (s: string, sub: string): number => s.split(sub).length - 1;

describeIt('사이트 안내서 자동 붙이기 · guide()(진짜 사파리, 임시 기억 폴더, 공개 페이지)', () => {
  let d: SafariDriver;
  let tmp: TempHome;
  let srv: SafariServer;
  let client: Client;
  const seen = new Set<string>(); // 이 시험의 서버가 연 탭의 열쇠(owned)

  beforeAll(async () => {
    tmp = await makeTempHome();
    d = createJxaDriver();
    srv = createSafariServer(d, { home: new MemoryHome(tmp.dir) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await srv.server.connect(a);
    client = new Client({ name: 'it', version: '0' });
    await client.connect(b);
  });

  const remember = async (): Promise<void> => {
    for (const t of await d.listTabs()) if (t.owned || t.url.includes(RUN)) seen.add(t.key);
  };
  const repl = (title: string, code: string) => client.callTool({ name: 'repl', arguments: { title, code } });

  afterAll(async () => {
    try {
      await client?.close();
      await srv?.shutdown(); // 서버가 연 탭을 닫는다
      const left = (await d.listTabs()).filter((t: TabInfo) => seen.has(t.key) || t.url.includes(RUN));
      for (const t of left.reverse()) await d.closeTab(t.key).catch(() => {});
    } finally {
      await d?.close();
      await tmp?.remove();
    }
  });

  test('쿠팡 첫 화면에서 안내 한 번 → 깃허브에서 안내 → 쿠팡 다시 열면 안 붙음 → guide() 가 깃허브 전체 → 탭은 끝에 닫힘', async () => {
    // 1) 쿠팡(공개 첫 화면). 화면이 비어도 안내는 열린 주소 기준으로 붙는다.
    const r1 = await repl('쿠팡 열기', `await openTab(${JSON.stringify(COUPANG)}); console.log("열림")`);
    await remember();
    expect(r1.isError).toBeFalsy();
    const t1 = textOf(r1);
    expect(t1).toMatch(/^열림\n/);
    expect(count(t1, '… 이 사이트 안내(쿠팡):')).toBe(1);
    expect(t1).toContain('— 자세히는 guide()');
    expect(t1).not.toContain('이 사이트 안내(깃허브)');

    // 2) 같은 서버로 깃허브 저장소 쪽
    const r2 = await repl('깃허브 열기', `await openTab(${JSON.stringify(GITHUB)}); console.log(page.url().includes("github.com/gulzzaang/safari-attraction"))`);
    await remember();
    const t2 = textOf(r2);
    expect(t2).toMatch(/^true\n/);
    expect(count(t2, '… 이 사이트 안내(깃허브):')).toBe(1);
    expect(t2).not.toContain('이 사이트 안내(쿠팡)');

    // 3) 쿠팡을 다시 열면 이미 보였으니 안 붙는다
    const r3 = await repl('쿠팡 다시 열기', `await openTab(${JSON.stringify(COUPANG)}); console.log("다시 열림")`);
    await remember();
    expect(textOf(r3)).toBe('다시 열림');

    // 4) guide() 는 지금 페이지(쿠팡)가 아니라 넘긴 주소 — 깃허브 안내서 전체
    const github = GUIDES.find((g) => g.id === 'github')!;
    const r4 = await repl('깃허브 안내서 보기', 'console.log(await guide("https://github.com/gulzzaang/safari-attraction"))');
    expect(textOf(r4)).toBe(fullText(github));

    // 5) 서버가 끝나면 우리 탭은 닫힌다
    expect(seen.size).toBeGreaterThanOrEqual(2);
    await client.close();
    await srv.shutdown();
    const left = (await d.listTabs()).filter((t) => seen.has(t.key));
    for (const t of left.reverse()) await d.closeTab(t.key).catch(() => {}); // 도구 버그 대비 청소(아래에서 남았는지 알린다)
    expect(left.map((t) => t.url)).toEqual([]);
  }, 120_000);
});
