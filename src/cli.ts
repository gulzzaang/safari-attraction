import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { formatDoctor, runDoctor } from "./doctor.js";
import type { SafariDriver } from "./driver/types.js";
import { createJxaDriver } from "./driver/jxa-driver.js";
import { defaultServerCommand, runSetup, type ExecResult } from "./setup.js";
import { VERSION } from "./version.js";

export interface CliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  stdinIsTTY: boolean;
}

/** 시험 · 진입점이 바꿔 끼우는 것들. 안 주면 실제 값을 쓴다. */
export interface CliDeps {
  createDriver?: () => SafariDriver;
  /** setup 이 Claude 에 등록할 서버 묶음 파일의 절대 경로(진입점이 알려 준다). */
  selfPath?: string;
  env?: Record<string, string | undefined>;
  home?: string;
  exec?: (cmd: string, args: string[]) => Promise<ExecResult>;
  now?: () => Date;
}

export const HELP = `safari-attraction ${VERSION} — 평소 로그인된 사파리를 Claude 가 쓰게 하는 MCP 서버

사용법:
  safari-attraction setup [--dry-run] [--no-claude-code] [--no-desktop]
      Claude Code · Claude 데스크톱에 이 서버를 등록합니다.
      --dry-run          아무것도 바꾸지 않고 할 일만 보여 줍니다
      --no-claude-code   Claude Code 는 건너뜁니다
      --no-desktop       Claude 데스크톱은 건너뜁니다
  safari-attraction doctor
      사파리 준비(자동화 허락 · Apple 이벤트의 JavaScript 허용 등)를 점검합니다.
  safari-attraction --version
      버전을 보여 줍니다.
  safari-attraction help
      이 도움말을 보여 줍니다.

인자 없이 실행하고 표준입력이 터미널이 아니면 MCP 서버로 동작합니다(Claude 가 이렇게 띄웁니다).
터미널에서 인자 없이 치면 이 도움말만 보여 주고 끝납니다.`;

function realExec(cmd: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return reject(err);
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

/** 점검을 돌려 결과 글과 모두 ok 인지를 돌려준다. 어떤 길로 끝나든 시험 탭 · 사파리 호스트를 닫는다. */
async function doctorText(driver: SafariDriver): Promise<{ text: string; allOk: boolean }> {
  try {
    const report = await runDoctor(driver);
    return { text: formatDoctor(report), allOk: report.items.every((i) => i.state === "ok") };
  } finally {
    try {
      await driver.closeOwned();
    } finally {
      await driver.close();
    }
  }
}

const SETUP_FLAGS = new Set(["--dry-run", "--no-claude-code", "--no-desktop"]);

/** "serve" 면 호출한 쪽이 MCP 서버를 띄운다. 숫자면 그 종료 코드로 끝낸다. */
export async function runCli(argv: string[], io: CliIo, deps: CliDeps = {}): Promise<number | "serve"> {
  const [cmd, ...rest] = argv;
  if (cmd === undefined) {
    if (!io.stdinIsTTY) return "serve";
    io.stdout(HELP);
    return 0;
  }
  switch (cmd) {
    case "--version":
    case "-v":
      io.stdout(VERSION);
      return 0;
    case "help":
    case "--help":
    case "-h":
      io.stdout(HELP);
      return 0;
    case "doctor": {
      if (rest.length) break;
      const { text, allOk } = await doctorText((deps.createDriver ?? createJxaDriver)());
      io.stdout(text);
      return allOk ? 0 : 1;
    }
    case "setup": {
      const bad = rest.find((a) => !SETUP_FLAGS.has(a));
      if (bad !== undefined) {
        io.stderr(`모르는 옵션: ${bad}`);
        io.stdout(HELP);
        return 2;
      }
      return runSetup({
        dryRun: rest.includes("--dry-run"),
        claudeCode: !rest.includes("--no-claude-code"),
        desktop: !rest.includes("--no-desktop"),
        serverCommand: defaultServerCommand(deps.env ?? process.env, deps.selfPath ?? process.argv[1] ?? ""),
        home: deps.home ?? homedir(),
        exec: deps.exec ?? realExec,
        now: deps.now ?? (() => new Date()),
        log: io.stdout,
        doctor: async () => (await doctorText((deps.createDriver ?? createJxaDriver)())).text,
      });
    }
  }
  io.stderr(`모르는 명령: ${argv.join(" ")}`);
  io.stdout(HELP);
  return 2;
}
