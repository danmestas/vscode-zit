# VS Code Zit Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the vscode-fossil extension as a Zit-backed VS Code source-control provider, preserving supported editor workflows while exposing only operations Zit can perform truthfully.

**Architecture:** Import vscode-fossil 0.7.6 as the baseline, retain its VS Code-facing model/interaction/resource layers, and replace the executable, repository-discovery, command, and output-parsing boundary with Zit-specific code. Do not add a generic multi-VCS abstraction: `ZitExecutable` and `OpenedRepository` are the deep modules that hide Zit argv, exit codes, repository layout, and text formats from the UI. Remove Fossil-only staging, wiki, web-UI, patch, checkout-close, private-branch, and tag-cancel surfaces rather than emulating unsupported behavior.

**Tech Stack:** TypeScript, VS Code Extension API, Node.js 18, esbuild, Mocha/Sinon, `@vscode/test-electron`, Zit 0.1.3 for the initial CI contract.

---

## Grounded Current State

- `/Users/dmestas/vscode-zit` has no extension source or Git repository. It contains only `.sesh/`, `banks/`, and this plan; preserve those local harness directories and ignore them.
- `/Users/dmestas/references/vscode-fossil` is extension version 0.7.6 with 23 production TypeScript files, 18 test-suite files, 60 contributed `fossil.*` commands, 10 `fossil.*` settings, and Node 18 CI.
- The reusable VS Code-facing core is concentrated in `src/main.ts`, `src/model.ts`, `src/repository.ts`, `src/commands.ts`, `src/interaction.ts`, `src/resourceGroups.ts`, `src/statusBar.ts`, `src/fileSystemProvider.ts`, and `src/revert.ts`.
- The backend seams are `src/fossilFinder.ts`, `src/fossilExecutable.ts`, and `src/openedRepository.ts`; `src/uri.ts`, `src/gitExport.ts`, `src/praise.ts`, and tests contain additional command/output coupling.
- Zit 0.1.3 uses a `.zit` directory or file, searches upward for it, and accepts repository-only reads through `-R/--repo`.

## Verified Compatibility Matrix

| Capability | vscode-fossil contract | Zit 0.1.3 | Port action |
|---|---|---|---|
| Executable probe | `fossil version` → `version X.Y[...]` | `zit version` → `zit 0.1.3 (targets Fossil RFC rev 00)` | Replace finder and version parser |
| Repository discovery | `fossil info` and `local-root:` | Upward `.zit` discovery; `info` does not print root | Walk parents for `.zit` in `ZitExecutable.findRoot` |
| Initialize | `fossil init REPO_FILE` plus project metadata | `zit init [directory]` | Select a checkout directory; remove project-name/description prompts |
| Clone/open | Clone URL to repository file, then open it | `zit clone URL DIR` creates and opens the checkout | Collapse the two Fossil steps into one Zit command |
| Status | `status --differ --merge`; Fossil classes | `status` emits `added`, `edited`, `missing`; `extras` emits untracked paths; `diff --brief` emits A/M/D | Run and merge all three outputs in the backend adapter |
| Staging | Extension exposes stage/unstage and commit-staged | Zit has no staging area | Remove those commands/groups; keep “Added Files”, “Changes”, and “Untracked Files” |
| Content | `cat -r CHECKIN -- PATH` | `cat PATH [VERSION]` | Reorder argv in one adapter method |
| History | Fossil `timeline --format`, `--before`, `-p`, `--verbose` | `timeline -n`; `log -n CHECKIN [PATH]`; `artifact --raw`; `diff --brief --from/--to` | Parse stable Zit output and artifact cards inside `OpenedRepository` |
| Branches | `branch ls -t [-c]`, branch-new/private/close | `branch` lists `* current` and `(closed)`; new/close occur through `commit --branch/--close` | Replace parsers; remove private branch; move branch creation/closure into commit flows |
| Tags | list/add/cancel | `tag list [CHECKIN]`, `tag add NAME CHECKIN`; no cancel | Keep list/add; remove cancel command |
| Stash | Fossil multiline list with date | `stash save/list/show/apply/pop/drop`; list is `ID: [HASH] N file(s) — MESSAGE` | New parser; make stash date optional |
| Annotate | `praise` | `annotate PATH [VERSION] [--full]` | Rename command and parser |
| Git export | `git export ...` | `export-git SOURCE DEST` | Adapt `src/gitExport.ts` argv/progress |
| Sync/auth | pull/push/sync plus Fossil URL/config behavior | pull/push/sync, saved `remote`, `--user`, `--password`, `settings autosync` | Keep credential flow; replace config/remote calls |
| Merge conflicts | Persistent Fossil status classes | Zit writes markers and conflict paths to merge stderr; status later reports edits only | Show conflict paths from the merge result; do not claim persistent conflict classification |
| Collaboration | Web UI, wiki rendering/creation, patches | Explicitly unsupported by Zit | Remove commands, custom editor, preview runtime, and patch paths |
| Checkout close | `fossil close` | No Zit equivalent | Remove checkout-close command |

## Target File Structure

**Preserve and adapt:**

- `src/main.ts` — activation and contexts.
- `src/model.ts` — workspace/repository lifecycle.
- `src/repository.ts` — VS Code SCM model and operations.
- `src/commands.ts`, `src/interaction.ts` — supported user actions.
- `src/resourceGroups.ts`, `src/statusBar.ts` — Zit-honest SCM presentation.
- `src/fileSystemProvider.ts`, `src/uri.ts` — virtual historical documents using `zit:` URIs.
- `src/gitExport.ts`, `src/praise.ts` — map to `export-git` and `annotate`.
- Utility modules and the Pikchr grammar contribution, which do not require Fossil execution.

**Rename:**

- `src/fossilExecutable.ts` → `src/zitExecutable.ts`.
- `src/fossilFinder.ts` → `src/zitFinder.ts`.
- `FossilExecutable`, `FossilVersion`, `FossilPath`, `FossilRoot`, `Fossil*` domain types, URI helpers, command IDs, settings, contexts, localization keys, tests, and docs → `Zit*`/`zit.*` cleanly, with no compatibility aliases.

**Delete after callers are removed:**

- `src/preview.ts` and `media/` (Fossil wiki rendering/custom editor).
- Fossil web-UI/wiki/patch command handlers and tests.
- Fossil-only screenshots and documentation scenarios.

## Task 1: Import the Reference Baseline Safely

**Files:**
- Import: all tracked files from `/Users/dmestas/references/vscode-fossil`
- Preserve: `.sesh/`, `banks/`, `docs/superpowers/plans/2026-08-15-vscode-zit-port.md`
- Modify: `.gitignore`

- [ ] **Step 1: Initialize the target repository**

Run:

```sh
git init -b main /Users/dmestas/vscode-zit
```

Expected: an empty `main` branch; `.sesh/`, `banks/`, and this plan remain present.

- [ ] **Step 2: Import only files tracked by the reference repository**

Run:

```sh
git -C /Users/dmestas/references/vscode-fossil archive HEAD \
  | tar -x -C /Users/dmestas/vscode-zit
```

Expected: source/config/assets arrive without the reference `.git` directory or ignored build output.

- [ ] **Step 3: Protect local harness state**

Add to `.gitignore`:

```gitignore
.sesh/
banks/
.tracedecay/
```

- [ ] **Step 4: Establish the untouched baseline**

Run:

```sh
npm ci
npm run compile
npm run lint
```

Expected: the imported reference builds before any semantic porting. Record any platform-only test prerequisite; do not “fix” baseline failures in the port commits.

- [ ] **Step 5: Checkpoint**

Commit the imported baseline separately as `chore: import vscode-fossil baseline` so every later semantic change is reviewable.

## Task 2: Perform the Clean Zit Identity Cutover

**Files:**
- Modify: `package.json`, `package-lock.json`, `package.nls.json`, `README.md`, `CHANGELOG.md`
- Modify: `.vscode/**`, `.github/workflows/fossil.yml`, `.vscodeignore`
- Modify: all `src/**/*.ts`, `src/test/**/*.ts`
- Rename: `src/fossilExecutable.ts`, `src/fossilFinder.ts`, workflow and Zit-specific image names

- [ ] **Step 1: Add an activation contract test**

In `src/test/suite/setup.test.ts`, assert that activation creates the `Zit` output channel, registers `zit.refresh`, and sets `zitOpenRepositoryCount`. Run the setup suite and confirm it fails against the Fossil identifiers.

- [ ] **Step 2: Rename exported TypeScript symbols with LSP**

Use symbol-aware rename for `FossilExecutable`, `FossilVersion`, all `Fossil*` domain types, `findFossil`, `fromFossilUri`, and related declarations. Rename files with LSP-aware file rename so imports update atomically. Do not retain aliases.

- [ ] **Step 3: Rename the extension manifest surface**

Set:

```json
{
  "name": "zit",
  "displayName": "Zit",
  "description": "Integrated Zit source control"
}
```

Change every `fossil.*` command, setting, context key, menu condition, and custom URI scheme to `zit.*`; update localization keys and lockfile package identity. Remove repository/homepage/bugs URLs until the target remote exists rather than publishing stale vscode-fossil links.

- [ ] **Step 4: Rename user-visible branding and docs**

Update status text, progress titles, error messages, test descriptions, screenshots, workflow names, and package artifact glob to `zit-*.*.*.vsix`.

- [ ] **Step 5: Verify the cutover**

Run the setup suite, compile, and a repository-wide literal search for case-insensitive `fossil`. Remaining occurrences must be intentional format/protocol statements (for example “Fossil-compatible repository”), not identifiers or executable calls.

## Task 3: Replace Executable Discovery and Process Semantics

**Files:**
- Modify: `src/zitFinder.ts`, `src/zitExecutable.ts`, `src/main.ts`, `src/config.ts`
- Test: `src/test/suite/setup.test.ts`, `src/test/suite/Infrastructure.test.ts`

- [ ] **Step 1: Write finder tests**

Cover configured `zit.path`, fallback to `zit` on `PATH`, unavailable binary, and exact version output:

```ts
const output = 'zit 0.1.3 (targets Fossil RFC rev 00)\n';
assert.deepEqual(parseZitVersion(output), [0, 1, 3]);
```

Verify the tests fail while the Fossil regex and fallback remain.

- [ ] **Step 2: Implement the finder contract**

Probe with `zit version`; accept `^zit (\d+)\.(\d+)\.(\d+)\b`; log the selected executable; update missing-binary actions to `zit.path` and `https://fossil.craftdesign.group/zit/uv/download.html`.

- [ ] **Step 3: Normalize execution results**

Keep one result shape with stdout, stderr, exit code, command text, duration, and spawn failure. Treat exit 0 as success, 1 as operational failure, and 2 as usage failure; delete Fossil-specific error-code parsing and error aliases.

- [ ] **Step 4: Preserve cancellation/logging/global arguments**

Keep the reference process spawning, cancellation, output-channel, and redaction behavior. Ensure passwords are redacted from logged argv and are never persisted.

- [ ] **Step 5: Verify**

Run finder/executable suites plus `npm run compile`.

## Task 4: Port Repository Discovery, Init, Clone, and Open

**Files:**
- Modify: `src/zitExecutable.ts`, `src/openedRepository.ts`, `src/model.ts`, `src/commands.ts`, `src/interaction.ts`
- Test: `src/test/suite/setup.test.ts`, `src/test/suite/commandSuites.ts`

- [ ] **Step 1: Write repository-root tests**

Test a `.zit` directory and `.zit` file, a nested child path, filesystem root termination, an ordinary directory, and a file path inside a checkout.

- [ ] **Step 2: Implement `findRoot` below the model**

`ZitExecutable.findRoot(anyPath)` should normalize files to their parent, walk upward, and return the first directory containing `.zit`. `OpenedRepository.tryOpen` should use this result instead of parsing `fossil info local-root:`.

- [ ] **Step 3: Replace init semantics**

Change the interaction from “select repository file” to “select checkout directory”; execute `zit init DIRECTORY`; remove Fossil project-name/project-description prompts; immediately ask the model to open that directory.

- [ ] **Step 4: Replace clone/open semantics**

Execute `zit clone URL DIRECTORY` once. Keep a separate `zit.open` action only for an existing not-yet-materialized `.zit`, invoking `zit open [CHECKIN]` from its checkout directory.

- [ ] **Step 5: Remove checkout-close behavior**

Delete `zit.close`, its menu entries, handler, interaction, tests, and the obsolete `OpenedRepository.close` path; closing the VS Code SCM provider remains a model/UI lifecycle action, not a repository mutation.

- [ ] **Step 6: Verify with a real disposable Zit checkout**

Exercise init, nested discovery, clone (against a local test server/fixture), open, and model registration under the extension host.

## Task 5: Make the SCM Model Match Zit’s Real State

**Files:**
- Modify: `src/openedRepository.ts`, `src/repository.ts`, `src/resourceGroups.ts`, `src/statusBar.ts`, `src/commands.ts`, `package.json`
- Test: `src/test/suite/stateSuite.ts`, `src/test/suite/resourceActionsSuite.ts`, `src/test/suite/statusBarSuite.ts`

- [ ] **Step 1: Add parser contract tests from observed Zit output**

Use fixtures containing:

```text
On branch trunk (check-in <full-hash>)
added new.txt
edited changed.txt
missing deleted.txt
```

plus `zit extras` paths and `zit diff --brief` A/M/D lines. Assert the current branch/check-in and exact resource groups.

- [ ] **Step 2: Replace Fossil status parsing**

Run `zit status`, `zit extras`, and `zit diff --brief` together. Normalize paths once in `OpenedRepository`; map `added` to Added Files, `edited`/`missing` to Changes, and extras to Untracked Files. Deduplicate paths reported by more than one command.

- [ ] **Step 3: Replace resource groups**

Expose exactly:

```ts
interface IStatusGroups {
    added: ZitResourceGroup;
    working: ZitResourceGroup;
    untracked: ZitResourceGroup;
}
```

Remove staging/conflict groups and every caller. Merge conflicts remain working changes; the merge command surfaces the conflict paths parsed from stderr in a warning.

- [ ] **Step 4: Remove dishonest staging actions**

Delete stage/unstage/stage-all/unstage-all/commit-staged commands and menus. `zit add` moves an extra file into Added Files; `zit rm` untracks an added file or records a tracked deletion according to Zit’s command contract.

- [ ] **Step 5: Verify state transitions**

In a disposable checkout, exercise clean → extra → added → committed → edited → missing states and assert both VS Code resource groups and command availability.

## Task 6: Port Core Mutating Commands

**Files:**
- Modify: `src/openedRepository.ts`, `src/repository.ts`, `src/commands.ts`, `src/interaction.ts`, `src/revert.ts`
- Test: `src/test/suite/commandSuites.ts`, `commitSuite.ts`, `renameSuite.ts`, `revertSuite.ts`, `mergeSuite.ts`

- [ ] **Step 1: Convert exact-argv tests before implementations**

Cover `add`, `rm`, `mv`, `revert`, `clean --force`, `commit -m`, `update`, `merge`, `undo`, and `redo`; confirm each converted test fails against the Fossil argv.

- [ ] **Step 2: Port add/remove/rename/clean/revert**

Map directly to Zit verbs and preserve `--` path separation only where Zit accepts it. Replace Fossil clean confirmation with `zit clean --dry-run` for preview and `zit clean --force` after confirmation.

- [ ] **Step 3: Port commit semantics**

Commit always includes all tracked changes. Map author to `--user`, message to `-m`, new branch to `--branch`, branch closure to `--close`, and configured extra commit args verbatim after validation.

- [ ] **Step 4: Port update/merge/undo/redo**

Respect exit 1 as an operational refusal. For merge conflicts, parse paths from stderr, refresh status, reveal those files, and keep the pending merge for a later commit or undo.

- [ ] **Step 5: Verify real behavior**

Run the converted suites against the real Zit binary, including nothing-to-commit, dirty-update refusal, merge conflict, undo, and redo.

## Task 7: Port Historical Content, Diff, Timeline, and Annotate

**Files:**
- Modify: `src/openedRepository.ts`, `src/repository.ts`, `src/fileSystemProvider.ts`, `src/uri.ts`, `src/interaction.ts`, `src/praise.ts`
- Test: `src/test/suite/timelineSuite.ts`, `commandSuites.ts`, `utilitiesSuite.ts`

- [ ] **Step 1: Add output parser tests**

Pin Zit’s documented outputs:

```text
  <12-hex>  2026-08-15T17:26:35  trunk  seed
checkin <full-hash>
```

and raw Fossil-compatible artifact cards returned by `zit artifact HASH --raw`.

- [ ] **Step 2: Port historical file content**

Change content reads to `zit cat PATH VERSION`. Keep the virtual-document provider and URI/query model, renamed to the `zit:` scheme.

- [ ] **Step 3: Implement history retrieval**

Use `zit timeline -n N` for repository history and `zit log -n N CHECKIN PATH` for file history. Resolve abbreviated IDs through `zit info PREFIX`; parse `artifact --raw` only when parent/user/details are needed. Keep artifact-card parsing private to `OpenedRepository`.

- [ ] **Step 4: Implement changed-file and parent diffs**

Read the primary P-card parent; use `zit diff --brief --from PARENT --to CHECKIN` for changed paths; compare virtual `zit cat` documents in VS Code for per-file diffs. Handle a root check-in as an empty left side.

- [ ] **Step 5: Port annotate**

Replace praise argv/parser with `zit annotate PATH [VERSION] --full`; retain the editor decoration UX under `zit.annotate` naming.

- [ ] **Step 6: Verify merge and file-history boundaries**

Test root commits, ordinary commits, merge commits (primary parent), deleted files, file-specific log filtering, and binary content.

## Task 8: Port Branch, Tag, Stash, Export, and Sync Workflows

**Files:**
- Modify: `src/openedRepository.ts`, `src/repository.ts`, `src/commands.ts`, `src/interaction.ts`, `src/gitExport.ts`, `src/statusBar.ts`
- Test: `branchSuite.ts`, `gitExportSuite.ts`, `commandSuites.ts`, `statusBarSuite.ts`

- [ ] **Step 1: Port branch listing and commit-based branch actions**

Parse `* branch` and `branch (closed)`. Remove private-branch UI. Replace standalone branch creation/closure with commit flows using `--branch`/`--close` and a required message.

- [ ] **Step 2: Port tags**

Use `tag list [CHECKIN]` and `tag add NAME CHECKIN`. Delete tag-cancel UI and tests because Zit exposes no removal command.

- [ ] **Step 3: Port stash**

Parse `ID: [HASH] N file(s) — MESSAGE`; map save/show/apply/pop/drop directly. Make the UI model’s date optional because Zit’s stable list output has no timestamp.

- [ ] **Step 4: Port Git export**

Invoke `zit export-git SOURCE DEST`; use the opened `.zit` checkout root as SOURCE and the selected Git directory as DEST; preserve confirmation and progress behavior.

- [ ] **Step 5: Port remote/sync/auth**

Use `remote`, `pull [URL]`, `push [URL]`, and `sync [URL] --user U --password P`. Keep the extension-level auto-sync interval; map repository autosync configuration to `zit settings autosync on|off` only when the user changes it explicitly.

- [ ] **Step 6: Verify**

Exercise list/add branch and tag flows, stash lifecycle, local Git export, and authenticated argv redaction. Use a local Zit HTTP server for pull/push/sync integration tests.

## Task 9: Remove Fossil-Only Product Surface

**Files:**
- Delete: `src/preview.ts`, `media/preview.ts`, `media/preview.css`
- Modify: `src/commands.ts`, `src/interaction.ts`, `package.json`, `package.nls.json`, `README.md`, `docs/**`, `images/**`
- Test: `src/test/suite/extension.test.ts`, affected command suites

- [ ] **Step 1: Remove command contributions before code**

Delete web UI, wiki create/render/preview, patch create/apply, checkout close, private branch, tag cancel, staging, and staged-commit command/menu/keybinding contributions.

- [ ] **Step 2: Remove all callers and implementations**

Delete handlers and interaction paths; then delete preview/media files. Keep Pikchr language/grammar files only as local syntax support—no command may invoke Fossil or imply Zit interprets wiki artifacts.

- [ ] **Step 3: Rewrite command-discovery tests**

Assert the supported `zit.*` command set exactly and assert removed commands are absent. This prevents dead menu items from returning later.

- [ ] **Step 4: Verify dead-code cleanup**

Run TypeScript diagnostics, lint, and the full extension suite; no unused import, stale context key, or orphan asset may remain.

## Task 10: Complete Test, CI, Packaging, and Documentation Cutover

**Files:**
- Modify: all `src/test/suite/*.ts`, `.github/workflows/fossil.yml`, `README.md`, `CHANGELOG.md`, `docs/**`, `images/**`, `package.json`
- Rename: `.github/workflows/fossil.yml` → `.github/workflows/zit.yml`

- [ ] **Step 1: Convert shared test infrastructure**

Rename `cleanupFossil`, executable helpers, URI fixtures, status fixtures, sandbox paths, and command IDs. Use a fresh `zit init` checkout per behavioral test and deterministic commit metadata.

- [ ] **Step 2: Preserve meaningful suites and remove impossible ones**

Keep state, status bar, timeline, resource actions, revert, rename, merge, commit, branch, export, and utility coverage. Delete only tests for product surfaces removed in Task 9; replace Fossil parser tests with Zit output-contract tests.

- [ ] **Step 3: Install a pinned Zit release in CI**

In `.github/workflows/zit.yml`, replace `apt-get install fossil` with download, checksum, extract, and PATH setup for:

```text
https://fossil.craftdesign.group/zit/uv/releases/0.1.3/zit-0.1.3-linux-x86_64.tar.gz
sha256 cf4643218af87dc4c032e60ca9da0e2b768ce11c643ed74284de4339b0468979
```

Run `zit version` and require `zit 0.1.3` before tests. Keep Node 18, `npm ci`, SARIF lint, `xvfb-run -a npm run coverage-ci`, grammar tests, and VSIX packaging.

- [ ] **Step 4: Rewrite user documentation from exercised workflows**

Document installation, `zit.path`, repository discovery, init/clone/open, add/commit/update, branch/tag/stash, history/diff/annotate, sync, Git export, and the deliberate absence of staging/wiki/web UI. Regenerate screenshots from the working extension; do not rename Fossil screenshots and present them as Zit.

- [ ] **Step 5: Run the local CI equivalent**

On the current macOS workstation, run:

```sh
npm ci
npm run lint -- --format @microsoft/eslint-formatter-sarif --output-file eslint-results.sarif
npm run coverage-ci /tmp/vscode-zit-step-summary.md
npm run grammar-test
rm -rf out && npm run package
```

In the Linux CI job, run the same coverage command under `xvfb-run -a`. Expected: every command exits 0 and the package is `zit-<version>.vsix`.

- [ ] **Step 6: Smoke-test the real extension surface**

Launch the Extension Development Host, open a real Zit checkout, and verify repository discovery, status groups, add, commit, historical diff, update, merge conflict warning, branch/tag/stash, sync status, Git export, and missing-binary guidance.

- [ ] **Step 7: Establish the remote and PR gate**

Once the target Git remote exists, push a feature branch, open a PR, rerun the exact CI commands locally after every push, monitor remote checks, and squash-merge only when green.

## Implementation Order and Gates

1. **Baseline and identity (Tasks 1–2):** compilable renamed extension, no semantic claims yet.
2. **Deep backend boundary (Tasks 3–4):** executable found and repositories discovered/created correctly.
3. **Minimum useful SCM (Tasks 5–6):** status, add/remove, commit, update, and revert work end to end.
4. **Read/history workflows (Task 7):** virtual documents, diff, timeline, and annotate work.
5. **Advanced workflows (Task 8):** branch/tag/stash/export/sync work.
6. **Honest product cleanup (Task 9):** impossible Fossil-only surfaces are gone.
7. **Release qualification (Task 10):** full local CI, Extension Host smoke, package, then PR.

Do not begin a later gate while the prior gate’s focused tests or smoke scenario is red. Each task should land as a reviewable commit; generated lockfile changes travel with the manifest change that caused them.

## Primary Risks

- **Human-readable CLI contracts:** Zit help documents the formats used here, but parser fixtures must pin them so drift fails loudly.
- **History enrichment cost:** repository timeline is cheap; parent/user/file enrichment may invoke `artifact --raw` or `diff --brief` per selected entry. Keep enrichment lazy and bounded to visible/selected items.
- **No staging:** retaining the Fossil staging UI would be data-loss-prone because Zit commits all tracked changes. The plan removes it explicitly.
- **Conflict persistence:** Zit reports conflict paths during merge but does not classify them in later status calls. The extension must not claim otherwise.
- **Target repository is not yet connected to a remote:** implementation can proceed locally, but PR/CI merge automation begins only after the remote exists.
