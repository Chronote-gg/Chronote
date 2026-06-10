# Chronote Desktop Productization

Status: beta productization in progress.

Tracking issue: [#249](https://github.com/Chronote-gg/Chronote/issues/249)

## Current Release Posture

- Windows is the first supported desktop target.
- Desktop API access remains gated by `ENABLE_DESKTOP_API` and `DESKTOP_ALLOWED_USER_IDS` or `SUPER_ADMIN_USER_IDS`.
- Production desktop builds must not include OpenAI credentials.
- Beta artifacts may be unsigned while the Windows Authenticode provider is deferred.
- Stable releases are blocked until Authenticode signing is configured and verified.
- Updater UX is deferred until release artifacts and updater metadata are reliable.

## CI/CD Surfaces

### PR and Master Desktop Package Gate

`.github/workflows/desktop-package.yml` runs only when desktop/release files change, or when manually dispatched.

It has two Windows jobs:

- `Build Windows Desktop Artifacts`: builds unsigned Tauri Windows bundles, validates artifacts, writes `SHA256SUMS.txt`, and uploads workflow artifacts.
- `Native Desktop Smoke`: builds a test-flavored desktop binary and launches it through `tauri-driver` against a mock local Chronote API.

The native smoke test verifies the Tauri shell, desktop API flow, audio capture commands, upload flow, and rendered meeting link. Installer install/uninstall validation remains in the manual hardware smoke checklist.

The smoke build uses two Rust features that must not be enabled for production releases:

- `synthetic-audio`: returns deterministic fake mic/output devices, writes valid WAV files, and emits signal events without hardware.
- `test-hooks`: preloads a desktop session from CI environment variables so the smoke test avoids brittle browser OAuth automation.

### Manual Desktop Release

`.github/workflows/desktop-release.yml` is manually dispatched with a tag such as `desktop-v0.1.0-beta.1`.

It creates a draft GitHub Release and uploads Windows artifacts plus `SHA256SUMS.txt`.

By default the workflow builds unsigned beta artifacts with `--no-sign`. Set `DESKTOP_SIGNING_ENABLED=true` in the protected `desktop-release` GitHub environment only after Azure Artifact Signing and signature verification are ready.

Required `desktop-release` environment variables for signed builds:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `AZURE_ARTIFACT_SIGNING_ENDPOINT`
- `AZURE_ARTIFACT_SIGNING_ACCOUNT_NAME`
- `AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE_NAME`
- `DESKTOP_SIGNING_ENABLED=true`

The signed path uses GitHub OIDC through `azure/login`, signs built `.exe` and `.msi` files with `azure/artifact-signing-action`, and verifies Authenticode signatures before validating checksums or uploading release assets. Keep `DESKTOP_SIGNING_ENABLED=false` for unsigned beta drafts.

### Production Desktop API Enablement

Production Terraform plans and applies hydrate most variables from the protected environment's `TERRAFORM_TFVARS_JSON` secret. Desktop canary rollout has dedicated GitHub environment variable overlays so future applies do not silently turn the hosted desktop API off again:

- `ENABLE_DESKTOP_API`: set to `true` for the beta/canary window.
- `DESKTOP_ALLOWED_USER_IDS`: comma-separated Discord user IDs for beta access.

If `ENABLE_DESKTOP_API=true`, the Terraform workflows fail unless either `DESKTOP_ALLOWED_USER_IDS` or `SUPER_ADMIN_USER_IDS` is configured. This keeps hosted desktop routes gated even when the API is intentionally enabled.

## Local Commands

Run from the repository root:

```powershell
yarn desktop:ci
yarn test:desktop:coverage
yarn desktop:package
yarn desktop:artifacts --write
yarn desktop:smoke:native
```

`yarn desktop:smoke:native` requires `tauri-driver` and Microsoft Edge WebDriver on `PATH`.
Set `CHRONOTE_DESKTOP_WEBDRIVER_DIR` to a local driver directory if EdgeDriver is not globally installed.

## Release Tagging

Use desktop-specific tags:

```text
desktop-v0.1.0-beta.1
desktop-v0.1.0-beta.2
desktop-v0.1.0
```

Do not reuse backend/web release tags for desktop binaries.

## Signing Plan

Two signing concerns are intentionally separate:

- Windows Authenticode signing: makes Windows trust the installer/executable publisher.
- Tauri updater signing: lets installed clients verify update artifacts.

Remaining deferred decisions:

- Tauri updater key custody and rotation.
- Beta/stable updater endpoint layout.

Recommended Authenticode provider:

- Use [Azure Artifact Signing](https://learn.microsoft.com/en-us/azure/artifact-signing/overview), formerly Azure Trusted Signing, for Windows Authenticode signing.
- Start with the Basic SKU. Microsoft lists it as 5,000 signatures/month with one public and one private certificate profile type, which is enough for Chronote's expected Windows release cadence.
- Pricing checked through Azure Retail Prices on 2026-06-08: Basic account is $9.99/month, Premium account is $99.99/month, and signature overage is $0.005/signature.
- Billing starts when the Artifact Signing account is created, and Microsoft says SKU charges are not prorated. Create the account only when ready to validate signing.
- Public Trust signing is currently limited to organizations in the USA, Canada, the European Union, and the United Kingdom, plus individual developers in the USA and Canada.
- Identity validation is the slow path. Microsoft documents 1 to 20 business days, possibly longer if more documents are requested.
- Prefer Artifact Signing over a checked-in or CI-stored PFX because certificate lifecycle and keys stay in Microsoft's managed HSM-backed service.

Recommended GitHub packaging integration:

1. Create an Artifact Signing account, complete public identity validation for the publisher entity, and create a Public Trust certificate profile.
2. Grant only the release workflow identity the `Artifact Signing Certificate Profile Signer` role.
3. Prefer GitHub OIDC through `azure/login` instead of a long-lived `AZURE_CLIENT_SECRET` when configuring the protected `desktop-release` environment.
4. Add environment-scoped signing configuration for the endpoint, signing account name, and certificate profile name.
5. Use Azure's Artifact Signing GitHub Action after Tauri packaging and before release upload so the workflow stays on OIDC instead of long-lived client secrets.
6. Timestamp every Authenticode signature with `http://timestamp.acs.microsoft.com`; Artifact Signing certificates are short-lived, so timestamping is required for signatures to remain valid beyond the certificate validity window.
7. Set `DESKTOP_SIGNING_ENABLED=true` only after the provider setup and timestamped signature validation are verified.
8. Verify both the installer and installed executable signatures before promoting any stable release.

Stable release blockers:

- Authenticode signing enabled through the protected `desktop-release` environment.
- Signed artifact validation in CI.
- Updater artifact signing if updater is enabled.

## QA Card: Windows Installer Smoke

Purpose: verify the installer lifecycle and real-device recorder path before broad beta or stable release.

Prerequisites:

- A Windows test machine that has not already installed the same Chronote Desktop build, or a machine where the previous build was removed first.
- A Chronote account listed in `DESKTOP_ALLOWED_USER_IDS` or `SUPER_ADMIN_USER_IDS`.
- A working microphone and a local audio source, such as a browser tab playing a short test clip.
- The release MSI or NSIS artifact plus `SHA256SUMS.txt` from the draft GitHub Release.

Smoke steps:

1. Verify the downloaded installer checksum against `SHA256SUMS.txt`.
2. Install the generated desktop artifact.
3. Launch Chronote Desktop from the Start menu.
4. Sign in with the desktop-allowed Chronote account.
5. Verify microphone and system/output devices are listed.
6. Record at least 15 seconds with microphone input and system audio playing.
7. Confirm both source meters move during recording.
8. Stop and upload.
9. Open the created meeting during processing.
10. Confirm the meeting appears in My Meetings.
11. Confirm transcript/notes contain the expected personal recording labels.
12. Sign out and relaunch to verify session clearing.
13. Close the app, uninstall it, and confirm the Start menu entry is removed.
14. Reboot or sign out/in if Windows keeps stale shortcuts, then confirm Chronote Desktop no longer launches.

Pass criteria:

- Install completes without requiring developer tools or local source checkout.
- Launch, sign-in, recording, upload, and meeting navigation work against `https://api.chronote.gg` and `https://chronote.gg`.
- Uninstall removes the app entry and does not leave a launchable stale installation.

Failure capture:

- Record installer filename, checksum status, Windows version, installer type, and whether the artifact was signed.
- Capture app logs and upload/meeting IDs only in private support or ops notes; do not post tokens or signed upload fields in public issues.

## Rollback Checklist

For a bad desktop beta release:

1. Mark the GitHub Release as draft or delete the release assets.
2. Remove or replace updater metadata if updater support has been enabled.
3. Revoke desktop API access for affected beta users if necessary.
4. Publish a fixed beta tag or communicate the rollback path to testers.
5. Capture the failure mode in #249 or a linked subissue.

## Security and Privacy Review Items

- Tauri capabilities stay minimal.
- CSP is reviewed before stable release.
- `open_external_url` only opens `http` and `https` URLs.
- Desktop OAuth uses browser PKCE and localhost callback, not embedded Discord credentials.
- Tokens stay in the OS keyring for normal builds.
- Test session hooks are feature-gated and not enabled for release builds.
- Synthetic audio is feature-gated and not enabled for release builds.
- Support logs must redact tokens, upload tokens, and signed upload fields.
- User docs must explain that system audio capture can include notifications and other app audio.
