import { z } from "zod";
import type {
  PublicationProfile,
  RuntimeCompatibility,
} from "./firstPublicationTypes";
import { digest } from "./firstPublicationTypes";
export const publicationReleaseSchema = z
  .object({
    contract: z.literal("first_publication_archive_fence_v1"),
    images: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/)),
  })
  .strict();
export type RuntimeReadDependencies = {
  readControl(): Promise<Record<string, unknown>>;
  listServiceTasks(scope: {
    cluster: string;
    service: string;
  }): Promise<
    Array<{ taskArn: string; imageDigests: string[]; ready: boolean }>
  >;
  releases: unknown;
};
export async function inspectFirstPublicationRuntime(
  profile: PublicationProfile,
  deps: RuntimeReadDependencies,
): Promise<RuntimeCompatibility> {
  try {
    const release = publicationReleaseSchema.parse(deps.releases),
      before = await deps.readControl();
    if (before.publicationProtocol !== 1)
      return {
        kind: "blocked",
        reason: "Install a publication-compatible runtime release before apply",
      };
    if (
      before.publicationTransition ||
      typeof before.servingGeneration !== "number" ||
      typeof before.coordinatorEpoch !== "number" ||
      (before.deployment &&
        z.object({ phase: z.string() }).parse(before.deployment).phase !==
          "complete")
    )
      return {
        kind: "blocked",
        reason: "Deployment is changing; rerun after it settles",
      };
    const groups = await Promise.all(
      profile.archiveWriters.map((scope) => deps.listServiceTasks(scope)),
    );
    if (
      groups.some(
        (tasks) =>
          !tasks.length ||
          tasks.some((t) => !t.ready || !t.imageDigests.length),
      )
    )
      return {
        kind: "blocked",
        reason:
          "Serving cohort unavailable or replacing; retry after deployment",
      };
    const images = groups.flatMap((g) => g.flatMap((t) => t.imageDigests));
    const members = z
      .record(z.string(), z.object({ imageDigest: z.string() }).passthrough())
      .parse(before.servingMembers ?? {});
    images.push(...Object.values(members).map((m) => m.imageDigest));
    if (
      !images.length ||
      images.some((image) => !release.images.includes(image))
    )
      return {
        kind: "blocked",
        reason:
          "Unknown serving image; install a current operator release or compatible runtime",
      };
    const after = await deps.readControl();
    if (digest(before) !== digest(after))
      return {
        kind: "blocked",
        reason: "Serving generation changed; refresh preview",
      };
    return {
      kind: "compatible",
      generation: before.servingGeneration,
      control: before,
    };
  } catch {
    return {
      kind: "blocked",
      reason:
        "Runtime compatibility unavailable; check operator profile or retry",
    };
  }
}
