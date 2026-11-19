/**
 * 기준 측정: MCP 클라이언트로 dist/src/index.js 서버에 stdio 로 붙어(Claude 가 쓰는 길 그대로)
 * 설계서 「확인 방법」의 여섯 가지를 재고 2026-11-19 어사이드 값과 표로 비교한다.
 * 이 스크립트는 자기가 연 탭만 열고 끝에 닫는다. 깃허브는 최종 주소만 읽는다.
 * 실행: npm run build && node dist/scripts/bench.js
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = fileURLToPath(new URL("../src/index.js", import.meta.url));
const WIKI_SEOUL = "https://ko.wikipedia.org/wiki/서울특별시";
const WIKI_HOME = "https://ko.wikipedia.org/";
const GITHUB_SETTINGS = "https://github.com/settings/profile";

function frontApp(): string {
  try {
    const asn = execFileSync("lsappinfo", ["front"], { encoding: "utf8" }).trim();
    const out = execFileSync("lsappinfo", ["info", "-only", "name", asn], { encoding: "utf8" });
    return /"([^"]*)"/.exec(out)?.[1] ?? "";
  } catch {
    return "(알 수 없음)";
  }
}

interface CallResult {
  ms: number;
  text: string;
  isError: boolean;
}

const sec = (ms: number) => (ms / 1000).toFixed(2) + "초";
const num = (n: number) => n.toLocaleString("en-US");

async function main(): Promise<void> {
  const client = new Client({ name: "bench", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER] }));

  let calls = 0;
  const repl = async (title: string, code: string): Promise<CallResult> => {
    calls++;
    const t0 = performance.now();
    const r = (await client.callTool({ name: "repl", arguments: { title, code } })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    return { ms: performance.now() - t0, text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
  };

  const fronts: string[] = [];
  const mark = (label: string) => fronts.push(`${label}: ${frontApp()}`);
  const frontStart = frontApp();
  fronts.push(`시작: ${frontStart}`);

  // 0. 연결 확인(호출 수에 넣지 않는다)
  const tools = (await client.listTools()).tools.map((t) => t.name).join(", ");
  console.log(`도구: ${tools}`);

  // 1. 탭 열기 · 처음 읽기 · 다시 읽기 · 내린 뒤 읽기
  const open = await repl("서울특별시 열기", `const seoul = await openTab(${JSON.stringify(WIKI_SEOUL)}); console.log(await seoul.title())`);
  mark("탭 열기 뒤");
  // 위키백과는 다 뜬(readyState complete) 뒤에도 안내 배너를 늦게 그린다. 바로 읽으면 그 늦은 변화가 「다시 읽기」에 섞이므로
  // (사이트가 바뀐 것이지 읽기 도구가 틀린 것이 아니다) 첫 읽기 전에 1.5초 가만히 둔다. 이 대기는 측정 시간에 넣지 않는다.
  await repl("페이지 안정 대기", "await sleep(1500)");
  const first = await repl("처음 읽기", "console.log(await snapshot(seoul))");
  const again = await repl("그대로 다시 읽기", "console.log(await snapshot(seoul))");
  await repl("1000픽셀 내리기", "await seoul.evaluate('window.scrollBy(0, 1000)'); await sleep(300)");
  const scrolled = await repl("내린 뒤 읽기", "console.log(await snapshot(seoul))");
  const full = await repl("내린 뒤 전체 글자 수", "const fullTree = (await snapshot(seoul, {full: true})).tree; console.log(fullTree.length)");
  mark("읽기 뒤");
  await repl("서울 탭 닫기", "await closeTab(seoul)");

  // 2. 에베레스트 검색 과제: 첫 화면에서 검색칸에 넣고 엔터. 실패한 시도도 모두 센다.
  calls = 0;
  const taskT0 = performance.now();
  let attempts = 0;
  let found = "";
  let landedUrl = "";
  const attemptLog: string[] = [];
  const attemptCodes = [
    // 시도 1: 열기 → 칸에 채우기 → 엔터 → 다 뜨면 주소와 고도 읽기
    `const w1 = await openTab(${JSON.stringify(WIKI_HOME)});
await w1.locator('input[name="search"]').fill('에베레스트산');
await w1.keyboard.press('Enter');
await w1.waitForLoadState();
await sleep(500);
console.log(await w1.url());
console.log(await w1.evaluate(() => { const m = document.body.innerText.match(/8,848\\.86\\s*m/); return m ? m[0] : null; }));`,
  ];
  for (const code of attemptCodes) {
    attempts++;
    const r = await repl(`에베레스트 검색 시도 ${attempts}`, code);
    attemptLog.push(`시도 ${attempts}: ${r.isError ? "오류 " : ""}${r.text.replace(/\n/g, " | ").slice(0, 200)}`);
    const m = /8,848\.86\s*m/.exec(r.text);
    if (m) {
      found = m[0];
      landedUrl = r.text.split("\n")[0] ?? "";
      break;
    }
  }
  const taskMs = performance.now() - taskT0;
  const taskCalls = calls;
  mark("검색 과제 뒤");
  await repl("검색 탭 닫기", "for (const t of [...tabs]) await closeTab(t)");

  // 3. 깃허브 로그인 확인(최종 주소만 읽는다)
  const gh = await repl("깃허브 로그인 확인", `const gh = await openTab(${JSON.stringify(GITHUB_SETTINGS)}); console.log(await gh.url()); await closeTab(gh)`);
  const ghUrl = gh.text.trim().split("\n")[0] ?? "";
  const loggedIn = !gh.isError && ghUrl.startsWith("https://github.com/") && !/\/login/.test(ghUrl);
  mark("깃허브 뒤");

  // 4. 끝 정리
  const left = await repl("남은 탭 닫기", "for (const t of [...tabs]) await closeTab(t); console.log(tabs.length)");
  await client.close();
  const frontEnd = frontApp();
  fronts.push(`끝: ${frontEnd}`);
  const frontSame = fronts.every((f) => f.endsWith(frontStart));

  const chars = (r: CallResult) => num([...r.text].length) + "자";
  const noChange = /변화 없음/.test(again.text);
  const rows: Array<[string, string, string, string]> = [
    ["탭 열기", "3.9초", sec(open.ms), open.isError ? "오류: " + open.text.slice(0, 60) : "로딩 포함"],
    ["처음 읽기", "2.4초 · 12,587자", `${sec(first.ms)} · ${chars(first)}`, first.ms <= 2400 ? "통과(≤2.4초)" : "못 맞춤(>2.4초)"],
    ["그대로 다시 읽기", "1.85초 · 20자", `${sec(again.ms)} · ${chars(again)}${noChange ? " · 「변화 없음」" : ""}`, again.ms <= 1850 && noChange ? "통과(≤1.85초 · 변화 없음)" : "못 맞춤"],
    ["1000픽셀 내린 뒤 읽기", "1.91초 · 861자", `${sec(scrolled.ms)} · 바뀐 곳 ${chars(scrolled)} (전체 ${full.text.trim()}자, ${sec(full.ms)})`, "참고"],
    ["에베레스트 검색 과제", "2번 호출 · 2.9초 · 첫 시도 성공", `${taskCalls}번 호출 · ${sec(taskMs)} · ${found ? "성공 " + found : "실패"}`, found && taskCalls <= 3 ? "통과(≤3호출 · 8,848.86 m)" : "못 맞춤"],
    ["깃허브 로그인", "(해당 없음)", loggedIn ? `로그인 그대로(${ghUrl})` : `/login 이거나 실패(${ghUrl || gh.text.slice(0, 80)})`, loggedIn ? "통과" : "못 맞춤"],
    ["앞 창", "안 가져감", frontSame ? `안 가져감(${frontStart} 그대로)` : "바뀜: " + fronts.join(" / "), frontSame ? "통과" : "못 맞춤"],
  ];

  console.log("\n| 항목 | 어사이드(2026-11-19) | 사파리-어트랙션(이번) | 판정 |\n|---|---|---|---|");
  for (const [a, b, c, d] of rows) console.log(`| ${a} | ${b} | ${c} | ${d} |`);
  console.log("\n검색 과제 시도 기록:\n" + attemptLog.map((l) => "- " + l).join("\n"));
  console.log(`\n검색 과제 도착 주소: ${landedUrl}`);
  console.log("앞 앱 기록: " + fronts.join(" / "));
  console.log(`정리: 남은 탭 ${left.text.trim()}개`);
  console.log("\n--- 처음 읽기 앞부분 ---\n" + first.text.slice(0, 400));
  console.log("\n--- 다시 읽기 ---\n" + again.text.slice(0, 200));
  console.log("\n--- 내린 뒤 읽기 앞부분 ---\n" + scrolled.text.slice(0, 400));
}

main().catch((e) => {
  console.error("bench 실패:", e);
  process.exit(1);
});
