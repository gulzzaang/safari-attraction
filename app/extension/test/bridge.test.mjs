import test from "node:test";
import assert from "node:assert/strict";
import "../lib/page.js";
import "../lib/stream.js";
import "../lib/text.js";
import "../lib/bridge.js";

const L = globalThis.SAPanelLib;
const enc = new TextEncoder();
const TOKEN = "0123456789abcdef".repeat(4);
const TOKEN2 = "fedcba9876543210".repeat(4);
const OFF = "사파리-어트랙션 앱을 켜 주세요(메뉴 막대 나침반)";

function streamResponse(chunks, { status = 200, failAfter = false } = {}) {
  let i = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        const c = chunks[i++];
        controller.enqueue(typeof c === "string" ? enc.encode(c) : c);
      } else if (failAfter) {
        controller.error(new TypeError("network error"));
      } else {
        controller.close();
      }
    },
  });
  return new Response(body, { status, headers: { "Content-Type": "application/x-ndjson" } });
}
const jsonResponse = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

function setup({ links = [{ port: 51000, token: TOKEN }], fetchImpl, allowed = true, nativeImpl } = {}) {
  const calls = [];
  const nativeCalls = { n: 0 };
  let li = 0;
  const bridge = L.createBridge({
    getLinkNative: nativeImpl || (async () => {
      nativeCalls.n++;
      const l = links[Math.min(li++, links.length - 1)];
      return l;
    }),
    fetch: async (url, init) => { calls.push({ url, init }); return fetchImpl(url, init, calls.length); },
    hasHostPermission: async () => allowed,
  });
  const emitted = [];
  return { bridge, calls, emitted, emit: (m) => emitted.push(m), nativeCalls };
}

function assertNoSecrets(emitted) {
  const s = JSON.stringify(emitted);
  assert.ok(!s.includes(TOKEN) && !s.includes(TOKEN2), "토큰이 패널 메시지에 있다: " + s);
  assert.ok(!/safari-web-extension/i.test(s), "Origin 이 패널 메시지에 있다");
}

const PAGE = { title: "제목", url: "https://x.test/", selection: "", text: "본문" };

test("묻기: 토큰 머리 · 본문 모양 · 줄을 delta… done 으로, 토큰은 패널로 안 간다", async () => {
  const t = setup({
    fetchImpl: async () => streamResponse([
      `{"t":"delta","text":"안녕 ${TOKEN}"}\n`, '{"t":"delta","text":"하세요"}\n', `{"t":"done","usage":{"token":"${TOKEN}"}}\n`,
    ]),
  });
  await t.bridge.ask({ question: "뭐예요?", page: PAGE, webSearch: false }, t.emit);
  assert.equal(t.calls.length, 1);
  const { url, init } = t.calls[0];
  assert.equal(url, "http://127.0.0.1:51000/ask");
  assert.equal(init.method, "POST");
  assert.deepEqual(Object.keys(init.headers).sort(), ["Content-Type", "X-SA-Token"]);
  assert.equal(init.headers["X-SA-Token"], TOKEN);
  assert.deepEqual(JSON.parse(init.body), { question: "뭐예요?", webSearch: false, page: PAGE });
  assert.deepEqual(t.emitted.map((m) => m.t), ["delta", "delta", "done"]);
  assert.equal(t.emitted[0].text, "안녕 …");
  assertNoSecrets(t.emitted);
});

test("이 페이지 함께를 껐으면 page 를 보내지 않는다", async () => {
  const t = setup({ fetchImpl: async () => streamResponse(['{"t":"done"}\n']) });
  await t.bridge.ask({ question: "q", webSearch: true }, t.emit);
  assert.deepEqual(JSON.parse(t.calls[0].init.body), { question: "q", webSearch: true });
});

test("스트림 조각이 한글 가운데에서 끊겨도 글이 온전하다", async () => {
  const bytes = enc.encode('{"t":"delta","text":"가나다"}\n{"t":"done"}\n');
  const cut = bytes.indexOf(0xea) + 1; // '가'(EA B0 80) 두 번째 바이트 앞
  const t = setup({ fetchImpl: async () => streamResponse([bytes.slice(0, cut), bytes.slice(cut, cut + 5), bytes.slice(cut + 5)]) });
  await t.bridge.ask({ question: "q" }, t.emit);
  assert.deepEqual(t.emitted, [{ t: "delta", text: "가나다" }, { t: "done" }]);
});

test("연결 파일이 없으면(앱 꺼짐) 서버에 묻지 않고 안내", async () => {
  const t = setup({ links: [{ error: "아무 글" }], fetchImpl: async () => { throw new Error("부르면 안 됨"); } });
  await t.bridge.ask({ question: "q" }, t.emit);
  assert.equal(t.calls.length, 0);
  assert.deepEqual(t.emitted, [{ t: "error", message: OFF }]);
  const infos = [];
  await t.bridge.info((m) => infos.push(m));
  assert.deepEqual(infos, [{ t: "info-error", message: OFF }]);
});

test("연결 실패 → 연결 정보를 새로 받아 한 번 다시(포트가 바뀐 경우)", async () => {
  const t = setup({
    links: [{ port: 51000, token: TOKEN }, { port: 52000, token: TOKEN2 }],
    fetchImpl: async (url) => {
      if (url.includes(":51000")) throw new TypeError("Load failed");
      return streamResponse([`{"t":"delta","text":"된다 ${TOKEN2}"}\n`, '{"t":"done"}\n']);
    },
  });
  await t.bridge.ask({ question: "q" }, t.emit);
  assert.equal(t.calls.length, 2);
  assert.equal(t.calls[1].url, "http://127.0.0.1:52000/ask");
  assert.equal(t.calls[1].init.headers["X-SA-Token"], TOKEN2);
  assert.deepEqual(t.emitted.map((m) => m.t), ["delta", "done"]);
  assertNoSecrets(t.emitted);
});

test("연결 실패 후 연결 정보가 사라졌으면(앱이 꺼짐) 앱을 켜 달라고", async () => {
  const t = setup({
    links: [{ port: 51000, token: TOKEN }, { error: "없음" }],
    fetchImpl: async () => { throw new TypeError("Load failed"); },
  });
  await t.bridge.ask({ question: "q" }, t.emit);
  assert.deepEqual(t.emitted, [{ t: "error", message: OFF }]);
});

test("두 번 다 연결 실패: 사파리 권한이 없으면 권한 안내, 있으면 앱 안내(+권한 확인 힌트)", async () => {
  const fail = async () => { throw new TypeError("Load failed"); };
  const a = setup({ fetchImpl: fail, allowed: false });
  await a.bridge.ask({ question: "q" }, a.emit);
  assert.equal(a.calls.length, 2);
  assert.equal(a.emitted[0].t, "error");
  assert.ok(a.emitted[0].message.includes("사파리 설정 → 확장 → 사파리-어트랙션 → 웹사이트에서 127.0.0.1 허락"));
  const b = setup({ fetchImpl: fail, allowed: true });
  await b.bridge.ask({ question: "q" }, b.emit);
  assert.ok(b.emitted[0].message.startsWith(OFF));
  assertNoSecrets([...a.emitted, ...b.emitted]);
});

test("권한 확인 자체가 던져도(사파리가 지원 안 함) 앱 안내로", async () => {
  const bridge = L.createBridge({
    getLinkNative: async () => ({ port: 5, token: TOKEN }),
    fetch: async () => { throw new TypeError("Load failed"); },
    hasHostPermission: async () => { throw new Error("no api"); },
  });
  const out = [];
  await bridge.ask({ question: "q" }, (m) => out.push(m));
  assert.ok(out[0].message.startsWith(OFF));
});

test("403 → 연결 정보를 새로 받아 다시, 그래도 403 이면 연결 정보 안내", async () => {
  const ok = setup({
    links: [{ port: 51000, token: TOKEN }, { port: 51000, token: TOKEN2 }],
    fetchImpl: async (u, init) => init.headers["X-SA-Token"] === TOKEN ? jsonResponse(403, { error: "허락되지 않았어요" }) : streamResponse(['{"t":"done"}\n']),
  });
  await ok.bridge.ask({ question: "q" }, ok.emit);
  assert.deepEqual(ok.emitted, [{ t: "done" }]);
  const bad = setup({ fetchImpl: async () => jsonResponse(403, { error: "x" }) });
  await bad.bridge.ask({ question: "q" }, bad.emit);
  assert.equal(bad.calls.length, 2);
  assert.equal(bad.emitted[0].t, "error");
  assert.ok(/연결 정보/.test(bad.emitted[0].message));
});

test("429 · 413 · 400 은 서버 한국어 글 또는 정해진 문구", async () => {
  for (const [status, body, expect] of [
    [429, { error: "다른 질문이 끝나면 다시 시도해 주세요" }, "다른 질문이 끝나면 다시 시도해 주세요"],
    [413, { error: "큼" }, "질문이 너무 길어요"],
    [400, { error: "질문이 비어 있어요" }, "질문이 비어 있어요"],
  ]) {
    const t = setup({ fetchImpl: async () => jsonResponse(status, body) });
    await t.bridge.ask({ question: "q" }, t.emit);
    assert.equal(t.emitted.length, 1);
    assert.ok(t.emitted[0].message.includes(expect), `${status}: ${t.emitted[0].message}`);
  }
});

test("서버가 오류 줄을 주면 error 가 마지막이고 done 은 없다 · done 뒤 줄은 무시", async () => {
  const e = setup({ fetchImpl: async () => streamResponse(['{"t":"delta","text":"일부"}\n{"t":"error","message":"시간이 넘었어요"}\n{"t":"delta","text":"늦은 글"}\n']) });
  await e.bridge.ask({ question: "q" }, e.emit);
  assert.deepEqual(e.emitted, [{ t: "delta", text: "일부" }, { t: "error", message: "시간이 넘었어요" }]);
  const d = setup({ fetchImpl: async () => streamResponse(['{"t":"done"}\n{"t":"delta","text":"늦은 글"}\n{"t":"error","message":"x"}\n']) });
  await d.bridge.ask({ question: "q" }, d.emit);
  assert.deepEqual(d.emitted, [{ t: "done" }]);
});

test("done · error 없이 끝나면 「연결이 끊겼어요」(받은 글은 그대로)", async () => {
  const t = setup({ fetchImpl: async () => streamResponse(['{"t":"delta","text":"반쯤"}\n']) });
  await t.bridge.ask({ question: "q" }, t.emit);
  assert.deepEqual(t.emitted, [{ t: "delta", text: "반쯤" }, { t: "error", message: "연결이 끊겼어요" }]);
  const empty = setup({ fetchImpl: async () => streamResponse([]) });
  await empty.bridge.ask({ question: "q" }, empty.emit);
  assert.deepEqual(empty.emitted, [{ t: "error", message: "연결이 끊겼어요" }]);
});

test("스트림 읽기 도중 네트워크가 끊겨도 「연결이 끊겼어요」", async () => {
  const t = setup({ fetchImpl: async () => streamResponse(['{"t":"delta","text":"조금"}\n'], { failAfter: true }) });
  await t.bridge.ask({ question: "q" }, t.emit);
  assert.deepEqual(t.emitted, [{ t: "delta", text: "조금" }, { t: "error", message: "연결이 끊겼어요" }]);
});

test("취소(signal)하면 그 뒤로 아무것도 내지 않는다", async () => {
  const ctl = new AbortController();
  const t = setup({
    fetchImpl: async (url, init) => {
      return new Response(new ReadableStream({
        start(c) { c.enqueue(enc.encode('{"t":"delta","text":"하나"}\n')); init.signal.addEventListener("abort", () => c.error(new DOMException("Aborted", "AbortError"))); },
      }));
    },
  });
  const done = t.bridge.ask({ question: "q" }, (m) => { t.emitted.push(m); if (m.t === "delta") ctl.abort(); }, ctl.signal);
  await done;
  assert.deepEqual(t.emitted, [{ t: "delta", text: "하나" }]);
  // 시작 전에 이미 취소된 경우
  const t2 = setup({ fetchImpl: async () => { throw new DOMException("Aborted", "AbortError"); } });
  const c2 = new AbortController(); c2.abort();
  await t2.bridge.ask({ question: "q" }, t2.emit, c2.signal);
  assert.deepEqual(t2.emitted, []);
});

test("네이티브 핸들러가 응답하지 않거나 연결 정보가 엉터리면 한국어 안내", async () => {
  const dead = setup({ nativeImpl: async () => { throw new Error("no native"); }, fetchImpl: async () => { throw 1; } });
  await dead.bridge.ask({ question: "q" }, dead.emit);
  assert.ok(dead.emitted[0].message.includes("응답하지 않아요"));
  for (const bad of [{ port: 0, token: TOKEN }, { port: 51000, token: "짧음" }, { port: "5", token: TOKEN }, null, "x"]) {
    const t = setup({ links: [bad], fetchImpl: async () => { throw 1; } });
    await t.bridge.ask({ question: "q" }, t.emit);
    assert.equal(t.calls.length, 0);
    assert.equal(t.emitted[0].t, "error");
    assert.ok(/[가-힣]/.test(t.emitted[0].message));
  }
});

test("핸들러 답이 { message: {...} } 로 싸여 와도 읽는다", async () => {
  const t = setup({ nativeImpl: async () => ({ message: { port: 51000, token: TOKEN } }), fetchImpl: async () => streamResponse(['{"t":"done"}\n']) });
  await t.bridge.ask({ question: "q" }, t.emit);
  assert.deepEqual(t.emitted, [{ t: "done" }]);
});

test("연결 정보는 background 메모리에 두고 두 번째 묻기에는 핸들러를 다시 부르지 않는다", async () => {
  const t = setup({ fetchImpl: async () => streamResponse(['{"t":"done"}\n']) });
  await t.bridge.ask({ question: "a" }, t.emit);
  await t.bridge.ask({ question: "b" }, t.emit);
  assert.equal(t.nativeCalls.n, 1);
});

test("/info: loggedIn null · 토큰 · 모르는 키는 패널로 안 간다", async () => {
  const t = setup({ fetchImpl: async () => jsonResponse(200, { cli: "claude", cliName: "클로드", model: "Sonnet", loggedIn: null, token: TOKEN }) });
  await t.bridge.info(t.emit);
  assert.equal(t.calls[0].url, "http://127.0.0.1:51000/info");
  assert.equal(t.calls[0].init.method, "GET");
  assert.deepEqual(t.emitted, [{ t: "info", cli: "claude", cliName: "클로드", model: "Sonnet", loggedIn: null }]);
  assertNoSecrets(t.emitted);
});

test("패널로 가는 모든 메시지는 허용 목록 키만 가진다", async () => {
  const t = setup({
    fetchImpl: async () => streamResponse([
      `{"t":"delta","text":"a","token":"${TOKEN}","origin":"safari-web-extension://x"}\n`,
      `{"t":"done","usage":{"input":1},"token":"${TOKEN}"}\n`,
    ]),
  });
  await t.bridge.ask({ question: "q" }, t.emit);
  const allowed = new Set(["t", "text", "message", "cli", "cliName", "model", "loggedIn"]);
  for (const m of t.emitted) for (const k of Object.keys(m)) assert.ok(allowed.has(k), k);
  assertNoSecrets(t.emitted);
});

test("서버의 오류 글(400 · /info 실패)에 토큰이 섞여 와도 패널로 안 간다", async () => {
  const t = setup({ fetchImpl: async () => jsonResponse(400, { error: `이상해요 ${TOKEN}` }) });
  await t.bridge.ask({ question: "q" }, t.emit);
  assert.equal(t.emitted[0].t, "error");
  assert.ok(t.emitted[0].message.includes("이상해요"));
  assertNoSecrets(t.emitted);
  const i = setup({ fetchImpl: async () => jsonResponse(500, { error: `내부 오류 ${TOKEN}` }) });
  await i.bridge.info(i.emit);
  assert.equal(i.emitted[0].t, "info-error");
  assertNoSecrets(i.emitted);
});

test("요청 머리는 X-SA-Token · Content-Type 만(미리 확인이 허락하는 것) — fetch 옵션에 cache 를 안 넣는다", async () => {
  const t = setup({ fetchImpl: async () => streamResponse(['{"t":"done"}\n']) });
  await t.bridge.ask({ question: "q" }, t.emit);
  assert.ok(!("cache" in t.calls[0].init));
  assert.ok(!("credentials" in t.calls[0].init) || t.calls[0].init.credentials === undefined);
});
