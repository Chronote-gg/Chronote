import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import type { MeetingData } from "../../src/types/meeting-data";
import type { initializeMeeting } from "../../src/meetings";

/** Execute the production initialization/catch/disposal owner with external setup injected. */
export function failedInitializationRuntime(bindings: Record<string, unknown>) {
  const filename = resolve(__dirname, "../../src/meetings.ts");
  const parsed = ts.createSourceFile(
    filename,
    readFileSync(filename, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set([
    "initializeMeeting",
    "initializeNewMeeting",
    "disposeFailedInitialization",
    "assertFixtureStartOptions",
    "assertVerifiedFixture",
    "getPendingMeetingInitializations",
  ]);
  const declarations = parsed.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? ""),
  );
  if (declarations.length !== names.size)
    throw new Error("Missing production initialization owner");
  const sandbox = vm.createContext({
    AbortController,
    AbortSignal,
    Date,
    setTimeout,
    clearTimeout,
    clearInterval,
    initializationsClosed: false,
    meetingInitializations: new Map(),
    ...bindings,
  });
  vm.runInContext(
    ts.transpileModule(
      declarations
        .map((node) => node.getText(parsed).replace(/^export /, ""))
        .join("\n"),
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    sandbox,
  );
  return {
    initialize(
      options: Parameters<typeof initializeMeeting>[0],
    ): Promise<MeetingData> {
      sandbox.options = options;
      return vm.runInContext("initializeMeeting(options)", sandbox);
    },
    dispose(meeting: MeetingData): Promise<boolean> {
      sandbox.disposal = { meeting, cleanup: [] };
      return vm.runInContext("disposeFailedInitialization(disposal)", sandbox);
    },
    pending(): ReturnType<
      typeof import("../../src/meetings").getPendingMeetingInitializations
    > {
      return vm.runInContext("getPendingMeetingInitializations()", sandbox);
    },
  };
}
