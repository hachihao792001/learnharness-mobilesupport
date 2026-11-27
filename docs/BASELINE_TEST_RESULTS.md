# Baseline test results (before any fork change)

Recorded 2026-11-27 on branch `feature/remote-access`, at upstream commit `e3cfff6` (v0.7.0), before any fork code was added. Nothing below was changed by the fork, and none of these failures were "fixed" by it.

## Environment

| Item | Value |
|---|---|
| OS | Windows 11 Enterprise 10.0.26200 (x64) |
| Node | v26.13.1 (official portable zip in `D:\tools\node26`, SHA-256 checked against nodejs.org). Docs and CI use Node 26. The PC's own Node is v24.21.0 and was **not** used. |
| npm | 11.20.0 |
| git | `core.autocrlf=true` (Git for Windows default), so the checkout has CRLF line endings |
| Symlinks | Not allowed for this user (no Windows Developer Mode) |

## Commands and results

| Step | Command | Result |
|---|---|---|
| Install | `npm ci` | OK. npm 11.20 reports 5 packages whose install scripts are "not yet covered by allowScripts" (`@google/genai` no-op, `electron-winstaller`, `esbuild`, `protobufjs`, `unrs-resolver`). Their platform binaries are present; CI uses the same npm behaviour. Electron 44 has no postinstall: its binary is fetched on first `npx electron` use. |
| Plugins | `npm run plugins:setup` | OK |
| Typecheck | `npm run typecheck` | OK (0 errors) |
| Lint | `npm run lint` | OK: 0 errors, 1 warning (`tests/source-name-ui.test.tsx:27` `@next/next/no-head-element`) |
| Tests | see note below | **5516 tests: 5443 pass, 62 fail, 11 skipped** (194 s) |
| Build | `npm run build` | OK. 2 Turbopack warnings ("Dynamic filesystem access causes tracing of the whole project", `src/agent/subagents/headless.ts:206` and one more of the same kind) |
| Server payload | `node scripts/build-server.mjs` | OK |
| Smoke | `node scripts/smoke-server.mjs` | OK (boot, `/api/graph`, `/api/models`, `/api/settings`, `/api/plugins`, core and external plugin checks, provider runtime smoke) |

### Running the tests on Windows

`npm test` (`NODE_ENV=test tsx --test tests/*.test.ts tests/*.test.tsx`) cannot run on Windows as written:
1. npm runs scripts with `cmd.exe`, which does not understand the POSIX `NODE_ENV=test` prefix.
2. Run from Git Bash, the expanded file list is longer than Windows allows ("The command line is too long").

The same file set was run with Node expanding the globs itself:

```sh
NODE_ENV=test node --import tsx --test "tests/*.test.ts" "tests/*.test.tsx"
```

Upstream CI runs the full suite only on `ubuntu-24.04`, so these Windows failures are not visible there.

## The 62 failing tests (all pre-existing, Windows environment)

Causes seen in the output:
- **CRLF line endings** (most text-comparison failures): the checkout has `\r\n`, and tests compare against generated `\n` text (SDK reference, skill bundle, type declarations, themes CSS).
- **Symlinks not allowed** (`EPERM`, `syscall: 'symlink'`): the symlink-refusal tests cannot create their fixtures.
- **POSIX file modes** (`0600` checks) do not exist on Windows.
- **Environment-dependent paths**: some tests clear the environment, so `os.tmpdir()` becomes `undefined\temp` (`session-identity.test.ts`).
- **Installed tools on this PC** (`claude-code` CLI detection tests in `model-catalog.test.ts`).

By file (number of failing tests):

```
10 session-identity   6 verify-release        4 plugin-authoring-bundle
 3 plugin-task-records 3 plugin-install-local  3 plugin-host
 3 model-catalog       3 claude-code-stream    2 subscription-auth
 2 safe-fetch-connector 2 plugin-api-reference 2 core-plugins
 1 each: themes, source-access, plugin-view-types, plugin-types,
   plugin-submission-types, plugin-question-types, plugin-problem-types,
   plugin-grading-types, plugin-document-types, learner-image-snapshots,
   file-access-settings, desktop-platform, data-dir-seam, core-plugin-build,
   code-ligatures, chatgpt-auth, automatic-updates, auth-store, appearance-chrome
```

Full list of failing test names:

```
Default reproduces app/globals.css's literals exactly
HTTPS preserves certificate/SNI validation and refuses a private peer before HTTP dispatch
a late MCP compatibility error cannot restore a cancelled worker continuation
asset access rejects a plugin-root symlink introduced after discovery
bootstrap missing root stays missing, and unsafe package paths are per-package errors
catalogProviders() marks claude-code present when the CLI is installed
checks a hostname's actual peer again when DNS changes on a new connection
constructs light native chrome before renderer reporting and accepts appearance only from its exact main-frame origin
core data and package symlinks fail closed without writing their targets
core provenance/configuration is captured, and replacing the core root with a symlink revokes assets
cwd is an empty temp dir; prompt and mcp config live in a separate private dir
directories, dangling settings symlinks and dangling data-directory symlinks are not first boot
explicit OFF skips automatic checks, but manual checks still run without reading the preference
external desktop development reads the server's directory rather than the shell's -dev profile
frontend-only assets are explicitly allowlisted, immutable by revision, and fail closed on symlinks
generated plugin API declarations are portable and usable as type-only imports
generated public document API accepts only Files and optional caller cancellation
github-copilot: independent default-ON file, restart, explicit OAuth lease and local disconnect
managed openai requests preserve native session affinity and caching
managed openrouter requests preserve native session affinity and caching
modelCatalog() lists claude-code opus/sonnet/haiku/fable when the CLI is installed
native inline/fenced code and both CodeMirror modes opt in without changing prose or diagrams
normal completion escalates termination when the child ignores SIGTERM
one-shot custom/deepseek-v4.1-flash calls carry private routing ids with caching off
one-shot opencode-go/claude-haiku-5-5 calls carry private routing ids with caching off
one-shot opencode-go/gemini-4-argon calls carry private routing ids with caching off
one-shot opencode-go/glm-5.3 calls carry private routing ids with caching off
one-shot opencode-go/gpt-6-luna calls carry private routing ids with caching off
one-shot routing identity stays stable across a native transport retry
packaged question SDK contracts support strict consumers without exposing host authority APIs
plugin workers keep isolated deepseek-v4.1-flash sessions across tool rounds (cache none)
plugin workers keep isolated glm-5.3 sessions across tool rounds (cache default)
portable SDK exposes whole-view context and deeply readonly drafts without submission capabilities
portable public SDK infers practice payload/submission schemas and exposes processing, not assessment authority
portable public SDK supports typed generic grading without exposing host authority or presentation policy
portable submission SDK exposes readonly learner input and opaque native surfaces without backend hooks
private JSON file round-trips global state; creation and atomic replacement are owner-only
produces the complete rooted skill, matching versions, current example layout and no repository-only files
providerKeyPresent("claude-code") requires both explicit opt-in and executable presence
recovery refuses symlinks at every root/plugin/data/tasks component and at the task file
refuses linked target plugin/dist and misplaced target dist/data, even dangling links
refuses non-distributable contents, file and directory symlinks, including manifest and root links
refuses source and output links and writing over the input SDK
refuses unsafe example contents, source symlinks and output symlinks without changing their targets
rejects every curated source-file symlink before replacing existing outputs
rejects source ancestor-directory symlinks before replacing existing outputs
select emits machine JSON for the workflow's download step
select warns loudly for the legacy unprefixed draft tag
staging rejects data, credentials, source/tooling and symlinks instead of copying them
strict get/list refuse task files that are directories or symlinks
symlinked plugin roots and build directories cannot be activated
tests\source-access.test.ts
the committed reference covers every real SDK public type/member and exactly matches fresh generation
the documented npm command builds and installs without a checkout, and build failure prevents installation
the file is mode 0600 (secrets), also after rewrites
unset = the repo data/ exactly as before (fresh child process, no env)
uses the shared sensitive-path guard for displays and annotation dispatch
verify fails a draft with a missing blockmap and a stale asset
verify fails closed when the tag disagrees with package.json
verify passes the complete draft and exits 0
verify works after a package version bump without changing the tests
xai: independent default-ON file, restart, explicit OAuth lease and local disconnect
```

After every fork phase, the test run is compared with this list. A failure that is **not** on this list is a regression and is reported, never hidden.
