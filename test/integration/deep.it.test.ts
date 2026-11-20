import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { createJxaDriver } from '../../src/driver/jxa-driver.js';
import type { SafariDriver, TabInfo } from '../../src/driver/types.js';
import { Page } from '../../src/repl/page.js';
import { buildSnapshotSource } from '../../src/snapshot/inpage.js';
import { splitSnapshotMeta } from '../../src/snapshot/store.js';
import { describeIt, fixture, startFixtures, stopFixtures } from '../helpers/it.js';

// 이 파일이 연 탭에만 붙는 꼬리표. 시험은 이 꼬리표가 든 탭만 만지고 닫는다(사용자 탭은 건드리지 않는다).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const RUN = `it=deep-${process.pid}-${Date.now()}`;
let seq = 0;
const mine = (name: string) => `${fixture(name)}?${RUN}&n=${seq++}`;
const isMine = (t: TabInfo) => t.url.includes(RUN);

describeIt('iframe · shadow DOM 안쪽', () => {
  let d: SafariDriver;

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
  afterEach(closeMine);
  afterAll(async () => {
    try {
      await closeMine();
    } finally {
      await d.close();
      await stopFixtures();
    }
  });

  const open = async (name: string) => {
    const { tab } = await d.openTab(mine(name));
    return new Page(d, tab.key);
  };
  const read = async (page: Page) => splitSnapshotMeta(await d.runJs(page.key, buildSnapshotSource())).tree;
  const refOf = async (page: Page, pattern: RegExp) => {
    const snap = await read(page);
    const m = pattern.exec(snap);
    if (!m) throw new Error(`snapshot 에 없음: ${pattern}\n${snap}`);
    return m[1]!;
  };
  test('읽기에 열린 shadow root 안쪽이 나온다', async () => {
    const page = await open('shadow.html');
    const text = await read(page);
    expect(text).toMatch(/- button "안쪽 단추" \[ref=e\d+\]/);
    expect(text).toMatch(/- textbox "안쪽 입력" \[ref=e\d+\]/);
  });

  test('slot 에 배정된 바깥 단추도 한 번만 나온다', async () => {
    const page = await open('shadow.html');
    const text = await read(page);
    expect(text.match(/슬롯 단추/g)).toHaveLength(1);
  });

  test('shadow 안 단추를 ref 로 누르면 눌린다', async () => {
    const page = await open('shadow.html');
    const ref = await refOf(page, /- button "안쪽 단추" \[ref=(e\d+)\]/);
    await page.locator(ref).click();
    expect(await page.evaluate(() => document.querySelector('#out')!.textContent)).toBe('눌림');
  });

  test('이름이 slot 으로만 오는 shadow 단추는 슬롯 글을 이름으로 갖고, ref 로 누르면 눌린다', async () => {
    const page = await open('shadow.html');
    const ref = await refOf(page, /- button "보내기" \[ref=(e\d+)\]/);
    await page.locator(ref).click();
    expect(await page.evaluate(() => document.querySelector('#out2')!.textContent)).toBe('보내기 눌림');
  });

  test('안쪽 글이 없는 shadow 아이콘 단추는 호스트의 aria-label 을 이름으로 갖는다', async () => {
    const page = await open('shadow.html');
    const text = await read(page);
    expect(text).toMatch(/- button "검색 열기" \[ref=e\d+\]/);
    expect(text).not.toMatch(/- button "" \[ref=/);
    const ref = await refOf(page, /- button "검색 열기" \[ref=(e\d+)\]/);
    await page.locator(ref).click();
    expect(await page.evaluate(() => document.querySelector('#out2')!.textContent)).toBe('검색 눌림');
  });

  test('selector 로 좁혀 읽어도 slot 단추의 이름이 나온다', async () => {
    const page = await open('shadow.html');
    const text = await d.runJs(page.key, buildSnapshotSource({ selector: '#slotbtn' }));
    expect(text).toMatch(/- button "보내기" \[ref=e\d+\]/);
    const inter = await d.runJs(page.key, buildSnapshotSource({ interactive: true }));
    expect(inter).toMatch(/- button "보내기" \[ref=e\d+\]/);
  });

  test('닫힌 shadow root 는 한 줄로 알린다', async () => {
    const page = await open('shadow.html');
    const text = await read(page);
    expect(text).toContain('(닫힌 shadow root — 안쪽은 못 읽음)');
    expect(text).not.toContain('닫힌 안쪽 단추');
  });

  test('호스트 안에 공백 · 주석만 있는 닫힌 shadow root 도 한 줄로 알린다', async () => {
    const page = await open('shadow.html');
    const text = await read(page);
    expect(text).toContain('- <sa-closed-ws> (닫힌 shadow root — 안쪽은 못 읽음)');
    expect(text).toContain('- <sa-closed> (닫힌 shadow root — 안쪽은 못 읽음)');
    expect(text).not.toContain('공백 호스트 안쪽 단추');
  });

  test('Tab 은 화면 순서대로 shadow 안쪽을 지나 바깥 다음 칸으로 간다', async () => {
    const page = await open('shadow.html');
    await page.locator('#before').click(); // 앞 입력에 초점
    const active = () =>
      page.evaluate(() => {
        const host = document.querySelector('sa-card')!;
        const inner = host.shadowRoot!.activeElement;
        return inner ? 'shadow:' + (inner.tagName + ':' + (inner.getAttribute('placeholder') ?? inner.textContent)) : 'doc:' + (document.activeElement as HTMLElement).id;
      });
    expect(await active()).toBe('doc:before');
    await page.keyboard.press('Tab');
    expect(await active()).toBe('shadow:BUTTON:안쪽 단추');
    await page.keyboard.press('Tab');
    expect(await active()).toBe('shadow:INPUT:안쪽 입력');
    await page.keyboard.press('Tab');
    expect(await active()).toBe('doc:after');
  });

  test('같은 출처 iframe 안쪽이 나오고 입력 · 클릭이 된다', async () => {
    const page = await open('frames.html');
    const text = await read(page);
    expect(text).toMatch(/- textbox "프레임 입력" \[ref=e\d+\]/);
    const input = await refOf(page, /- textbox "프레임 입력" \[ref=(e\d+)\]/);
    await page.locator(input).fill('가나');
    expect(
      await page.evaluate(() => {
        const doc = (document.getElementById('same') as HTMLIFrameElement).contentDocument!;
        return (doc.querySelector('input') as HTMLInputElement).value;
      }),
    ).toBe('가나');
    const btn = await refOf(page, /- button "프레임 단추" \[ref=(e\d+)\]/);
    await page.locator(btn).click();
    expect(
      await page.evaluate(() => {
        const doc = (document.getElementById('same') as HTMLIFrameElement).contentDocument!;
        return doc.querySelector('#fout')!.textContent;
      }),
    ).toBe('프레임 눌림');
  });

  test('다른 출처 iframe 은 자리만 남긴다', async () => {
    const page = await open('frames.html');
    const text = await read(page);
    const port = /^- title: .*\[url=http:\/\/127\.0\.0\.1:(\d+)\//.exec(text.split('\n')[0]!)![1];
    expect(text).toContain(`- iframe "http://localhost:${port}" (다른 사이트라 안쪽은 못 읽음)`);
    // 같은 출처 프레임의 글은 한 번만(다른 출처 프레임 안쪽은 안 나온다)
    expect(text.match(/프레임 입력/g)).toHaveLength(1);
  });

  test('sandbox 로 막힌 같은 주소 iframe 은 「다른 사이트」가 아니라 못 읽는다고 알린다', async () => {
    const page = await open('frames.html');
    const text = await read(page);
    const origin = /\[url=(http:\/\/127\.0\.0\.1:\d+)\//.exec(text.split('\n')[0]!)![1];
    expect(text).toContain(`- iframe "${origin}" (안쪽을 읽을 수 없음)`);
    expect(text.match(/다른 사이트라 안쪽은 못 읽음/g)).toHaveLength(1); // 진짜 다른 출처 프레임 하나만
  });

  test('CSS 선택자도 shadow 안을 찾는다', async () => {
    const page = await open('shadow.html');
    await page.locator('input[placeholder="안쪽 입력"]').fill('x');
    expect(
      await page.evaluate(() => (document.querySelector('sa-card')!.shadowRoot!.querySelector('input') as HTMLInputElement).value),
    ).toBe('x');
  });

  test('selector 로 좁혀 읽기도 shadow 안을 찾는다', async () => {
    const page = await open('shadow.html');
    const text = await d.runJs(page.key, buildSnapshotSource({ selector: 'input[placeholder="안쪽 입력"]' }));
    expect(text).toMatch(/- textbox "안쪽 입력" \[ref=e\d+\]/);
    expect(text).not.toContain('안쪽 단추');
  });
});
