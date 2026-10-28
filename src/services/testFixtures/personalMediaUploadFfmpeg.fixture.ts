import { jest } from "@jest/globals";
import * as fs from "node:fs";
import * as path from "node:path";

export function createPersonalUploadFfmpegFake(state: {
  getConcatLists: () => string[];
  isHeld: () => boolean;
  captureEnd: (handler: (() => void) | undefined) => void;
  getKill: () => ReturnType<typeof jest.fn>;
}) {
  const ffmpeg = jest.fn(() => {
    const handlers: { endHandler: (() => void) | undefined } = {
      endHandler: undefined,
    };
    const command = {
      ...handlers,
      inputPath: "",
      outputPath: "",
      outputOptionList: [] as string[],
      noVideo() {
        return this;
      },
      audioCodec() {
        return this;
      },
      audioBitrate() {
        return this;
      },
      audioChannels() {
        return this;
      },
      audioFrequency() {
        return this;
      },
      input(inputPath: string) {
        this.inputPath = inputPath;
        return this;
      },
      inputOptions() {
        return this;
      },
      outputOptions(options: string[]) {
        this.outputOptionList.push(...options);
        return this;
      },
      complexFilter() {
        return this;
      },
      output(outputPath: string) {
        this.outputPath = outputPath;
        return this;
      },
      on(event: string, handler: () => void) {
        if (event === "end") this.endHandler = handler;
        return this;
      },
      kill: state.getKill(),
      run() {
        if (this.inputPath.endsWith(".txt")) {
          state.getConcatLists().push(fs.readFileSync(this.inputPath, "utf8"));
        }
        if (this.outputPath) {
          fs.mkdirSync(path.dirname(this.outputPath), { recursive: true });
          // The segment muxer expands the %03d pattern into numbered chunks.
          const writtenPath = this.outputPath.replace("%03d", "000");
          fs.writeFileSync(writtenPath, Buffer.from("audio"));
        }
        if (state.isHeld()) state.captureEnd(this.endHandler);
        else this.endHandler?.();
        return this;
      },
    };
    return command;
  });
  Object.assign(ffmpeg, {
    ffprobe: jest.fn(
      (
        _filePath: string,
        callback: (
          error: null,
          metadata: { format: { duration: number } },
        ) => void,
      ) => callback(null, { format: { duration: 1 } }),
    ),
  });
  return ffmpeg;
}
