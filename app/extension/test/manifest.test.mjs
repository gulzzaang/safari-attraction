import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ext = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));

test("background 는 scripts 목록(lib 먼저, background.js 마지막) — service_worker · importScripts 없음", () => {
  assert.equal(manifest.background.service_worker, undefined);
  assert.equal(manifest.background.persistent, false);
  const scripts = manifest.background.scripts;
  assert.equal(scripts[scripts.length - 1], "background.js");
  assert.deepEqual(scripts.slice(0, -1), ["lib/page.js", "lib/text.js", "lib/stream.js", "lib/bridge.js", "lib/alerts.js"]);
  const src = readFileSync(join(ext, "background.js"), "utf8");
  assert.ok(!/importScripts\s*\(/.test(src), "background.js 에 importScripts 가 있다");
  assert.ok(src.includes("확장 파일을 못 읽었어요"), "lib 이 없을 때 눈에 띄는 안내가 없다");
});

test("manifest 가 가리키는 파일이 모두 있고 build.sh 가 복사한다", () => {
  const files = [...manifest.background.scripts, ...manifest.content_scripts.flatMap((c) => c.js)];
  const build = readFileSync(join(ext, "..", "scripts", "build.sh"), "utf8");
  for (const f of new Set(files)) {
    assert.ok(existsSync(join(ext, f)), f + " 이 없다");
    assert.ok(build.includes(f), f + " 를 build.sh 가 복사하지 않는다");
  }
  assert.ok(build.includes("panel.css"));
});

test("content script 는 lib 이 먼저, content.js 마지막, 모든 http/https 최상위 프레임", () => {
  const cs = manifest.content_scripts.find((c) => c.js.includes("content.js"));
  assert.equal(cs.js[cs.js.length - 1], "content.js");
  assert.deepEqual(cs.js, ["lib/page.js", "lib/text.js", "lib/stream.js", "lib/cards.js", "lib/alerts.js", "content.js"]);
  assert.equal(cs.world, undefined); // 패널은 격리 세계
  assert.deepEqual(cs.matches, ["http://*/*", "https://*/*"]);
  assert.equal(cs.run_at, "document_idle");
  assert.equal(cs.all_frames, undefined);
});

test("권한은 지시서 그대로", () => {
  assert.deepEqual(manifest.permissions, ["nativeMessaging", "activeTab", "storage"]);
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*"]);
  assert.equal(manifest.commands["toggle-panel"].suggested_key.default, "Alt+Shift+E");
});

test("background.js 는 lib 이 없으면 console.error + 배지 「!」 로 멈춘다(조용히 죽지 않음)", async () => {
  const src = readFileSync(join(ext, "background.js"), "utf8");
  const errors = []; const badges = []; const listeners = [];
  const fake = {
    runtime: { id: "x", onConnect: { addListener: () => listeners.push("c") }, onMessage: { addListener: () => listeners.push("m") } },
    action: { setBadgeText: (o) => badges.push(o), setTitle: () => {}, onClicked: { addListener: () => listeners.push("a") } },
    commands: { onCommand: { addListener: () => listeners.push("k") } },
  };
  const run = new Function("globalThis", "console", src);
  run({ browser: fake }, { error: (m) => errors.push(m) });
  assert.deepEqual(errors, ["사파리-어트랙션: 확장 파일을 못 읽었어요"]);
  assert.deepEqual(badges, [{ text: "!" }]);
  assert.deepEqual(listeners, []);
});

test("알림 엿듣기는 따로: notify-hook.js 하나만 · 페이지 세계(MAIN) · document_start · 모든 http/https 최상위 프레임", () => {
  const hooks = manifest.content_scripts.filter((c) => c.js.includes("notify-hook.js"));
  assert.equal(hooks.length, 1);
  const h = hooks[0];
  assert.deepEqual(h.js, ["notify-hook.js"]); // 페이지 세계에는 lib 을 싣지 않는다
  assert.equal(h.world, "MAIN");
  assert.equal(h.run_at, "document_start");
  assert.deepEqual(h.matches, ["http://*/*", "https://*/*"]);
  assert.equal(h.all_frames, undefined);
});
