import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { requireDeploymentTestImage } from "./containerFixture";
const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: "pipe" }).trim();
const image = requireDeploymentTestImage();
const fixture = path.resolve("test/deployment/fixtures/nativeShutdown.cjs");
test.each(["all", "bot"] as const)(
  "Linux %s output is owned and removable by the invoking nonroot user",
  async (mode) => {
    const owner = randomUUID();
    const volume = `chronote-r4-output-${owner}`;
    const label = `chronote.r3.fixture=${owner}`;
    docker("volume", "create", "--label", label, volume);
    const mount = `type=volume,source=${volume},target=/fixture-output`;
    const helper = (script: string, user = "1001:1001") =>
      docker(
        "run",
        "--rm",
        "--network",
        "none",
        "--label",
        label,
        "--user",
        user,
        "--mount",
        mount,
        image,
        "node",
        "-e",
        script,
      );
    let container: string | undefined;
    try {
      // Only the newly created, identity-labeled volume is initialized by root.
      helper(
        'require("node:fs").chownSync("/fixture-output",1001,1001)',
        "0:0",
      );
      const caller = helper(
        "console.log(`${process.getuid()}:${process.getgid()}`)",
      );
      expect(caller).toBe("1001:1001");
      container = docker(
        "run",
        "--detach",
        "--network",
        "none",
        "--label",
        label,
        "--user",
        caller,
        "--mount",
        mount,
        "--mount",
        `type=bind,source=${fixture},target=/app/nativeShutdown.cjs,readonly`,
        "--env",
        "NODE_OPTIONS=--require=/app/nativeShutdown.cjs",
        image,
        ...(mode === "all" ? [] : ["node", `dist/apps/${mode}/main.js`]),
      );
      const deadline = Date.now() + 30000;
      while (
        helper(
          'console.log(require("node:fs").existsSync("/fixture-output/ready.json"))',
        ) !== "true"
      ) {
        if (
          docker("inspect", "--format", "{{.State.Running}}", container) !==
          "true"
        )
          throw new Error(docker("logs", container));
        if (Date.now() >= deadline)
          throw new Error("Linux nonroot fixture readiness timeout");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(
        helper(
          'const s=require("node:fs").statSync("/fixture-output/ready.json"); console.log(`${s.uid}:${s.gid}`)',
        ),
      ).toBe(caller);
      docker("kill", "--signal", "SIGTERM", container);
      expect(docker("wait", container)).toBe("0");
      expect(
        helper(
          'console.log(JSON.parse(require("node:fs").readFileSync("/fixture-output/exit.json")).captureFinished)',
        ),
      ).toBe("true");
      helper(
        'const fs=require("node:fs"); for(const name of fs.readdirSync("/fixture-output")) fs.rmSync(require("node:path").join("/fixture-output",name),{recursive:true}); if(fs.readdirSync("/fixture-output").length) throw new Error("output remains")',
      );
      console.log(
        `Linux ${mode}: caller=${caller}, SIGTERM=0, owned output cleanup acknowledged`,
      );
    } finally {
      if (container) {
        expect(
          docker(
            "inspect",
            "--format",
            '{{index .Config.Labels "chronote.r3.fixture"}}',
            container,
          ),
        ).toBe(owner);
        docker("rm", "--force", container);
      }
      expect(
        docker(
          "volume",
          "inspect",
          "--format",
          '{{index .Labels "chronote.r3.fixture"}}',
          volume,
        ),
      ).toBe(owner);
      docker("volume", "rm", volume);
    }
  },
);
