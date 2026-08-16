# Supported command behavior

This document is the maintained product contract for the Zit extension. Command IDs use the `zit.` namespace.

## Repository lifecycle

| Command | Behavior |
| --- | --- |
| `zit.init` | Select a directory, run `zit init`, and offer to open the new checkout. |
| `zit.clone` | Collect a remote and destination, clone it, and offer to open the checkout. |
| `zit.open` | Open an existing checkout selected by the user. |
| `zit.refresh` | Refresh status, checkout identity, and remote counters. |

A checkout is discoverable when `.zit` and `.zit-checkout` are present in the workspace folder or one of its parents.

## Working tree and commits

| Command | Behavior |
| --- | --- |
| `zit.add` / `zit.addAll` | Track selected or all untracked files. Added files appear in the Added group. |
| `zit.forget` | Stop tracking selected paths without claiming a staging transition. |
| `zit.revert` / `zit.revertAll` | Restore selected or all tracked working-tree paths. |
| `zit.clean` | Delete selected untracked paths after confirmation. |
| `zit.commit` / `zit.commitAll` | Commit selected paths or all tracked changes directly from the working tree. |
| `zit.commitWithInput` | Commit using the Source Control input box. |
| `zit.update` | Preview and then update to a selected check-in, branch, or tag. |
| `zit.rename` | Perform a repository-aware path rename when enabled. |

Zit has no staging area. There are no stage, unstage, or commit-staged commands. Source Control exposes exactly Added, Working, and Untracked groups.

## History and inspection

| Command | Behavior |
| --- | --- |
| `zit.log` / `zit.fileLog` | Show repository or file history. |
| `zit.openChange` | Compare a working file or historical revision with its parent. |
| `zit.openFile` | Open a local or historical file. |
| `zit.annotate` | Show line attribution for a file. |
| `zit.revertChange` | Revert an individual editor change when the working document allows it. |

Historical content uses virtual Zit document URIs. Timeline enrichment remains lazy so opening a repository does not fetch every artifact body.

## Branches, tags, merges, and stashes

| Command family | Behavior |
| --- | --- |
| Branch | List, create, and switch branches. |
| Tag | List and add tags. Tag cancellation is not supported. |
| Merge | Merge or cherry-pick supported revisions into the working tree and report command-time conflicts. |
| Stash | Save, list, show, apply, pop, and drop stashes. |

Private branch creation and checkout-close mutation are not supported.

## Remotes and export

| Command | Behavior |
| --- | --- |
| `zit.pull` | Pull from a selected remote. |
| `zit.push` / `zit.pushTo` | Push to the default or selected remote. |
| `zit.sync` | Synchronize with the configured remote. |
| Git export commands | Configure and run Zit’s Git export workflow, subject to `zit.confirmGitExport`. |

## Deliberately absent

The extension does not expose a web UI, patches, wiki or technote creation, document rendering, or preview webviews. Pikchr syntax highlighting and grammar tests are independent editor support and do not invoke a repository renderer.
