import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { VERSION } from "../../src/version.js";

const RUN_SH = resolve(__dirname, "../../plugin/run.sh");
const darwin = process.platform === "darwin";
const temps: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "sa-runsh-"));
  temps.push(home);
  return home;
}

function runIn(home: string) {
  return spawnSync("sh", [RUN_SH, "--version"], {
    env: { PATH: "/usr/bin:/bin", HOME: home },
    encoding: "utf8",
  });
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

describe("plugin/run.sh (node 찾기)", () => {
  test("실행 비트가 켜져 있다", () => {
    expect(statSync(RUN_SH).mode & 0o111).not.toBe(0);
  });

  test.skipIf(!darwin)("PATH 에 node 가 없어도 nvm 에서 가장 새 버전(≥18)을 골라 서버를 띄운다", () => {
    const home = makeHome();
    const old = join(home, ".nvm/versions/node/v9.0.0/bin");
    const cur = join(home, ".nvm/versions/node/v26.13.1/bin");
    mkdirSync(old, { recursive: true });
    mkdirSync(cur, { recursive: true });
    writeFileSync(join(old, "node"), "#!/bin/sh\necho 9\n");
    chmodSync(join(old, "node"), 0o755);
    symlinkSync(process.execPath, join(cur, "node"));
    const major = Number(process.versions.node.split(".")[0]);
    expect(major).toBeGreaterThanOrEqual(18);

    const r = runIn(home);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(VERSION);
  });

  test.skipIf(!darwin)("v9 는 v18·v26 보다 작게 센다(문자순이 아니라 버전순) — 너무 옛 것만 있으면 못 찾는다", () => {
    const home = makeHome();
    const old = join(home, ".nvm/versions/node/v9.0.0/bin");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "node"), "#!/bin/sh\necho 9\n");
    chmodSync(join(old, "node"), 0o755);
    const r = runIn(home);
    expect(r.status).toBe(1);
  });

  const reachable = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/opt/local/bin/node"].filter((p) => existsSync(p));
  test.skipIf(!darwin || reachable.length > 0)(
    // 이 맥에 홈브루 · MacPorts node 가 있으면 run.sh 가 그걸 찾아 버리므로 이 경우는 건너뛴다.
    "node 가 어디에도 없으면 한국어 안내를 stderr 에 찍고 1 로 끝난다",
    () => {
      const r = runIn(makeHome());
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("사파리-어트랙션: Node 18 이상을 찾지 못했어요.");
      expect(r.stderr).toContain("https://nodejs.org");
      expect(r.stderr).toContain("brew install node");
    },
  );
});
