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

It creates a draft GitHub Release and uploads unsigned Windows artifacts plus `SHA256SUMS.txt`.

The workflow uses the protected `desktop-release` GitHub environment. Add signing secrets to that environment once Authenticode and updater-signing custody are decided.

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

Deferred decisions:

- Authenticode provider setup timing and Azure account ownership.
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

Recommended GitHub/Tauri integration:

1. Create an Artifact Signing account, complete public identity validation for the publisher entity, and create a Public Trust certificate profile.
2. Grant only the release workflow identity the `Artifact Signing Certificate Profile Signer` role.
3. Prefer GitHub OIDC through `azure/login` instead of a long-lived `AZURE_CLIENT_SECRET` when configuring the protected `desktop-release` environment.
4. Add environment-scoped signing configuration for the endpoint, signing account name, and certificate profile name.
5. Use Tauri's `bundle.windows.signCommand` through a CI-only config override so the app executable and installer are signed during bundling, not only after packaging.
6. Timestamp every Authenticode signature with `http://timestamp.acs.microsoft.com`; Artifact Signing certificates are short-lived, so timestamping is required for signatures to remain valid beyond the certificate validity window.
7. Remove `--no-sign` from `.github/workflows/desktop-release.yml` only after signed artifact validation is added.
8. Verify both the installer and installed executable signatures before promoting any stable release.

Stable release blockers:

- Authenticode signing configured in `tauri.conf.json` or via a protected signing command.
- Signed artifact validation in CI.
- Updater artifact signing if updater is enabled.

## Manual Hardware Smoke Checklist

Before broad beta or stable release, run on a real Windows machine:

1. Install the generated desktop artifact.
2. Launch Chronote Desktop from the Start menu.
3. Sign in with a desktop-allowed Chronote account.
4. Verify microphone and system/output devices are listed.
5. Record at least 15 seconds with microphone input and system audio playing.
6. Confirm both source meters move during recording.
7. Stop and upload.
8. Open the created meeting during processing.
9. Confirm the meeting appears in My Meetings.
10. Confirm transcript/notes contain the expected personal recording labels.
11. Sign out and relaunch to verify session clearing.
12. Uninstall and confirm the app is removed.

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
