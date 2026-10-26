import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** Container suites use an image built explicitly before Jest starts. */
export function requireDeploymentTestImage(): string {
  const image = process.env.DEPLOYMENT_TEST_IMAGE;
  if (!image)
    throw new Error(
      "DEPLOYMENT_TEST_IMAGE is required; build the deployment fixture before Jest",
    );
  execFileSync("docker", ["image", "inspect", image], { stdio: "pipe" });
  return image;
}

/** Optional generated receipts are retained outside tracked source for H7. */
export function writeDeploymentFixtureReceipt(
  name: string,
  measurements: Record<string, unknown>,
): void {
  const directory = process.env.DEPLOYMENT_TEST_EVIDENCE_DIR;
  if (!directory) return;
  if (!/^[a-z0-9-]+$/.test(name))
    throw new Error("Invalid generated receipt name");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, `${name}.json`),
    JSON.stringify(
      {
        ...measurements,
        schemaVersion: 1,
        scope: "generated-local",
        providerAcceptance: "UNKNOWN",
      },
      null,
      2,
    ) + "\n",
  );
}
