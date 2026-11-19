import { afterEach, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSafariServer, type SafariServer } from "../../src/server.js";
import { SafariError } from "../../src/driver/types.js";
import { createFakeDriver, type FakeDriver } from "../helpers/fake-driver.js";

let client: Client | undefined;
let srv: SafariServer | undefined;

async function connect(d: FakeDriver) {
  srv = createSafariServer(d);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await srv.server.connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return client;
}

afterEach(async () => {
  await client?.close();
  await srv?.shutdown();
  client = undefined;
  srv = undefined;
});

const textOf = (r: unknown): string => ((r as { content: Array<{ text: string }> }).content[0]?.text) ?? "";

describe("MCP 서버", () => {
  test("도구 목록은 repl 과 status 둘", async () => {
    const c = await connect(createFakeDriver());
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["repl", "status"]);
  });

  test("repl 설명이 쓰는 법과 알려진 한계를 알려 준다", async () => {
    const c = await connect(createFakeDriver());
    const repl = (await c.listTools()).tools.find((t) => t.name === "repl")!;
    const d = repl.description ?? "";
    for (const w of ["console.log", "openTab", "attachActiveBrowserTab", "snapshot", "iframe", "개인정보 보호", "CORS", "openAiWindow", "setViewportSize", "screenshot", "display", "4장", "화면 및 시스템 오디오 녹음"]) expect(d).toContain(w);
  });

  test("repl 은 콘솔 출력을 글로 돌려준다", async () => {
    const c = await connect(createFakeDriver());
    const r = await c.callTool({ name: "repl", arguments: { title: "더하기", code: "console.log(1+2)" } });
    expect(textOf(r)).toBe("3");
    expect(r.isError).toBeFalsy();
  });

  test("repl 오류는 isError 이고 출력도 함께 준다", async () => {
    const c = await connect(createFakeDriver());
    const r = await c.callTool({ name: "repl", arguments: { title: "오류", code: 'console.log("먼저"); throw new Error("앗")' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("먼저");
    expect(textOf(r)).toContain("앗");
  });

  test("repl 안에서 난 사파리 오류는 한국어 안내가 붙는다", async () => {
    const d = createFakeDriver();
    d.openTab = async () => {
      throw new SafariError("JS_FROM_APPLE_EVENTS_OFF", "원문");
    };
    const c = await connect(d);
    const r = await c.callTool({ name: "repl", arguments: { title: "열기", code: 'await openTab("http://a/")' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("사파리 설정 → 개발자 → 'Apple 이벤트의 JavaScript 허용'");
  });

  test("display 한 이미지가 응답 content 에 image 로 붙는다", async () => {
    const d = createFakeDriver();
    const c = await connect(d);
    const r = (await c.callTool({
      name: "repl",
      arguments: { title: "찍기", code: 'await openAiWindow("http://a/"); display(await page.screenshot()); console.log("찍음")' },
    })) as { isError?: boolean; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };
    expect(r.isError).toBeFalsy();
    expect(r.content[0]).toMatchObject({ type: "text", text: "찍음" });
    expect(r.content[1]).toMatchObject({ type: "image", mimeType: "image/png", data: d.png.toString("base64") });
    expect(r.content).toHaveLength(2);
  });

  test("이미지가 5장이면 4장만 붙고 안내 줄이 글에 있다", async () => {
    const c = await connect(createFakeDriver());
    const r = (await c.callTool({
      name: "repl",
      arguments: { title: "찍기", code: 'await openAiWindow("http://a/"); const b = await page.screenshot(); for (let i = 0; i < 5; i++) display(b)' },
    })) as { content: Array<{ type: string; text?: string }> };
    expect(r.content.filter((x) => x.type === "image")).toHaveLength(4);
    expect(r.content[0]!.text).toContain("이미지는 한 번에 4장까지");
  });

  test("오류 응답에도 오류 전에 display 한 이미지가 붙는다", async () => {
    const c = await connect(createFakeDriver());
    const r = (await c.callTool({
      name: "repl",
      arguments: { title: "찍기", code: 'await openAiWindow("http://a/"); display(await page.screenshot()); throw new Error("앗")' },
    })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("앗");
    expect(r.content.filter((x) => x.type === "image")).toHaveLength(1);
  });

  test("SCREEN_CAPTURE_DENIED 는 한국어 안내로, 서버는 계속 응답한다", async () => {
    const d = createFakeDriver();
    d.screenAllowed = false;
    const c = await connect(d);
    const r = await c.callTool({ name: "repl", arguments: { title: "찍기", code: 'await openAiWindow("http://a/"); await page.screenshot()' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("화면 찍기 권한이 없어요. 시스템 설정 → 개인정보 보호 및 보안 → 화면 및 시스템 오디오 녹음에서");
    const r2 = await c.callTool({ name: "repl", arguments: { title: "더하기", code: "console.log(1+2)" } });
    expect(textOf(r2)).toBe("3");
    expect(r2.isError).toBeFalsy();
  });

  test("status 는 한국어 줄로 상태를 알리고 연 탭을 닫는다", async () => {
    const d = createFakeDriver();
    d.answer = () => "2";
    const c = await connect(d);
    const r = await c.callTool({ name: "status", arguments: {} });
    const t = textOf(r);
    expect(t).toContain("사파리: 켜짐");
    expect(t).toContain("창: 1개");
    expect(t).toContain("Apple 이벤트의 JavaScript 허용: 켜짐");
    expect(t).toContain("자동화 허락: 됨");
    expect(d.calls.openTab).toHaveLength(1);
    expect(d.calls.closeTab).toEqual(["t1"]);
  });

  test("status: 설정이 꺼져 있어도 열었던 탭을 닫고 안내를 준다", async () => {
    const d = createFakeDriver();
    d.answer = () => {
      throw new SafariError("JS_FROM_APPLE_EVENTS_OFF", "원문");
    };
    const c = await connect(d);
    const t = textOf(await c.callTool({ name: "status", arguments: {} }));
    expect(t).toContain("Apple 이벤트의 JavaScript 허용: 꺼짐");
    expect(t).toContain("사파리 설정 → 개발자");
    expect(d.calls.closeTab).toEqual(["t1"]);
  });

  test("status: 사파리가 꺼져 있으면 켜지 않고 알린다", async () => {
    const d = createFakeDriver();
    d.listWindows = async () => {
      throw new SafariError("SAFARI_NOT_RUNNING", "사파리가 실행 중이 아님");
    };
    const c = await connect(d);
    const t = textOf(await c.callTool({ name: "status", arguments: {} }));
    expect(t).toContain("사파리: 꺼짐");
    expect(d.calls.openTab).toHaveLength(0);
  });

  test("status: 자동화 거부를 알린다", async () => {
    const d = createFakeDriver();
    d.listWindows = async () => {
      throw new SafariError("AUTOMATION_DENIED", "원문");
    };
    const c = await connect(d);
    const t = textOf(await c.callTool({ name: "status", arguments: {} }));
    expect(t).toContain("자동화 허락: 거부");
    expect(t).toContain("시스템 설정 → 개인정보 보호 및 보안 → 자동화");
  });

  test("서버를 닫으면 우리 탭을 닫는다", async () => {
    const d = createFakeDriver();
    let closed = 0;
    const orig = d.closeOwned.bind(d);
    d.closeOwned = async () => {
      closed++;
      return orig();
    };
    const c = await connect(d);
    await c.callTool({ name: "repl", arguments: { title: "열기", code: 'await openTab("http://a/")' } });
    await srv!.shutdown();
    expect(closed).toBe(1);
    expect(d.calls.openTab).toHaveLength(1);
  });
});
