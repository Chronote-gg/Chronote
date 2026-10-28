/** @jest-environment node */
import { jest } from "@jest/globals";
import ffmpeg from "fluent-ffmpeg";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PERSONAL_UPLOAD_TRANSCRIPTION_CHUNK_SECONDS } from "../../constants";
import {
  resolveTranscriptionInputs,
  transcribeAudioFiles,
} from "../personalMediaUploadProcessingService";

const mockTranscribe = jest.fn<(request: object) => Promise<{ text: string }>>(
  async () => ({ text: "chunk transcript" }),
);

jest.mock("fluent-ffmpeg", () => {
  const { createPersonalUploadFfmpegFake } = jest.requireActual<
    typeof import("../testFixtures/personalMediaUploadFfmpeg.fixture")
  >("../testFixtures/personalMediaUploadFfmpeg.fixture");
  return createPersonalUploadFfmpegFake({
    getConcatLists: () => [],
    isHeld: () => false,
    captureEnd: () => undefined,
    getKill: () => jest.fn(),
  });
});

jest.mock("../openaiClient", () => ({
  createOpenAIClient: jest.fn(() => ({
    audio: { transcriptions: { create: mockTranscribe } },
  })),
}));

jest.mock("../modelFactory", () => ({
  getModelChoice: jest.fn(() => ({ model: "gpt-4o-transcribe" })),
}));

describe("personal upload transcription inputs", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "personal-upload-"));
  });

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it("splits even a small file by duration so no request exceeds the output cap", async () => {
    const audioPath = path.join(workDir, "audio.mp3");
    await fs.writeFile(audioPath, Buffer.from("audio"));

    const inputs = await resolveTranscriptionInputs(audioPath, workDir);

    expect(inputs).toEqual([path.join(workDir, "chunks", "chunk-000.mp3")]);
    const segmentCommand = jest.mocked(ffmpeg).mock.results[0].value as {
      outputOptionList: string[];
    };
    expect(segmentCommand.outputOptionList).toEqual(
      expect.arrayContaining([
        "-segment_time",
        String(PERSONAL_UPLOAD_TRANSCRIPTION_CHUNK_SECONDS),
      ]),
    );
  });

  it("lets the provider detect the spoken language", async () => {
    const chunkPath = path.join(workDir, "chunk-000.mp3");
    await fs.writeFile(chunkPath, Buffer.from("audio"));

    const result = await transcribeAudioFiles([chunkPath], false);

    expect(result).toEqual({ text: "chunk transcript", failedChunks: 0 });
    expect(mockTranscribe.mock.calls[0][0]).not.toHaveProperty("language");
  });
});
