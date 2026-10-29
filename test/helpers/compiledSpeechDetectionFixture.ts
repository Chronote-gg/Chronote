import { cpSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";

export function removeOwnedFixture(fixture: string, prefix: string): void {
  const resolved = path.resolve(fixture);
  if (
    path.dirname(resolved) !== path.resolve(tmpdir()) ||
    !path.basename(resolved).startsWith(prefix)
  )
    throw Error("Unexpected cleanup path");
  rmSync(resolved, { recursive: true, force: true });
}

// Compile selected current-source roots and their transitive imports, never checkout dist.
export function compileSpeechFixture(
  root: string,
  fixture: string,
  entries: string[],
  dependencyRoot = root,
): string[] {
  const resolved = path.resolve(fixture);
  if (
    path.dirname(resolved) !== path.resolve(tmpdir()) ||
    !["chronote-vad-", "chronote-packaging-", "vad-build-contract-"].some(
      (prefix) => path.basename(resolved).startsWith(prefix),
    )
  )
    throw Error("Unexpected compilation output path");
  const config = ts.readConfigFile(
    path.join(root, "tsconfig.json"),
    ts.sys.readFile,
  );
  if (config.error)
    throw Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
    );
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram({
    rootNames: entries
      .map((entry) => path.join(root, "src", entry))
      .concat(parsed.fileNames.filter((file) => file.endsWith(".d.ts"))),
    options: {
      ...parsed.options,
      types: [...new Set(["node", ...(parsed.options.types ?? [])])],
      typeRoots: [path.join(dependencyRoot, "node_modules/@types")],
      paths: { "*": [path.join(dependencyRoot, "node_modules/*")] },
      rootDir: path.join(root, "src"),
      outDir: path.join(fixture, "dist"),
      noEmit: false,
      noEmitOnError: true,
      incremental: false,
    },
  });
  const host = {
    getCanonicalFileName: (file: string) => file,
    getCurrentDirectory: () => root,
    getNewLine: () => "\n",
  };
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  if (diagnostics.length) throw Error(ts.formatDiagnostics(diagnostics, host));
  const emitted = program.emit();
  if (emitted.emitSkipped || emitted.diagnostics.length)
    throw Error(
      `Speech fixture compilation failed\n${ts.formatDiagnostics(emitted.diagnostics, host)}`,
    );
  mkdirSync(path.join(fixture, "dist/assets"), { recursive: true });
  cpSync(
    path.join(root, "assets/speech-detection"),
    path.join(fixture, "dist/assets/speech-detection"),
    { recursive: true },
  );
  return program
    .getSourceFiles()
    .map((file) => path.relative(root, file.fileName))
    .filter((file) => file.split(path.sep)[0] === "src");
}
