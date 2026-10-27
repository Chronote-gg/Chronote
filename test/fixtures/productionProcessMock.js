import { jest } from "@jest/globals";
export function promisifiedExecFileMock(invoke) {
  const execFile = () => undefined;
  execFile[Symbol.for("nodejs.util.promisify.custom")] = (...args) =>
    invoke(...args);
  return execFile;
}
export function processModuleMock(invoke, extra = {}) {
  return {
    ...jest.requireActual("node:child_process"),
    execFile: promisifiedExecFileMock(invoke),
    ...extra,
  };
}

export function reviewedProcessModuleMock(invoke) {
  return processModuleMock(invoke, {
    execFileSync: jest.fn((_file, args) =>
      args[0] === "rev-parse" ? "a".repeat(40) : "",
    ),
  });
}
