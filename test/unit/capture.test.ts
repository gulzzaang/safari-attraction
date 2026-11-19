import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { captureWindowPng, type RunCmd } from "../../src/driver/capture.js";

const PNG_BIG = Buffer.from("89504e470d0a1a0a" + "aa".repeat(64), "hex");
const PNG_SMALL = Buffer.from("89504e470d0a1a0a" + "bb".repeat(8), "hex");

describe("captureWindowPng(창 찍기)", () => {
  test("screencapture 가 could not create image 를 내면 SCREEN_CAPTURE_DENIED", async () => {
    const seen: string[] = [];
    const run: RunCmd = async (cmd, args) => {
      seen.push(cmd);
      seen.push(args.at(-1)!);
      return { code: 1, stdout: "", stderr: "could not create image from window 81114" };
    };
    await expect(captureWindowPng(81114, run)).rejects.toMatchObject({ code: "SCREEN_CAPTURE_DENIED" });
    expect(seen[0]).toBe("screencapture");
    expect(existsSync(seen[1]!)).toBe(false); // 임시 파일이 남지 않는다
  });

  test("끝났는데 파일이 비었으면 SCREEN_CAPTURE_DENIED", async () => {
    const run: RunCmd = async (_cmd, args) => {
      writeFileSync(args.at(-1)!, Buffer.alloc(0));
      return { code: 0, stdout: "", stderr: "" };
    };
    await expect(captureWindowPng(5, run)).rejects.toMatchObject({ code: "SCREEN_CAPTURE_DENIED" });
  });

  test("성공하면 sips 로 줄인 PNG 를 돌려주고 임시 파일을 지운다", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    let tmp = "";
    const run: RunCmd = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "screencapture") {
        tmp = args.at(-1)!;
        writeFileSync(tmp, PNG_BIG);
      } else {
        expect(readFileSync(args.at(-1)!).equals(PNG_BIG)).toBe(true); // sips 는 찍은 파일을 받는다
        writeFileSync(args.at(-1)!, PNG_SMALL); // 제자리에서 줄인다
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const png = await captureWindowPng(81114, run);
    expect(png.equals(PNG_SMALL)).toBe(true);
    const shot = calls[0]!;
    expect(shot.cmd).toBe("screencapture");
    expect(shot.args).toEqual(expect.arrayContaining(["-l", "81114", "-o", "-x"]));
    expect(shot.args.indexOf("81114")).toBe(shot.args.indexOf("-l") + 1);
    const resize = calls[1]!;
    expect(resize.cmd).toBe("sips");
    expect(resize.args).toEqual(expect.arrayContaining(["-Z", "1568"]));
    expect(resize.args.indexOf("1568")).toBe(resize.args.indexOf("-Z") + 1);
    expect(resize.args.at(-1)).toBe(tmp);
    expect(existsSync(tmp)).toBe(false);
  });

  test("sips 가 실패해도 임시 파일을 지운다", async () => {
    let tmp = "";
    const run: RunCmd = async (cmd, args) => {
      tmp = args.at(-1)!;
      if (cmd === "screencapture") {
        writeFileSync(tmp, PNG_BIG);
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "boom" };
    };
    await expect(captureWindowPng(5, run)).rejects.toMatchObject({ code: "SAFARI_ERROR" });
    expect(existsSync(tmp)).toBe(false);
  });
});
