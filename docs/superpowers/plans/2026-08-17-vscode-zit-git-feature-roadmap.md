# VS Code Git-Feature Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this roadmap task-by-task. Checklist state is authoritative until the repository gains a remote issue tracker.

**Goal:** Bring the highest-value native VS Code Git-extension affordances to Zit without importing Git-only staging, index, rebase, or remote-tracking semantics.

**Architecture:** Keep `ZitExecutable` and `OpenedRepository` as the CLI boundary, `Repository` as the VS Code-facing state boundary, and `Commands` plus `interaction` as the user-interaction boundary. Every feature must use Zit’s actual command contracts and preserve the extension’s no-staging model.

**Tech Stack:** TypeScript, VS Code Extension API, Zit CLI, Mocha, Sinon, esbuild, and VSIX packaging.

---

## Delivery order

Item 1 is complete. Items 6 and 7 are the current serial implementation wave. The remaining items stay independently implementable and issue-ready.

- [x] 1. Safe Trash-based untracked discard — **complete**
- [ ] 2. Native Source Control action button — **tracked**
- [ ] 3. Multi-diff Open All Changes — **tracked**
- [ ] 4. Compare refs and check-ins — **tracked**
- [ ] 5. Native SCM history graph — **tracked**
- [ ] 6. Default remote management — **in progress**
- [ ] 7. Zit worktree awareness — **queued after item 6**
- [ ] 8. Complete tag management — **tracked**

## 1. Safe Trash-based untracked discard

**What to build:** Preserve Zit’s dry-run preview and confirmation, but move each confirmed untracked resource to the operating-system Trash through VS Code instead of invoking permanent `zit clean --force` deletion.

**Acceptance criteria:**

- [x] The preview still comes from `zit clean --dry-run` and operational preview failures stop the action.
- [x] Confirmed files and directories are deleted with `workspace.fs.delete(..., { recursive: true, useTrash: true })`.
- [x] Cancellation deletes nothing, and an empty preview does not prompt.
- [x] Partial filesystem failures are surfaced and never followed by permanent CLI deletion.
- [x] Tests cover files, directories, cancellation, empty output, preview failure, and Trash failure.

## 2. Native Source Control action button

**What to build:** Add a contextual Source Control action button that makes Commit the primary action and exposes Zit’s existing commit variants as secondary actions without introducing staging semantics.

**Acceptance criteria:**

- [ ] A repository with committable changes exposes a primary Commit action.
- [ ] Commit All and Commit to New Branch remain available as secondary actions.
- [ ] The action button reacts to repository state and disappears when no valid action exists.
- [ ] Existing commit-input Enter behavior remains unchanged.

## 3. Multi-diff Open All Changes

**What to build:** Replace the current loop that opens one diff editor per resource with one VS Code multi-diff surface containing the selected Source Control group’s changes.

**Acceptance criteria:**

- [ ] Open All Changes produces one multi-diff editor.
- [ ] Added, edited, deleted, missing, and executable-bit changes resolve to correct left and right resources.
- [ ] Single-resource Open Change behavior remains unchanged.
- [ ] Empty groups do not open an editor.

## 4. Compare refs and check-ins

**What to build:** Expose arbitrary branch, tag, and check-in comparison using `zit diff --from CHECKIN --to CHECKIN`, with selection actions available from history and the Command Palette.

**Acceptance criteria:**

- [ ] Users can select one ref and compare it with another.
- [ ] The result opens as a bounded multi-diff view.
- [ ] Added, modified, deleted, binary, and executable-bit changes are represented correctly.
- [ ] Ambiguous and missing check-in names surface Zit’s actionable diagnostic.

## 5. Native SCM history graph

**What to build:** Adapt the existing Zit timeline and history parsing to VS Code’s native SCM history surface, including parent relationships, branch and tag refs, check-in details, and contextual operations.

**Acceptance criteria:**

- [ ] The graph preserves Zit DAG parent relationships rather than presenting history as a single linear stream.
- [ ] Branches and symbolic tags appear as refs on their check-ins.
- [ ] Users can copy check-in IDs and comments and invoke Update, Cherry-pick, Tag, and Compare.
- [ ] Existing Explorer Timeline workflows continue to work until an explicit clean cutover is complete.

## 6. Default remote management

**What to build:** Expose Zit’s single default remote through Show, Set, and Clear actions backed by `zit remote`, `zit remote URL`, and `zit remote --unset`.

**Acceptance criteria:**

- [x] Show Remote reports the saved URL or that no remote is configured.
- [x] Set Remote validates HTTP or HTTPS, rejects embedded credentials, and persists the selected URL.
- [x] Clear Remote requires confirmation and removes the saved remote.
- [x] Remote changes refresh status-bar and autosync state immediately.
- [x] Operational failures preserve the previous remote and surface Zit’s diagnostic.

## 7. Zit worktree awareness

**What to build:** Add a Zit-native worktree picker backed by `zit worktrees`, plus commands to open a registered worktree and create a detached working tree with `zit open --store=PATH`.

**Acceptance criteria:**

- [x] Registered worktrees display their path, branch, check-in prefix, and current-tree marker.
- [x] Users can open a selected worktree in the current or a new VS Code window.
- [x] Users can create a detached worktree in a selected empty directory against the current repository store.
- [x] Creation refuses non-empty directories and leaves failed destinations unregistered.
- [x] No command deletes worktree directories; Zit’s advisory registry remains authoritative.

## 8. Complete tag management

**What to build:** Add symbolic-tag browsing and cancellation using `zit tag list` and `zit tag cancel NAME CHECKIN`, while keeping raw and propagating tags outside the normal workflow.

**Acceptance criteria:**

- [ ] Users can list symbolic tags globally and on one check-in.
- [ ] Users can cancel a symbolic tag from a selected check-in after confirmation.
- [ ] Tag changes refresh branch, history, and timeline surfaces.
- [ ] Raw and propagating tags are not presented as ordinary release tags.

## Explicit non-goals

- Staging, unstaging, index, or hunk-staging workflows.
- Rebase, pull-rebase, force-push, or remote-tracking branch emulation.
- Git commit-signing, no-verify, submodule, or unsafe-repository semantics.
- Worktree deletion before Zit owns an explicit safe deletion operation.
