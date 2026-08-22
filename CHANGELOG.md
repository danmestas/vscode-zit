# Changelog

All notable changes to the Zit extension are documented here.

## 0.8.1 - 2026-08-22

### Changed

- Added a complete visual feature tour to the README and Open VSX listing.
- Simplified Praise inline annotations to show the full author and a weekday-aware date, while retaining complete check-in details on hover.

## 0.8.0 - 2026-08-18

### Changed

- Ported the extension identity, configuration namespace, command IDs, URI schemes, and packaging from Fossil to Zit.
- Replaced the executable boundary with `ZitExecutable` and repository discovery based on the regular `.zit-checkout` marker, including detached worktrees whose store lives elsewhere.
- Reworked Source Control around Zit’s no-staging model with Added, Working, and Untracked groups.
- Updated commit, update, revert, rename, merge, history, Praise, branch, tag, stash, sync, and Git export workflows for Zit command contracts.
- Updated integration fixtures to initialize fresh Zit checkouts and use Zit output contracts.
- Updated CI to build current Zit trunk with Zig 0.16 before running coverage and packaging a `zit-<version>.vsix` artifact.
- Rewrote user and developer documentation around supported Zit workflows.
- Upgraded development and CI tooling to Node.js 24 LTS, current VS Code test/package tooling, ESLint 10 flat configuration, and Node 24 GitHub Actions.
- Added **Add to .zitignore** actions for Explorer files and untracked Source Control resources, including multi-selection and duplicate-safe updates.
- Added an Explorer-side Zit Timeline view with automatic file scoping, project history, bounded paging, commit details, and parent diffs.
- Renamed the per-line annotation command to **Praise** and populated each committed line with its check-in, date, and author from Zit metadata.
- Restricted automatic repository discovery to materialized Zit checkouts so bare `.zit` stores and non-Zit workspaces stay silent.
- Changed **Clean** to move confirmed untracked files and directories to the operating-system Trash instead of permanently deleting them with `zit clean --force`.
- Added **Show Remote**, **Set Remote**, and **Clear Remote** actions with replacement/removal confirmation and immediate status-bar and autosync updates.
- Added symbolic-tag browsing across the repository or a selected check-in, plus confirmed tag cancellation and refreshed Source Control/timeline state.
- Added arbitrary branch, symbolic-tag, and check-in comparison from the Command Palette, Source Control Timeline menu, and timeline check-in actions, with all changed files opened in one multi-diff editor.

### Removed

- Stage, unstage, and commit-staged commands.
- Web UI, patch, wiki creation, technote creation, and document-rendering features.
- Private branch creation and checkout-close mutation.
- Legacy screenshots that depicted the former extension rather than Zit.

## Project history

This project was ported from vscode-fossil. Its earlier release history described a different executable, command namespace, and product surface and is intentionally not presented as Zit behavior. The source history remains the authoritative record for those releases.
