import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { defaultServerCommand, runSetup, type SetupOptions } from "../../src/setup.js";

type ExecResult = { code: number; stdout: string; stderr: string };

let home: string;
let cfgDir: string;
let cfgPath: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sa-setup-"));
  cfgDir = join(home, "Library", "Application Support", "Claude");
  cfgPath = join(cfgDir, "claude_desktop_config.json");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const CMD = { command: "/usr/local/bin/node", args: ["/opt/sa/server.mjs"] };
const NOW = new Date(2026, 10, 19, 14, 5, 9); // 로컬 2026-11-19 14:05:09

function make(listing: ExecResult | "missing", over: Partial<SetupOptions> = {}) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const logs: string[] = [];
  const opts: SetupOptions = {
    dryRun: false,
    claudeCode: true,
    desktop: true,
    serverCommand: CMD,
    home,
    now: () => NOW,
    log: (s) => void logs.push(s),
    exec: async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[1] === "list") {
        if (listing === "missing") throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
        return listing;
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    ...over,
  };
  return { opts, calls, logs, text: () => logs.join("\n") };
}
const emptyList: ExecResult = { code: 0, stdout: "No MCP servers configured.\n", stderr: "" };
const adds = (calls: Array<{ args: string[] }>) => calls.filter((c) => c.args[1] === "add");

describe("setup — 처음 설치", () => {
  test("설정 파일 없음 → 새로 만들고, claude mcp add 를 정확한 인자로 부른다", async () => {
    mkdirSync(cfgDir, { recursive: true });
    const m = make(emptyList);
    expect(await runSetup(m.opts)).toBe(0);

    expect(JSON.parse(readFileSync(cfgPath, "utf8"))).toEqual({ mcpServers: { "safari-attraction": CMD } });
    expect(readFileSync(cfgPath, "utf8")).toBe(JSON.stringify({ mcpServers: { "safari-attraction": CMD } }, null, 2) + "\n");
    expect(readdirSync(cfgDir)).toEqual(["claude_desktop_config.json"]); // 사본 없음(원본이 없었다)
    expect(adds(m.calls)).toEqual([
      { cmd: "claude", args: ["mcp", "add", "--scope", "user", "safari-attraction", "--", "/usr/local/bin/node", "/opt/sa/server.mjs"] },
    ]);
    expect(m.text()).toContain("다음: Claude 데스크톱 · Claude Code 를 다시 켜고, `safari-attraction doctor` 로 준비를 확인하세요");
  });

  test("끝에 점검 결과(doctor 콜백)를 붙인다", async () => {
    mkdirSync(cfgDir, { recursive: true });
    const m = make(emptyList, { doctor: async () => "✓ 점검 결과 예시" });
    await runSetup(m.opts);
    expect(m.text()).toContain("✓ 점검 결과 예시");
  });
});

describe("setup — 데스크톱 설정 파일", () => {
  test("다른 서버가 있으면 그대로 두고 우리 것만 더하며, 사본을 남긴다", async () => {
    mkdirSync(cfgDir, { recursive: true });
    const original = JSON.stringify({ globalShortcut: "Ctrl+Space", mcpServers: { other: { command: "x", args: ["y"] } } }, null, 4);
    writeFileSync(cfgPath, original);
    const m = make(emptyList, { claudeCode: false });
    expect(await runSetup(m.opts)).toBe(0);

    expect(JSON.parse(readFileSync(cfgPath, "utf8"))).toEqual({
      globalShortcut: "Ctrl+Space",
      mcpServers: { other: { command: "x", args: ["y"] }, "safari-attraction": CMD },
    });
    expect(readFileSync(cfgPath, "utf8")).toContain('\n  "mcpServers"'); // 2칸 들여쓰기
    expect(readdirSync(cfgDir).sort()).toEqual(["claude_desktop_config.json", "claude_desktop_config.json.bak-20261119-140509"]);
    expect(readFileSync(join(cfgDir, "claude_desktop_config.json.bak-20261119-140509"), "utf8")).toBe(original);
  });

  test("우리 항목이 옛 값이면 바꾼다(다른 서버는 그대로)", async () => {
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: { "safari-attraction": { command: "old", args: [] }, other: { command: "x" } } }));
    const m = make(emptyList, { claudeCode: false });
    await runSetup(m.opts);
    expect(JSON.parse(readFileSync(cfgPath, "utf8")).mcpServers).toEqual({ "safari-attraction": CMD, other: { command: "x" } });
    expect(readdirSync(cfgDir).filter((f) => f.includes(".bak-"))).toHaveLength(1);
  });

  test("이미 같은 값이면 쓰지도 사본도 남기지 않고 「이미 등록」", async () => {
    mkdirSync(cfgDir, { recursive: true });
    const same = JSON.stringify({ mcpServers: { "safari-attraction": CMD } });
    writeFileSync(cfgPath, same);
    const m = make(emptyList, { claudeCode: false });
    await runSetup(m.opts);
    expect(readFileSync(cfgPath, "utf8")).toBe(same);
    expect(readdirSync(cfgDir)).toEqual(["claude_desktop_config.json"]);
    expect(m.text()).toContain("이미 등록돼 있어요");
  });

  test("깨진 JSON(Review Focus 2) → 고치지 않고 안내, 나머지(Claude Code)는 계속", async () => {
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(cfgPath, "{ not json");
    const m = make(emptyList);
    expect(await runSetup(m.opts)).toBe(0);
    expect(readFileSync(cfgPath, "utf8")).toBe("{ not json");
    expect(readdirSync(cfgDir)).toEqual(["claude_desktop_config.json"]);
    expect(m.text()).toContain(`설정 파일을 읽을 수 없어 데스크톱 연결은 건너뜁니다(파일: ${cfgPath})`);
    expect(adds(m.calls)).toHaveLength(1);
  });

  test("JSON 이지만 객체가 아니거나 mcpServers 가 객체가 아니어도 읽을 수 없는 것으로 본다", async () => {
    mkdirSync(cfgDir, { recursive: true });
    for (const body of ["[1,2]", "null", '{"mcpServers": 3}', '{"mcpServers": []}']) {
      writeFileSync(cfgPath, body);
      const m = make(emptyList, { claudeCode: false });
      await runSetup(m.opts);
      expect(readFileSync(cfgPath, "utf8")).toBe(body);
      expect(m.text()).toContain("설정 파일을 읽을 수 없어");
    }
  });

  test("Claude 폴더가 없으면 「Claude 데스크톱이 없어 건너뜁니다」, 아무것도 만들지 않는다", async () => {
    const m = make(emptyList);
    await runSetup(m.opts);
    expect(m.text()).toContain("Claude 데스크톱이 없어 건너뜁니다");
    expect(existsSync(join(home, "Library"))).toBe(false);
  });

  test("--no-desktop 이면 데스크톱을 건드리지 않는다", async () => {
    mkdirSync(cfgDir, { recursive: true });
    const m = make(emptyList, { desktop: false });
    await runSetup(m.opts);
    expect(existsSync(cfgPath)).toBe(false);
    expect(adds(m.calls)).toHaveLength(1);
  });
});

describe("setup — 설정 파일 권한 · 심볼릭 링크", () => {
  test("원래 파일이 0600 이면 고친 뒤에도 0600(사본도 0600)", async () => {
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: { other: { command: "x", env: { KEY: "secret" } } } }));
    chmodSync(cfgPath, 0o600);
    const m = make(emptyList, { claudeCode: false });
    await runSetup(m.opts);
    expect(statSync(cfgPath).mode & 0o777).toBe(0o600);
    const bak = readdirSync(cfgDir).find((f) => f.includes(".bak-"))!;
    expect(statSync(join(cfgDir, bak)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(cfgPath, "utf8")).mcpServers["safari-attraction"]).toEqual(CMD);
  });

  test("0640 같은 다른 권한도 그대로 잇는다", async () => {
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(cfgPath, "{}");
    chmodSync(cfgPath, 0o640);
    await runSetup(make(emptyList, { claudeCode: false }).opts);
    expect(statSync(cfgPath).mode & 0o777).toBe(0o640);
  });

  test("새로 만드는 파일은 0600", async () => {
    mkdirSync(cfgDir, { recursive: true });
    await runSetup(make(emptyList, { claudeCode: false }).opts);
    expect(statSync(cfgPath).mode & 0o777).toBe(0o600);
  });

  test("임시 파일이 남지 않는다", async () => {
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(cfgPath, "{}");
    await runSetup(make(emptyList, { claudeCode: false }).opts);
    expect(readdirSync(cfgDir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  test("설정 파일이 심볼릭 링크면 링크는 그대로, 가리키는 실제 파일에 우리 항목이 들어간다(사본도 실제 파일 옆)", async () => {
    mkdirSync(cfgDir, { recursive: true });
    const dotfiles = join(home, "dotfiles");
    mkdirSync(dotfiles);
    const target = join(dotfiles, "claude_desktop_config.json");
    const original = JSON.stringify({ mcpServers: { other: { command: "x" } } });
    writeFileSync(target, original);
    chmodSync(target, 0o600);
    symlinkSync(target, cfgPath);

    const m = make(emptyList, { claudeCode: false });
    expect(await runSetup(m.opts)).toBe(0);

    expect(lstatSync(cfgPath).isSymbolicLink()).toBe(true);
    expect(realpathSync(cfgPath)).toBe(realpathSync(target));
    expect(JSON.parse(readFileSync(target, "utf8")).mcpServers).toEqual({ other: { command: "x" }, "safari-attraction": CMD });
    expect(statSync(target).mode & 0o777).toBe(0o600);
    const baks = readdirSync(dotfiles).filter((f) => f.includes(".bak-"));
    expect(baks).toHaveLength(1);
    expect(readFileSync(join(dotfiles, baks[0]), "utf8")).toBe(original);
    expect(readdirSync(cfgDir)).toEqual(["claude_desktop_config.json"]); // 링크 폴더에는 새 파일 · 사본 없음
  });
});

describe("setup — Claude Code", () => {
  test("claude 명령이 없으면(Review Focus 3) 건너뛰는 안내 한 줄, 데스크톱은 한다", async () => {
    mkdirSync(cfgDir, { recursive: true });
    const m = make("missing");
    expect(await runSetup(m.opts)).toBe(0);
    expect(m.text()).toContain("Claude Code(claude 명령)를 찾지 못해 건너뜁니다");
    expect(adds(m.calls)).toHaveLength(0);
    expect(JSON.parse(readFileSync(cfgPath, "utf8")).mcpServers["safari-attraction"]).toEqual(CMD);
  });

  test("claude mcp list 는 120초까지 기다리고, 확인 중이라는 안내를 먼저 한 줄 보여 준다", async () => {
    mkdirSync(cfgDir, { recursive: true });
    const timeouts: Array<number | undefined> = [];
    const m = make(emptyList, {
      exec: async (_c, args, timeoutMs) => {
        if (args[1] === "list") timeouts.push(timeoutMs);
        return args[1] === "list" ? emptyList : { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(await runSetup(m.opts)).toBe(0);
    expect(timeouts).toEqual([120_000]);
    expect(m.text()).toContain("Claude Code 등록 상태를 확인하는 중이에요(최대 2분 걸릴 수 있어요)…");
  });

  test("claude mcp list 가 실패하면(0 이 아닌 코드) 「확인하지 못했어요」 + 직접 할 명령, add 는 안 부르고 1", async () => {
    const m = make({ code: 3, stdout: "", stderr: "Error: broken\nmore detail" });
    expect(await runSetup(m.opts)).toBe(1);
    const t = m.text();
    expect(t).toContain(
      "Claude Code 등록 상태를 확인하지 못했어요(Error: broken) — 나중에 `safari-attraction setup` 을 다시 실행하거나 " +
        "`claude mcp add --scope user safari-attraction -- /usr/local/bin/node /opt/sa/server.mjs` 을 직접 실행하세요",
    );
    expect(t).not.toContain("찾지 못해 건너뜁니다");
    expect(adds(m.calls)).toHaveLength(0);
  });

  test("claude mcp list 가 시간 초과 등 ENOENT 아닌 오류로 throw 해도 같은 안내, add 안 함", async () => {
    const m = make({ code: 1, stdout: "", stderr: "" }, {
      exec: async () => {
        throw new Error("timed out");
      },
    });
    expect(await runSetup(m.opts)).toBe(1);
    expect(m.text()).toContain("Claude Code 등록 상태를 확인하지 못했어요(timed out)");
    expect(m.text()).not.toContain("찾지 못해 건너뜁니다");
    expect(m.calls).toEqual([]);
  });

  test("플러그인이 이미 있으면(Review Focus 1) 등록하지 않는다", async () => {
    const listing = {
      code: 0,
      stdout: "plugin:safari-attraction:safari-attraction: node /x/server.mjs - ✓ Connected\n",
      stderr: "",
    };
    const m = make(listing, { desktop: false });
    expect(await runSetup(m.opts)).toBe(0);
    expect(m.text()).toContain("플러그인으로 이미 연결돼 있어요");
    expect(adds(m.calls)).toHaveLength(0);
  });

  test("이미 직접 등록돼 있으면 「이미 등록돼 있어요」, add 안 함", async () => {
    const listing = { code: 0, stdout: "other: x - ✓ Connected\nsafari-attraction: node /x/server.mjs - ✓ Connected\n", stderr: "" };
    const m = make(listing, { desktop: false });
    await runSetup(m.opts);
    expect(m.text()).toContain("이미 등록돼 있어요");
    expect(adds(m.calls)).toHaveLength(0);
  });

  test("--no-claude-code 이면 claude 를 부르지 않는다", async () => {
    mkdirSync(cfgDir, { recursive: true });
    const m = make(emptyList, { claudeCode: false });
    await runSetup(m.opts);
    expect(m.calls).toEqual([]);
  });

  test("claude mcp add 가 실패하면 알리고 1", async () => {
    const m = make(emptyList, {
      desktop: false,
      exec: async (_c, args) => (args[1] === "list" ? emptyList : { code: 1, stdout: "", stderr: "boom" }),
    });
    expect(await runSetup(m.opts)).toBe(1);
    expect(m.text()).toContain("boom");
  });
});

describe("setup --dry-run", () => {
  test("파일도 만들지 않고 add 도 부르지 않으며, 할 일만 출력", async () => {
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    const before = readFileSync(cfgPath, "utf8");
    let doctorCalls = 0;
    const doctor = async () => {
      doctorCalls++;
      return "x";
    };
    const m = make(emptyList, { dryRun: true, doctor });
    expect(await runSetup(m.opts)).toBe(0);

    expect(readFileSync(cfgPath, "utf8")).toBe(before);
    expect(readdirSync(cfgDir)).toEqual(["claude_desktop_config.json"]);
    expect(adds(m.calls)).toHaveLength(0);
    expect(doctorCalls).toBe(0);
    const t = m.text();
    expect(t).toContain("미리 보기");
    expect(t).toContain("claude mcp add --scope user safari-attraction -- /usr/local/bin/node /opt/sa/server.mjs");
    expect(t).toContain(cfgPath);
  });

  test("설정 파일이 없을 때도 만들지 않는다", async () => {
    mkdirSync(cfgDir, { recursive: true });
    const m = make(emptyList, { dryRun: true });
    await runSetup(m.opts);
    expect(existsSync(cfgPath)).toBe(false);
    expect(m.text()).toContain(cfgPath);
  });
});

describe("defaultServerCommand", () => {
  test("SAFARI_ATTRACTION_BIN 이 있으면 그 값, 인자 없음", () => {
    expect(defaultServerCommand({ SAFARI_ATTRACTION_BIN: "/opt/homebrew/opt/safari-attraction/bin/safari-attraction" }, "/x/server.mjs")).toEqual({
      command: "/opt/homebrew/opt/safari-attraction/bin/safari-attraction",
      args: [],
    });
  });
  test("없으면 node 실행 파일 + 묶음 파일 절대 경로", () => {
    expect(defaultServerCommand({}, "/x/server.mjs")).toEqual({ command: process.execPath, args: ["/x/server.mjs"] });
  });
  test("빈 문자열은 없는 것으로 본다", () => {
    expect(defaultServerCommand({ SAFARI_ATTRACTION_BIN: "" }, "/x/server.mjs").args).toEqual(["/x/server.mjs"]);
  });
});
