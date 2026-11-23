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
  test('project open_sites: 사이트 2개가 자기 탭 2개로 열리고, 하루 기록에 한 줄, 서버가 끝나면 닫힌다', async () => {
    const tag = `${RUN}-sites`;
    const tmp2 = await makeTempHome();
    const home2 = new MemoryHome(tmp2.dir);
    const d2 = createJxaDriver(); // 따로 둔 드라이버: 이 시험이 연 탭만 닫는다(위 시험의 탭과 섞이지 않는다)
    const srv2 = createSafariServer(d2, { home: home2 });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await srv2.server.connect(a);
    const client2 = new Client({ name: 'it', version: '0' });
    await client2.connect(b);
    const mine = async () => (await d2.listTabs()).filter((t) => t.url.includes(tag));
    const proj = (args: Record<string, unknown>) => client2.callTool({ name: 'project', arguments: args });
    try {
      const urls = [`${fixture('search.html')}?${tag}`, `${fixture('form.html')}?${tag}`];
      expect(textOf(await proj({ action: 'create', name: '이사 준비', text: '시험' }))).toContain('이사 준비');
      await proj({ action: 'open', name: '이사 준비' });
      await proj({ action: 'update', section: '사이트', text: urls.join('\n') });
      expect(await mine()).toHaveLength(0);

      const r = await proj({ action: 'open_sites' });
      expect(r.isError).toBeFalsy();
      expect(textOf(r)).toContain('2개');
      expect(await mine()).toHaveLength(2); // 우리가 연 탭만 센다(사용자 탭은 건드리지 않는다)
      expect((await mine()).every((t) => t.owned)).toBe(true);

      const day = (await home2.read(`기억/일지/${localDate(new Date())}-${machineName()}.md`))!.trim().split('\n');
      expect(day).toHaveLength(1);
      expect(day[0]).toMatch(/「프로젝트 사이트 열기」 — http:\/\/127\.0\.0\.1:\d+\/search\.html, http:\/\/127\.0\.0\.1:\d+\/form\.html · 성공 · 프로젝트: 이사 준비$/);
      const rec = (await home2.read(`프로젝트/이사 준비/기록-${machineName()}.md`))!.trim().split('\n');
      expect(rec).toHaveLength(1);
      expect(rec[0]).toMatch(/^- \d{4}-\d\d-\d\d \d\d:\d\d 「프로젝트 사이트 열기」/);

      await srv2.shutdown(); // 서버가 끝나면 우리가 연 탭이 닫힌다
      expect(await mine()).toHaveLength(0);
    } finally {
      await client2.close();
      await srv2.shutdown().catch(() => {});
      for (const t of (await d2.listTabs().catch(() => [])).filter((x) => x.url.includes(tag)).reverse()) await d2.closeTab(t.key).catch(() => {});
      await d2.close();
      await tmp2.remove();
    }
  }, 90_000);
});
