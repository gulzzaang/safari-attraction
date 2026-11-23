import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createJxaDriver } from '../../src/driver/jxa-driver.js';
import type { SafariDriver, TabInfo } from '../../src/driver/types.js';
import { MemoryHome, localDate, machineName } from '../../src/memory/home.js';
import { siteFileName } from '../../src/memory/site.js';
import { createSafariServer, type SafariServer } from '../../src/server.js';
import { describeIt, fixture, startFixtures, stopFixtures } from '../helpers/it.js';
import { makeTempHome, type TempHome } from '../helpers/memory-home.js';

// 이 파일이 연 탭에만 붙는 꼬리표. 시험은 이 꼬리표가 든 탭만 닫는다(사용자 탭은 건드리지 않는다).
const RUN = `it=memory-${process.pid}-${Date.now()}`;
const isMine = (t: TabInfo) => t.url.includes(RUN);
const textOf = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0]?.text ?? '';

describeIt('활동 기록 · 사이트 메모 붙이기(진짜 사파리, 임시 기억 폴더)', () => {
  let d: SafariDriver;
  let tmp: TempHome;
  let home: MemoryHome;
  let srv: SafariServer;
  let client: Client;

  beforeAll(async () => {
    await startFixtures();
    tmp = await makeTempHome();
    home = new MemoryHome(tmp.dir);
    d = createJxaDriver();
    srv = createSafariServer(d, { home });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await srv.server.connect(a);
    client = new Client({ name: 'it', version: '0' });
    await client.connect(b);
  });

  async function closeMine(): Promise<void> {
    for (const t of (await d.listTabs()).filter(isMine).reverse()) await d.closeTab(t.key).catch(() => {});
  }

  afterAll(async () => {
    try {
      await client?.close();
      await srv?.shutdown(); // 우리가 연 탭을 닫는다
      await closeMine();
    } finally {
      await d?.close();
      await stopFixtures();
      await tmp?.remove();
    }
  });

  test('열기 · 엔터로 이동 · 링크 클릭 이동이 하루 기록에 쓰이고, 사이트 메모는 첫 결과 끝에만 붙는다', async () => {
    const host = new URL(fixture('search.html')).hostname; // 시험 서버 주소(127.0.0.1)
    const memo = home.path('기억/사이트', siteFileName(host));
    await mkdir(dirname(memo), { recursive: true });
    await writeFile(memo, '시험 서버 메모: 검색칸은 엔터로 제출', 'utf8');

    // 1) 열기
    const r1 = await client.callTool({
      name: 'repl',
      arguments: { title: '검색 페이지 열기', code: `await openTab(${JSON.stringify(`${fixture('search.html')}?${RUN}`)}); console.log("열림", page.url().includes("search.html"))` },
    });
    expect(r1.isError).toBeFalsy();
    expect(textOf(r1)).toBe(`열림 true\n\n… 이 사이트 메모(${host}): 시험 서버 메모: 검색칸은 엔터로 제출`);

    // 2) 엔터로 이동(page.url() 이 새 주소여야 한다) — 메모는 이미 보였으니 안 붙는다
    const r2 = await client.callTool({
      name: 'repl',
      arguments: { title: '검색하기', code: `await page.locator("#searchInput").fill("에베레스트산"); await page.keyboard.press("Enter"); console.log(page.url().includes("result.html"))` },
    });
    expect(textOf(r2)).toBe('true');

    // 3) 링크 클릭으로 이동
    const r3 = await client.callTool({
      name: 'repl',
      arguments: { title: '폼 열고 링크 누르기', code: `await openTab(${JSON.stringify(`${fixture('form.html')}?${RUN}`)}); await page.locator("#go").click(); console.log(page.url().includes("result.html"))` },
    });
    expect(textOf(r3)).toBe('true');

    const lines = (await home.read(`기억/일지/${localDate(new Date())}-${machineName()}.md`))!.trim().split('\n');
    expect(lines).toHaveLength(3);
    const base = new URL(fixture('search.html')).host; // 127.0.0.1:포트
    expect(lines[0]).toMatch(new RegExp(`^- \\d\\d:\\d\\d 「검색 페이지 열기」 — http://${base.replace(/[.]/g, '\\.')}/search\\.html · 성공$`));
    expect(lines[1]).toMatch(new RegExp(`「검색하기」 — http://${base.replace(/[.]/g, '\\.')}/result\\.html · 성공$`)); // 엔터 뒤 새 주소, 쿼리 없음
    expect(lines[2]).toMatch(new RegExp(`「폼 열고 링크 누르기」 — http://${base.replace(/[.]/g, '\\.')}/form\\.html, http://${base.replace(/[.]/g, '\\.')}/result\\.html · 성공$`));
    expect(lines.join('\n')).not.toMatch(/[?#]|it=memory/);
  }, 60_000);
});
