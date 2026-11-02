# Dependency security maintenance

Audit the resolved root and desktop lockfiles during weekly dependency maintenance. Updating direct dependencies does not refresh every transitive dependency. In particular, a root Yarn resolution can retain a vulnerable version even when its parent requests a fixed version.

```sh
yarn audit --json
yarn --cwd apps/desktop audit --json
cargo audit --file apps/desktop/src-tauri/Cargo.lock
```

Compare distinct advisory IDs, affected versions and dependency paths. Yarn reports the same advisory for multiple paths. Preserve the application's supported Node major and other compatibility constraints when updating security resolutions. Reapply package patches after installation and verify their behavior, builds and CI.

The KaTeX 0.18.2 resolution is intentionally exact. The later 0.18.11 release is deprecated upstream for accidentally published breaking changes; assess the 0.19 migration explicitly before changing this pin.

## Compatibility decisions on 2026-10-28

The dependency refresh includes compatible npm and Cargo lockfile updates, the desktop's `rand` 0.10 migration, Boto3, Grafana provider 4.53 and current setup actions. `rand` uses the fallible `SysRng` API to preserve OS-backed token entropy and error propagation. Setup-uv is pinned to the immutable v10.3.3 commit because upstream no longer publishes major-version tags.

Keep ONNX Runtime Node at 1.30.0 despite the available 1.31.1 release. The [speech runtime asset manifest](../../assets/speech-detection/PROVENANCE.md) verifies exact native binaries and JavaScript modules, and the [resource acceptance decision](../adr-20261027-speech-detector-process.md) is tied to that engine. An upgrade must regenerate and verify every supported platform's inventory and repeat compiled-worker resource acceptance before changing the pin. The Python evaluation engine is independently pinned in `scripts/evals/requirements-vad.txt`.

Keep TypeScript 6 until its consumers support the TypeScript 7 compiler API, and retain the OpenTelemetry versions required by Langfuse. Transitive major upgrades such as Undici, js-yaml and Markdown-it need their parent packages' compatibility reviewed before replacing the current security-fixed resolutions. Recheck these decisions during the next maintenance run.

## Compatibility decisions on 2026-11-02

Use Node 24.22.2 consistently in `.nvmrc`, the Docker bases, the speech benchmark acceptance validator and the engine floor. Acceptance fixtures use the same runtime and explicitly reject evidence from the previous runtime. Refresh compatible SDKs and lockfiles, including AWS SDK 3.1161, OpenAI 7.47, Langfuse 6.1, PostHog and the AWS Terraform provider 6.71. The AWS update also refreshes the [audited delivery source model](../terraform-meeting-source-model.md), exact installed-provider evidence and production-bootstrap lock without changing its plan allowances. The Langfuse numeric-token-details patch still applies to 6.1 and must remain in place.

Upgrade Lizard from 1.24.1 to [1.25.0](https://github.com/terryyin/lizard/releases/tag/1.25.0), whose release fixes the TypeScript callback and delimiter parser regressions behind the old pin. The repository TypeScript/TSX/JavaScript/JSX scan completes successfully. Continue excluding the known-bad 1.24.2 and 1.24.3 releases.

Keep the three tRPC packages together at 11.22.1. At this maintenance check, `@trpc/react-query` 11.23.0 requires client and server 11.23.0, but the client 11.23.0 registry endpoint returns 404. Reassess the complete release before advancing this coordinated pin.

Retain these proposals from dependency PR [#520](https://github.com/Chronote-gg/Chronote/pull/520) for a separate compatibility migration:

| Proposal                    | Reason to retain the current version                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ONNX Runtime 1.31.1         | The 1.30.0 binary inventory and compiled-worker resource acceptance remain intentional requirements, described above.                                                           |
| Stripe 23.1.0               | Its changelog changes the SDK's pinned API to `2026-10-28.endive`. Keep SDK 23.0.1 and the explicit `2026-09-30.endive` API together to preserve this batch's billing contract. |
| http-proxy-middleware 4.2.1 | Webpack Dev Server 5 still invokes the legacy two-argument proxy factory. Its consumer must migrate before a global major-version override.                                     |
| Webpack Dev Server 6.1.0    | Docusaurus 3.10.2 declares version 5.2.2 or a compatible 5.x release. Do not force a new major through the resolution.                                                          |
| protobufjs 8.8.1            | The installed gRPC proto loader declares protobufjs 7.5.5 or a compatible 7.x release. Preserve its supported runtime family.                                                   |

These proposals are not incorporated by the compatible refresh. Keep #520 open until its remaining changes are incorporated safely or a maintainer explicitly chooses to retire them. The TypeScript, OpenTelemetry, KaTeX and other transitive-major holds above also remain in effect.

Release references: [Node](https://github.com/nodejs/node/releases/tag/v24.22.2), [AWS SDK](https://github.com/aws/aws-sdk-js-v3/releases/tag/v3.1161.0), [OpenAI](https://github.com/openai/openai-node/releases/tag/v7.47.0), [Langfuse](https://github.com/langfuse/langfuse-js/releases/tag/v6.1.0), [tRPC](https://github.com/trpc/trpc/releases/tag/v11.22.1), [Stripe changelog](https://github.com/stripe/stripe-node/blob/v23.1.0/CHANGELOG.md), and [AWS provider](https://github.com/hashicorp/terraform-provider-aws/releases/tag/v6.71.0).

The security refresh sets a RE2JS 2.8.7 floor and uses scoped Glob 14.0.2 and Minimatch 11.0.1 floors for modern consumers. Those consumers use named exports; legacy Glob 7 and Minimatch 3 consumers retain their existing APIs. Compare coverage-file discovery through the actual old and new TestExclude and Jest reporter dependencies, and run lint, coverage and Storybook checks when changing these scopes. See the [RE2JS](https://github.com/advisories/GHSA-gg6h-894w-4m9c), [Glob](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) and [Minimatch](https://github.com/advisories/GHSA-g3hv-75wg-m249) advisories.

## Remaining advisories assessed on 2026-11-02

| Dependency      | Advisory and upstream limit                                                                                                                                  | Current exposure and follow-up                                                                                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Quill 2.0.3     | [GHSA-v3m3-f69x-jf25](https://github.com/advisories/GHSA-v3m3-f69x-jf25), XSS in HTML export; no fixed release is listed.                                    | The meeting notes editor saves Delta operations and does not directly call `getSemanticHTML` or inject its exported HTML. This limits the identified path but does not remove the vulnerable package. Reassess when a fixed Quill release or wrapper is available. |
| deepmerge 4.3.1 | [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4), prototype poisoning; no fixed release is listed.                                   | Transitive through Jest and documentation build tooling. Avoid merging untrusted objects through these tools, and reassess upstream fixes or compatible replacements.                                                                                              |
| Minimatch 3.1.5 | [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249), glob-pattern denial of service; fixed in 11.0.1, with no fixed 3.x release listed. | Retained by documentation preview, NYC and npm-run-all tooling, whose callers use the legacy callable module. Keep patterns repository-controlled. A global Minimatch 11 override would break those APIs; migrate the parents before removing these copies.        |
| GLib 0.18.5     | [GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g), unsound `VariantStrIter`; fixed in 0.20.0.                                         | Tauri's Linux GTK dependencies require the 0.18 family. The locked Windows target has no GLib dependency. Reassess the framework's GTK chain before supporting Linux; forcing a different GLib minor breaks its dependency contracts.                              |

These entries are tracked limitations, not dismissed or fixed alerts. Recheck the advisory database and actual dependency paths on each maintenance run. Do not infer that GitHub's alert count has cleared from a successful build or from this document.

Cargo audit also reports `proc-macro-error` 1.0.4 as unmaintained ([RUSTSEC-2024-0370](https://rustsec.org/advisories/RUSTSEC-2024-0370.html)). It is inherited through the Linux GTK chain and is absent from the locked Windows target. Reassess it with that framework migration.
