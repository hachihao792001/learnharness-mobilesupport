# Releasing the fork (Windows)

The fork ships a Windows installer from GitHub Releases. People download it from <https://github.com/hachihao792001/learnharness-mobilesupport/releases>, and installed copies update themselves from those releases. Only Windows is built; macOS needs Apple signing secrets this fork does not have.

The workflow is `.github/workflows/fork-release.yml`. Upstream's `release.yml` is kept but only runs in `amosblomqvist/learnharness`.

## Versions

| Where | Value | Why |
|---|---|---|
| Git tag, installer, update feed, Windows app list | `0.7.0-mobile.1`, `0.7.0-mobile.2`, … | Upstream's version plus a fork counter. After merging upstream 0.8.0: `0.8.0-mobile.1` |
| `package.json`, Settings → General | `0.7.0` (upstream's, unchanged) | Upstream's plugin system only accepts plain `x.y.z` app versions. Settings shows the base version and links to upstream's notes for it |

The workflow refuses a tag whose base is not the `package.json` version, and refuses `-mobile.0` (that number is only for rehearsals).

## Making a release

1. Be on an up-to-date `main` with everything committed and pushed, and CI green.
2. Pick the next number. If the last release was `v0.7.0-mobile.1` and `package.json` is still `0.7.0`, the next is `v0.7.0-mobile.2`. After an upstream merge that changed the version, start again at `-mobile.1`.
3. Tag and push the tag:
   ```sh
   git tag v0.7.0-mobile.1
   git push origin v0.7.0-mobile.1
   ```
4. Actions → **Fork Windows release** runs:
   - the release gates (typecheck, full test suite, lint);
   - the Windows build with upstream's server and packaged-app smoke tests;
   - a check that the installer, `latest.yml` and the app's update source are right.

   It then creates a **draft** release with the installer, its `.blockmap`, `latest.yml` and the release notes. It takes about 30–40 minutes.
5. Open the draft on the Releases page. Read the notes and, if you like, download and try the installer. Then click **Publish release**.

   Leave "Set as a pre-release" **off**, so it shows as the latest release. Installed copies find it either way.
6. Within 24 hours (or when the user clicks "Check for updates" in Settings → General), installed copies download it and install it when they quit.

Drafts are invisible to users and to the updater, so nothing reaches anyone until you publish. A failed run leaves no release, or an unpublished draft you can delete. Re-pushing the same tag after deleting it re-runs the workflow; it refuses to touch an already published release.

### Rehearsal (no release)
Actions → **Fork Windows release** → **Run workflow** on `main`. It runs the same build and checks with version `<package.json>-mobile.0`, and uploads the installer as a workflow artifact (kept 14 days). It creates no release.

## How updates work
- The build points electron-updater at this fork (`electron-builder.yml` `publish` is rewritten in the CI checkout only, by `node scripts/fork/fork-release.mjs stamp`). An installed fork never updates to upstream's releases.
- An app version like `0.7.0-mobile.1` makes electron-updater look only at releases whose tag has the same `-mobile` label, newest first, and use their `latest.yml`. Published releases only; drafts are ignored.
- Users who had official LearnHarness: the fork uses the same app ID and data folder, so installing it replaces official LearnHarness and keeps sessions, graph and keys. Going back means installing official LearnHarness again.

## What users see
- **"Windows protected your PC"** (SmartScreen), because the installer is not code-signed. They click **More info → Run anyway**. The release notes say so. Code signing needs a paid certificate; the workflow does not sign.
- A per-user, one-click install (no admin rights), into `%LOCALAPPDATA%\Programs\LearnHarness`.

## Checked before the first release
- `tests/fork-release.test.ts` covers: tag → version rules; the update feed rewrite against the real `electron-builder.yml`; output checks, including catching an app that would update from upstream; release notes.
- A local run of the same chain (stamp, build, build-server, NSIS packaging, verify) produced `LearnHarness-0.7.0-mobile.0-x64-setup.exe` (179 MB) with a matching `latest.yml`.
- The packaged app reports `0.7.0-mobile.0`, starts on an isolated profile, loads its core plugins, serves pages, and its update check asks the fork, not upstream.
