# Dependency security maintenance

Audit the resolved root and desktop lockfiles during weekly dependency maintenance. Updating direct dependencies does not refresh every transitive dependency. In particular, a root Yarn resolution can retain a vulnerable version even when its parent requests a fixed version.

```sh
yarn audit --json
yarn --cwd apps/desktop audit --json
cargo audit --file apps/desktop/src-tauri/Cargo.lock
```

Compare distinct advisory IDs, affected versions and dependency paths. Yarn reports the same advisory for multiple paths. Preserve the application's supported Node major and other compatibility constraints when updating security resolutions. Reapply package patches after installation and verify their behavior, builds and CI.

The KaTeX 0.18.2 resolution is intentionally exact. The later 0.18.11 release is deprecated upstream for accidentally published breaking changes; assess the 0.19 migration explicitly before changing this pin.

## Remaining advisories assessed on 2026-10-28

| Dependency      | Advisory and upstream limit                                                                                                | Current exposure and follow-up                                                                                                                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Quill 2.0.3     | [GHSA-v3m3-f69x-jf25](https://github.com/advisories/GHSA-v3m3-f69x-jf25), XSS in HTML export; no fixed release is listed.  | The meeting notes editor saves Delta operations and does not directly call `getSemanticHTML` or inject its exported HTML. This limits the identified path but does not remove the vulnerable package. Reassess when a fixed Quill release or wrapper is available. |
| deepmerge 4.3.1 | [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4), prototype poisoning; no fixed release is listed. | Transitive through Jest and documentation build tooling. Avoid merging untrusted objects through these tools, and reassess upstream fixes or compatible replacements.                                                                                              |
| GLib 0.18.5     | [GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g), unsound `VariantStrIter`; fixed in 0.20.0.       | Tauri's Linux GTK dependencies require the 0.18 family. The locked Windows target has no GLib dependency. Reassess the framework's GTK chain before supporting Linux; forcing a different GLib minor breaks its dependency contracts.                              |

These entries are tracked limitations, not dismissed or fixed alerts. Recheck the advisory database and actual dependency paths on each maintenance run. Do not infer that GitHub's alert count has cleared from a successful build or from this document.

Cargo audit also reports `proc-macro-error` 1.0.4 as unmaintained ([RUSTSEC-2024-0370](https://rustsec.org/advisories/RUSTSEC-2024-0370.html)). It is inherited through the Linux GTK chain and is absent from the locked Windows target. Reassess it with that framework migration.
