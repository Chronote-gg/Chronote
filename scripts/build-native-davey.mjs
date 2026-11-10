import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = join(root, "native/davey");
if (process.arch !== "x64" || !["linux", "win32"].includes(process.platform)) {
  throw new Error("Patched Davey requires Linux or Windows x64");
}
if (
  process.platform === "linux" &&
  !process.report.getReport().header.glibcVersionRuntime
) {
  throw new Error("Patched Davey requires a glibc Linux runtime");
}
let artifact = process.env.DAVEY_NATIVE_ARTIFACT;
if (!artifact) {
  const toolchain = spawnSync(
    "rustup",
    ["toolchain", "install", "1.88.0", "--profile", "minimal"],
    { stdio: "inherit" },
  );
  if (toolchain.error) throw toolchain.error;
  if (toolchain.status !== 0) throw new Error("Rust 1.88.0 setup failed");
  const build = spawnSync(
    "cargo",
    ["+1.88.0", "build", "--locked", "--release", "-p", "snazzah_davey"],
    {
      cwd: nativeRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        CARGO_TARGET_DIR: join(nativeRoot, "target"),
        npm_package_version: "0.1.12",
      },
    },
  );
  if (build.error) throw build.error;
  if (build.status !== 0) throw new Error("Patched Davey source build failed");
  artifact = join(
    nativeRoot,
    "target/release",
    process.platform === "win32" ? "snazzah_davey.dll" : "libsnazzah_davey.so",
  );
}
const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve("@snazzah/davey/package.json"));
const destination = join(
  packageRoot,
  process.platform === "win32"
    ? "davey.win32-x64-msvc.node"
    : "davey.linux-x64-gnu.node",
);
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(artifact, destination);
const binding = require(destination);
if (typeof binding.DAVESession !== "function")
  throw new Error("Patched Davey binding failed to load");
