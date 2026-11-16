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
