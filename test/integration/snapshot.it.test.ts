import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { createJxaDriver } from '../../src/driver/jxa-driver.js';
import type { SafariDriver, TabInfo } from '../../src/driver/types.js';
import { capSnapshot, SNAPSHOT_LIMIT_BYTES } from '../../src/snapshot/diff.js';
import { buildSnapshotSource, type SnapshotOptions } from '../../src/snapshot/inpage.js';
import { SnapshotStore, splitSnapshotMeta } from '../../src/snapshot/store.js';
import { describeIt, fixture, startFixtures, stopFixtures } from '../helpers/it.js';

// 이 파일이 연 탭에만 붙는 꼬리표. 시험은 이 꼬리표가 든 탭만 만지고 닫는다(사용자 탭은 건드리지 않는다).
const RUN = `it=snap-${process.pid}-${Date.now()}`;
let seq = 0;
const mine = (name: string) => `${fixture(name)}?${RUN}&n=${seq++}`;
const isMine = (t: TabInfo) => t.url.includes(RUN);

describeIt('페이지 읽기(snapshot)', () => {
  let d: SafariDriver;
  const store = new SnapshotStore();

  beforeAll(async () => {
    await startFixtures();
    d = createJxaDriver();
  });

  async function keyNow(tab: TabInfo): Promise<string> {
    const found = (await d.listTabs()).find((t) => t.url === tab.url);
    if (!found) throw new Error(`열어 둔 탭이 사라짐: ${tab.url}`);
    return found.key;
  }
  async function closeIfMine(url: string): Promise<void> {
    if (!url.includes(RUN)) return;
    const found = (await d.listTabs()).find((t) => t.url === url);
    if (found && isMine(found)) await d.closeTab(found.key);
  }
  async function closeMine(): Promise<void> {
    const urls = (await d.listTabs()).filter(isMine).map((t) => t.url);
    for (const url of urls.reverse()) await closeIfMine(url);
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

  const read = async (key: string, o: SnapshotOptions = {}) => d.runJs(key, buildSnapshotSource(o));
  const open = async (page: string) => {
    const { tab } = await d.openTab(mine(page));
    return { tab, key: await keyNow(tab) };
  };

  test('처음 읽기에 ref 가 있고 다시 읽으면 변화 없음', async () => {
    const { key } = await open('basic.html');
    const text = await read(key);
    console.log(text);
    expect(splitSnapshotMeta(text).tree.split('\n')[0]).toMatch(/^- title: "기본 시험 페이지" \[url=http:\/\/127\.0\.0\.1:\d+\/basic\.html\?/);
    expect(text).toMatch(/- button "저장" \[ref=e\d+\]/);
    expect(text).toMatch(/- link "다음으로" \[ref=e\d+\]/);
    expect(text).toMatch(/- textbox "이름을 입력" \[ref=e\d+\]/);
    expect(text).toContain('- heading "기본 시험 페이지"');
    expect(text).toContain('- paragraph "안녕하세요');
    expect(text).toContain('- listitem "첫째 항목"');
    expect(text).not.toMatch(/- paragraph[^\n]*\[ref=/); // 글 덩어리에는 ref 가 없다
    expect(text).not.toContain('숨은 단추');
    expect(text).not.toContain('가려진 단추');

    expect(store.diff(key, {}, text).mode).toBe('full');
    const again = await read(key);
    expect(again).toBe(text); // ref 번호가 그대로
    expect(store.diff(key, {}, again)).toEqual({ mode: 'none', text: '변화 없음' });
  });

  test('비밀번호 칸은 값 없이 이름만', async () => {
    const { key } = await open('basic.html');
    const text = await read(key);
    expect(text).toMatch(/- textbox "비밀번호" \[ref=e\d+\]\n/);
    expect(text).not.toContain('비밀값');
    await d.runJs(key, `document.getElementById('pw').value = '또다른비밀'; 1`);
    expect(await read(key)).not.toContain('또다른비밀');
  });

  test('바뀐 곳만: 새 요소는 + 줄, 기존 ref 는 그대로', async () => {
    const { key } = await open('basic.html');
    const before = await read(key);
    store.diff(key, {}, before);
    await d.runJs(
      key,
      `var b = document.createElement('button'); b.textContent = '새 단추'; document.body.insertBefore(b, document.getElementById('save')); 1`,
    );
    const after = await read(key);
    const r = store.diff(key, {}, after);
    expect(r.mode).toBe('diff');
    expect(r.text).toMatch(/\+ - button "새 단추" \[ref=e\d+\]/);
    const saveBefore = /- button "저장" \[ref=(e\d+)\]/.exec(before)![1];
    expect(after).toContain(`- button "저장" [ref=${saveBefore}]`); // 앞에 끼어들어도 번호가 안 바뀐다
    expect(r.text).not.toContain('"저장"');
  });

  test('입력한 값이 보이고 interactive 는 글 덩어리를 뺀다', async () => {
    const { key } = await open('basic.html');
    await d.runJs(key, `document.getElementById('name').value = '홍길동'; 1`);
    const inter = await read(key, { interactive: true });
    expect(inter).toMatch(/- textbox "이름을 입력" \[ref=e\d+\] \[value="홍길동"\]/);
    expect(inter).not.toContain('- paragraph');
    expect(inter).not.toContain('- heading');
    expect(inter).toContain('- button "저장"');
  });

  test('selector 는 CSS 선택자나 ref 로 좁힌다', async () => {
    const { key } = await open('basic.html');
    const all = await read(key);
    const ref = /- button "저장" \[ref=(e\d+)\]/.exec(all)![1]!;
    const byCss = await read(key, { selector: '#save' });
    expect(byCss).toContain(`- button "저장" [ref=${ref}]`);
    expect(byCss).not.toContain('다음으로');
    expect(await read(key, { selector: ref })).toBe(byCss);
    expect(await read(key, { selector: '#없음' })).toContain('선택자에 맞는 요소 없음');
    expect(await read(key, { selector: '###' })).toContain('선택자가 잘못됨');
  });

  test('화면 밖은 빠지고 full 이면 문서 전체', async () => {
    const { key } = await open('scroll.html');
    const view = await read(key);
    expect(view).toContain('위 단추');
    expect(view).not.toContain('아래 단추');
    const full = await read(key, { full: true });
    expect(full).toContain('위 단추');
    expect(full).toContain('아래 단추');
  });

  test('내린 뒤에는 새로 보이는 곳만, 되돌아가면 「이미 읽은 곳」', async () => {
    const { key } = await open('scroll.html');
    const first = store.diff(key, {}, await read(key));
    expect(first.mode).toBe('full');
    expect(first.text).toContain('위 단추');
    expect(first.text).not.toContain('#sa-meta');
    // 한 화면 넘게 내려 맨 아래가 보이게 한다
    await d.runJs(key, 'window.scrollTo(0, document.body.scrollHeight); 0');
    const down = store.diff(key, {}, await read(key));
    expect(down.mode).toBe('scroll');
    console.log(down.text);
    expect(down.text.split('\n')[0]).toMatch(/^# 내린 뒤 새로 보이는 곳만 \(이미 본 줄 \d+개 · 화면 밖으로 지나간 줄 \d+개 생략\)$/);
    expect(down.text).toContain('아래 단추');
    expect(down.text).not.toContain('위 단추'); // 지나간 줄은 싣지 않는다
    expect(down.text).not.toContain('# 바뀐 곳만'); // +/- 비교가 아니다
    expect(down.text).not.toMatch(/^- - |^\+ /m); // 사라짐(- ) · 생김(+ ) 줄 없음
    await d.runJs(key, 'window.scrollTo(0, 0); 0');
    const up = store.diff(key, {}, await read(key));
    expect(up).toEqual({ mode: 'scroll', text: '새로 보이는 곳 없음(이미 읽은 곳)' });
    // 같은 자리에서 다시 읽으면 변화 없음
    expect(store.diff(key, {}, await read(key))).toEqual({ mode: 'none', text: '변화 없음' });
    // 새로고침이면 본 줄을 지운다
    await d.runJs(key, 'location.reload(); 0');
    await new Promise((r) => setTimeout(r, 1500));
    expect(store.diff(key, {}, await read(key)).mode).not.toBe('scroll');
  });

  test('안쪽 스크롤 영역을 내려도 새로 보이는 곳만, 되돌리면 「이미 읽은 곳」', async () => {
    const { key } = await open('inner-scroll.html');
    const first = store.diff(key, {}, await read(key));
    expect(first.mode).toBe('full');
    expect(first.text).toContain('항목 1"');
    expect(await d.runJs(key, 'String(window.scrollY)')).toBe('0'); // 창은 안 움직인다
    const box = Number(await d.runJs(key, 'String(document.getElementById("box").clientHeight)'));
    await d.runJs(key, `document.getElementById("box").scrollTop = ${box}; 0`);
    const down = store.diff(key, {}, await read(key));
    console.log(down.text);
    expect(down.mode).toBe('scroll');
    expect(down.text.split('\n')[0]).toMatch(/^# 내린 뒤 새로 보이는 곳만 \(이미 본 줄 \d+개 · 화면 밖으로 지나간 줄 \d+개 생략\)$/);
    expect(down.text.split('\n').length).toBeGreaterThan(1);
    expect(down.text).not.toMatch(/^- - |^\+ /m);
    await d.runJs(key, 'document.getElementById("box").scrollTop = 0; 0');
    expect(store.diff(key, {}, await read(key))).toEqual({ mode: 'scroll', text: '새로 보이는 곳 없음(이미 읽은 곳)' });
  });

  test('표: 같은 글의 칸(Active · 0원)이 반복돼도 내린 뒤 새 행의 칸이 모두 나온다', async () => {
    const { key } = await open('table.html');
    const first = store.diff(key, {}, await read(key));
    expect(first.text).toContain('사용자 1 번');
    const vh = Number(await d.runJs(key, 'String(window.innerHeight)'));
    const y = 40 * Math.floor(vh / 40); // 행 높이의 배수만큼 내려 맨 위 행이 온전하게
    await d.runJs(key, `window.scrollTo(0, ${y}); 0`);
    const down = store.diff(key, {}, await read(key));
    expect(down.mode).toBe('scroll');
    const body = down.text.split('\n').slice(1);
    expect(body.length).toBeGreaterThanOrEqual(3);
    expect(body.length % 3).toBe(0);
    for (let i = 0; i < body.length; i += 3) {
      expect(body[i]).toMatch(/^- cell "사용자 \d+ 번"$/);
      expect(body[i + 1]).toMatch(/^- cell "(Active|Pending)"$/);
      expect(body[i + 2]).toBe('- cell "0원"');
    }
  });

  test('같은 문서 안에서 주소가 바뀌면(pushState) 내린 뒤 읽기 맨 앞에 새 주소 줄이 나온다', async () => {
    const { key } = await open('scroll.html');
    store.diff(key, {}, await read(key));
    await d.runJs(key, "history.pushState(null, '', '#다른곳'); window.scrollTo(0, document.body.scrollHeight); 0");
    const r = store.diff(key, {}, await read(key));
    expect(r.mode).toBe('scroll');
    const lines = r.text.split('\n');
    expect(lines[1]).toMatch(/^- title: .*#%EB%8B%A4%EB%A5%B8%EA%B3%B3|^- title: .*#다른곳/);
    expect(r.text).toContain('아래 단추');
  });

  test('저절로 움직이는 화면 밖 캐러셀 · 입력칸 스크롤은 내린 것으로 세지 않아 바뀐 곳을 +/- 로 알린다', async () => {
    const { key } = await open('autoscroll.html');
    const first = store.diff(key, {}, await read(key));
    expect(first.mode).toBe('full');
    await new Promise((r) => setTimeout(r, 300)); // 캐러셀이 움직이게
    await d.runJs(key, "var t = document.getElementById('ta'); t.value = Array(60).join('긴 줄\\n'); t.scrollTop = 50; document.getElementById('msg').textContent = '상태: 바뀜'; 0");
    const r = store.diff(key, {}, await read(key));
    expect(r.mode).toBe('diff');
    expect(r.text).toContain('- - paragraph "상태: 처음"');
    expect(r.text).toContain('+ - paragraph "상태: 바뀜"');
    expect(r.text).not.toContain('내린 뒤');
  });

  test('큰 페이지도 1초 · 16KB 안', async () => {
    const { key } = await open('big.html');
    expect(await d.runJs(key, 'document.getElementsByTagName("*").length')).toBeTruthy();
    const count = Number(await d.runJs(key, 'document.body.getElementsByTagName("*").length'));
    expect(count).toBeGreaterThanOrEqual(20000);
    await read(key); // 첫 호출(호스트 · 페이지 데우기)은 빼고
    for (const o of [{}, { full: true }, { interactive: true, full: true }]) {
      const t0 = performance.now();
      const text = await read(key, o);
      const ms = performance.now() - t0;
      const out = capSnapshot(text);
      const bytes = Buffer.byteLength(out);
      console.log(`big.html ${JSON.stringify(o)}: ${ms.toFixed(0)}ms, 원문 ${Buffer.byteLength(text)}B → ${bytes}B (요소 ${count})`);
      expect(ms).toBeLessThan(1000);
      expect(bytes).toBeLessThanOrEqual(SNAPSHOT_LIMIT_BYTES);
    }
  });
});
