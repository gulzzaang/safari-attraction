import test from "node:test";
import assert from "node:assert/strict";
import "../lib/page.js";
import "../lib/alerts.js";

const L = globalThis.SAPanelLib;

test("제목 앞 (N) · [N] 숫자 읽기 — 1~9999 만, 앞 공백 허용, 없으면 0", () => {
  const R = L.readTitleCount;
  assert.equal(R("(3) 받은편지함"), 3);
  assert.equal(R("[12] 알림"), 12);
  assert.equal(R("   (9999) x"), 9999);
  assert.equal(R(" (7)x"), 7);
  assert.equal(R("(0) 없음"), 0);
  assert.equal(R("(10000) 너무 큼"), 0);
  assert.equal(R("(3] 짝이 안 맞음"), 0);
  assert.equal(R("[3) 짝이 안 맞음"), 0);
  assert.equal(R("받은편지함 (3)"), 0);
  assert.equal(R("(99+) 많음"), 0);
  assert.equal(R("(-1) 음수"), 0);
  assert.equal(R(""), 0);
  assert.equal(R(undefined), 0);
});

test("제목 숫자: 처음 값은 기준만, 늘 때만 알림, 줄면 기준만 낮춤", () => {
  const t = L.createBadgeTracker();
  assert.equal(t.observe("(3) 메일"), false); // 처음 — 기준만
  assert.equal(t.observe("(3) 메일"), false);
  assert.equal(t.observe("(4) 메일"), true);
  assert.equal(t.observe("(4) 다른 제목"), false);
  assert.equal(t.observe("(2) 메일"), false); // 줄면 기준만
  assert.equal(t.observe("(3) 메일"), true); // 낮춘 기준에서 늘면 다시
  assert.equal(t.observe("메일"), false); // 숫자 없음 = 0
  assert.equal(t.observe("(1) 메일"), true);
  const first = L.createBadgeTracker();
  assert.equal(first.observe("(5) 처음부터 숫자"), false);
});

test("탭마다 10초에 한 번까지", () => {
  let now = 1000;
  const r = L.createRateLimiter(10_000, () => now);
  assert.equal(r.allow(), true);
  now += 9_999; assert.equal(r.allow(), false);
  now += 1; assert.equal(r.allow(), true);
  now += 3_000; assert.equal(r.allow(), false);
  now -= 60_000; assert.equal(r.allow(), true); // 시계가 뒤로 가도 영영 막히지 않는다
});

test("페이지 메시지: 표식이 1 일 때만, 제목 · 내용은 글자만 · 1,000자", () => {
  const A = L.readAlertMessage;
  assert.deepEqual(A({ __safariAttractionAlert: 1, title: "새 메일", body: "안녕" }), { title: "새 메일", body: "안녕" });
  assert.deepEqual(A({ __safariAttractionAlert: 1, title: 5, body: { x: 1 } }), { title: "", body: "" });
  assert.equal(A({ __safariAttractionAlert: true, title: "x" }), null);
  assert.equal(A({ __safariAttractionAlert: "1", title: "x" }), null);
  assert.equal(A({ title: "x" }), null);
  assert.equal(A(null), null);
  assert.equal(A("문자열"), null);
  const long = A({ __safariAttractionAlert: 1, title: "가".repeat(3000), body: "😀".repeat(3000) });
  assert.equal(Array.from(long.title).length, 1000);
  assert.equal(Array.from(long.body).length, 1000);
  assert.ok(!long.body.endsWith("\ud83d"));
});

test("호스트 맞추기: 같거나 하위 도메인만(점으로 끊어서)", () => {
  const M = L.hostMatches;
  const list = ["example.com", "Shop.Other.com."];
  assert.equal(M("example.com", list), true);
  assert.equal(M("www.example.com", list), true);
  assert.equal(M("a.b.example.com", list), true);
  assert.equal(M("WWW.EXAMPLE.COM.", list), true);
  assert.equal(M("shop.other.com", list), true);
  assert.equal(M("other.com", list), false); // 상위 도메인은 아님
  assert.equal(M("evilexample.com", list), false);
  assert.equal(M("example.com.evil.com", list), false);
  assert.equal(M("example.co", list), false);
  assert.equal(M("", list), false);
  assert.equal(M("example.com", []), false);
  assert.equal(M("example.com", ["", null, 5]), false);
  assert.equal(M("x.com", "x.com"), false); // 목록이 아니면 아무것도 안 맞음
});

test("background 로 온 알림 다듬기: 종류 두 가지만, 호스트는 보낸 탭 주소가 먼저", () => {
  const P = L.alertPayload;
  assert.deepEqual(P({ t: "alert", host: "example.com", kind: "notification", title: "t", body: "b" }, "www.example.com"),
    { host: "www.example.com", kind: "notification", title: "t", body: "b" });
  assert.deepEqual(P({ host: "evil.com", kind: "badge", title: "(2) x" }, "mail.example.com"),
    { host: "mail.example.com", kind: "badge", title: "(2) x", body: "" });
  assert.equal(P({ host: "example.com", kind: "notification" }, "").host, "example.com"); // 보낸 쪽 주소를 모르면 메시지의 것
  assert.equal(P({ host: "example.com", kind: "push" }, "example.com"), null);
  assert.equal(P({ host: "", kind: "badge" }, ""), null);
  assert.equal(P({ host: "a b/c", kind: "badge" }, ""), null);
  assert.equal(P(null, "example.com"), null);
  const big = P({ host: "x.com", kind: "notification", title: "a".repeat(5000), body: 7 }, "");
  assert.equal(big.title.length, 1000);
  assert.equal(big.body, "");
  assert.equal(L.hostFromUrl("https://Mail.Example.com:8443/x?y#z"), "mail.example.com");
  assert.equal(L.hostFromUrl("http://example.com/"), "example.com");
  assert.equal(L.hostFromUrl("safari-web-extension://example.com/panel.html"), "");
  assert.equal(L.hostFromUrl("file:///tmp/a.html"), "");
  assert.equal(L.hostFromUrl("about:blank"), "");
  assert.equal(L.hostFromUrl("not a url"), "");
  assert.equal(L.hostFromUrl(undefined), "");
  assert.equal(L.normalizeHost(".example.com"), "");
  assert.equal(L.normalizeHost("a..example.com"), "");
});

// ── background 의 보내기(지켜볼 사이트만) ─────────────────────────────────────
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

function forwarder({ hosts = ["example.com"], hostsImpl, alertImpl } = {}) {
  let now = 0;
  const calls = [];
  const f = L.createAlertForwarder({
    now: () => now,
    request: async (path, init) => {
      calls.push({ path, init });
      if (path === "/alert-hosts") return hostsImpl ? hostsImpl() : json(200, { hosts });
      if (path === "/alert") return alertImpl ? alertImpl(init) : json(202, { accepted: 1 });
      throw new Error("모르는 경로 " + path);
    },
  });
  return { f, calls, tick: (ms) => { now += ms; } };
}
const ALERT = { host: "www.example.com", kind: "notification", title: "새 메일 비밀 제목", body: "비밀 내용" };

test("지켜보는 사이트면 /alert-hosts 를 받고 /alert 로 보낸다", async () => {
  const t = forwarder();
  assert.equal(await t.f.forward(ALERT), "sent");
  assert.deepEqual(t.calls.map((c) => c.path), ["/alert-hosts", "/alert"]);
  assert.equal(t.calls[0].init.method, "GET");
  const post = t.calls[1].init;
  assert.equal(post.method, "POST");
  assert.deepEqual(post.headers, { "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(post.body), ALERT);
});

test("지켜보지 않는 사이트의 알림 글은 앱으로 가지 않는다(목록만 묻는다)", async () => {
  const t = forwarder({ hosts: ["example.com"] });
  for (const host of ["evilexample.com", "example.com.evil.com", "other.com"]) {
    assert.equal(await t.f.forward({ ...ALERT, host }), "not-watched");
  }
  assert.deepEqual(t.calls.map((c) => c.path), ["/alert-hosts"]);
  assert.ok(!JSON.stringify(t.calls).includes("비밀"), "알림 글이 요청에 들어갔다");
});

test("목록이 비면 아무것도 보내지 않는다", async () => {
  const t = forwarder({ hosts: [] });
  assert.equal(await t.f.forward(ALERT), "not-watched");
  assert.deepEqual(t.calls.map((c) => c.path), ["/alert-hosts"]);
});

test("목록은 5분 기억 — 5분이 지나면 다음 알림 때 새로 받는다", async () => {
  const t = forwarder();
  await t.f.forward(ALERT);
  t.tick(4 * 60_000);
  await t.f.forward(ALERT);
  assert.deepEqual(t.calls.map((c) => c.path), ["/alert-hosts", "/alert", "/alert"]);
  t.tick(60_000);
  await t.f.forward(ALERT);
  assert.deepEqual(t.calls.map((c) => c.path), ["/alert-hosts", "/alert", "/alert", "/alert-hosts", "/alert"]);
  // 시계가 뒤로 가면 캐시에 갇히지 않고 다시 묻는다
  t.tick(-120_000);
  await t.f.forward(ALERT);
  assert.deepEqual(t.calls.map((c) => c.path), ["/alert-hosts", "/alert", "/alert", "/alert-hosts", "/alert", "/alert-hosts", "/alert"]);
});

test("목록을 못 받으면(앱 꺼짐 · 연결 실패 · 403 · 깨진 답) 빈 목록으로 보고 1분 뒤 다시", async () => {
  for (const hostsImpl of [
    () => { throw new Error("app_off"); },
    () => json(403, { error: "x" }),
    () => json(500, {}),
    () => new Response("깨진", { status: 200 }),
  ]) {
    const t = forwarder({ hostsImpl });
    assert.equal(await t.f.forward(ALERT), "not-watched");
    t.tick(59_000);
    assert.equal(await t.f.forward(ALERT), "not-watched");
    assert.deepEqual(t.calls.map((c) => c.path), ["/alert-hosts"]); // 1분 안에는 다시 묻지도 않음
    t.tick(1_000);
    await t.f.forward(ALERT);
    assert.deepEqual(t.calls.map((c) => c.path), ["/alert-hosts", "/alert-hosts"]);
    assert.ok(!JSON.stringify(t.calls).includes("비밀"));
  }
});

test("목록 답의 이상한 값은 버린다", async () => {
  const t = forwarder({ hostsImpl: () => json(200, { hosts: ["EXAMPLE.com", 5, null, "", "a b"] }) });
  assert.equal(await t.f.forward(ALERT), "sent");
  const u = forwarder({ hostsImpl: () => json(200, { hosts: "example.com" }) });
  assert.equal(await u.f.forward(ALERT), "not-watched");
});

test("보내기 실패(연결 · 403 · 500)는 조용히 버린다 — 던지지 않는다", async () => {
  for (const alertImpl of [() => { throw new Error("down"); }, () => json(403, {}), () => json(500, {})]) {
    const t = forwarder({ alertImpl });
    assert.equal(await t.f.forward(ALERT), "failed");
  }
});

test("동시에 온 알림 둘은 목록을 한 번만 묻는다", async () => {
  const t = forwarder();
  await Promise.all([t.f.forward(ALERT), t.f.forward(ALERT)]);
  assert.equal(t.calls.filter((c) => c.path === "/alert-hosts").length, 1);
  assert.equal(t.calls.filter((c) => c.path === "/alert").length, 2);
});

test("다듬지 않은 알림(호스트 없음 · 종류 틀림)은 아무것도 묻지 않는다", async () => {
  const t = forwarder();
  assert.equal(await t.f.forward(null), "invalid");
  assert.equal(await t.f.forward({ host: "", kind: "badge", title: "", body: "" }), "invalid");
  assert.equal(await t.f.forward({ host: "example.com", kind: "x", title: "", body: "" }), "invalid");
  assert.deepEqual(t.calls, []);
});
