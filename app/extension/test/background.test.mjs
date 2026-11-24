import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import "../lib/page.js";
import "../lib/text.js";
import "../lib/stream.js";
import "../lib/bridge.js";
import "../lib/alerts.js";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "background.js"), "utf8");
const TOKEN = "0123456789abcdef".repeat(4);
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
const tick = () => new Promise((r) => setTimeout(r, 20));

/** background.js 를 가짜 확장 환경에서 돌린다(진짜 lib, 가짜 fetch · 핸들러 · 콘솔). */
function boot({ hosts = ["example.com"], appOff = false } = {}) {
  const listeners = { message: [], connect: [] };
  const fetches = [];
  const logs = [];
  const ext = {
    runtime: {
      id: "me",
      onConnect: { addListener: (f) => listeners.connect.push(f) },
      onMessage: { addListener: (f) => listeners.message.push(f) },
      sendNativeMessage: async (_app, msg) => (!appOff && msg && msg.type === "getLink" ? { port: 51000, token: TOKEN } : { error: "사파리-어트랙션 앱을 켜 주세요(메뉴 막대 나침반)" }),
      getURL: (p) => "safari-web-extension://me/" + p,
    },
    permissions: { contains: async () => true },
    action: { onClicked: { addListener() {} }, setBadgeText() {}, setTitle() {} },
    commands: { onCommand: { addListener() {} } },
    tabs: { query: async () => [], sendMessage: async () => {} },
  };
  const fakeFetch = async (url, init) => {
    fetches.push({ url, init });
    if (url.endsWith("/alert-hosts")) return json(200, { hosts });
    if (url.endsWith("/alert")) return json(202, { accepted: 1 });
    throw new TypeError("Load failed");
  };
  const g = { browser: ext, SAPanelLib: globalThis.SAPanelLib };
  const consoleLike = { error: (...a) => logs.push(a), log: (...a) => logs.push(a), warn: (...a) => logs.push(a) };
  new Function("globalThis", "console", "fetch", src)(g, consoleLike, fakeFetch);
  const sendAlert = (msg, sender) => listeners.message.map((f) => f(msg, sender, () => {}));
  return { fetches, logs, sendAlert, listeners };
}

test("background: 지켜보는 사이트 알림은 토큰을 붙여 /alert 로 — 호스트는 보낸 탭 주소에서", async () => {
  const b = boot();
  const results = b.sendAlert({ t: "alert", host: "evil.com", kind: "notification", title: "새 메일", body: "내용" },
    { id: "me", url: "https://www.example.com/inbox" });
  assert.ok(results.every((r) => r === false)); // 응답을 기다리게 하지 않는다
  await tick();
  assert.deepEqual(b.fetches.map((f) => f.url), ["http://127.0.0.1:51000/alert-hosts", "http://127.0.0.1:51000/alert"]);
  for (const f of b.fetches) assert.equal(f.init.headers["X-SA-Token"], TOKEN);
  assert.deepEqual(JSON.parse(b.fetches[1].init.body), { host: "www.example.com", kind: "notification", title: "새 메일", body: "내용" });
  assert.deepEqual(b.logs, []); // 토큰 · 알림 글을 콘솔에 찍지 않는다
});

test("background: 다른 확장 · 다른 곳에서 온 알림은 무시", async () => {
  const b = boot();
  b.sendAlert({ t: "alert", host: "example.com", kind: "notification", title: "x", body: "" }, { id: "someone-else", url: "https://example.com/" });
  b.sendAlert({ t: "alert", host: "example.com", kind: "notification", title: "x", body: "" }, undefined);
  await tick();
  assert.deepEqual(b.fetches, []);
});

test("background: 메시지가 지켜보는 호스트라고 해도 보낸 탭이 다른 사이트면 보내지 않는다", async () => {
  const b = boot();
  b.sendAlert({ t: "alert", host: "example.com", kind: "badge", title: "(3) 비밀", body: "" }, { id: "me", url: "https://evil.test/" });
  await tick();
  assert.deepEqual(b.fetches.map((f) => f.url), ["http://127.0.0.1:51000/alert-hosts"]);
  assert.ok(!JSON.stringify(b.fetches).includes("비밀"));
  assert.deepEqual(b.logs, []);
});

test("background: 앱이 꺼져 있으면(연결 파일 없음) 서버에 묻지 않고 조용히 버린다 — 콘솔에도 안 찍는다", async () => {
  const off = boot({ appOff: true });
  off.sendAlert({ t: "alert", host: "example.com", kind: "notification", title: "t", body: "" }, { id: "me", url: "https://example.com/" });
  await tick();
  assert.deepEqual(off.fetches, []);
  assert.deepEqual(off.logs, []);
});

test("background: 목록이 비면 /alert 를 보내지 않는다", async () => {
  const empty = boot({ hosts: [] });
  empty.sendAlert({ t: "alert", host: "x.com", kind: "notification", title: "t", body: "" }, { id: "me", url: "https://x.com/" });
  await tick();
  assert.deepEqual(empty.fetches.map((f) => f.url), ["http://127.0.0.1:51000/alert-hosts"]);
});
