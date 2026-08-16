# Manual smoke and screenshot scenarios

Use these scenarios to qualify the actual Zit extension surface. Do not reuse or rename screenshots from the former extension: capture new media only after the corresponding scenario passes against a real Zit checkout.

## Standard setup

- Build and install the current extension VSIX.
- Put a current `zit` executable on `PATH`.
- Disable unrelated Source Control extensions.
- Use a disposable checkout initialized with `zit init`.
- Create the root check-in with a fixed test user and an explicit message.

## Repository discovery and status

1. Open a folder containing `.zit` and `.zit-checkout`.
2. Confirm that Source Control shows Added, Working, and Untracked groups only.
3. Add a new file, modify a tracked file, and create an untracked file.
4. Refresh and confirm that each path appears once in the correct group.
5. Reopen the workspace from a nested folder and confirm upward discovery.

## Commit and history

1. Commit tracked changes directly from the working tree.
2. Confirm that no staging action or staging group appears.
3. Open repository and file timelines.
4. Compare the new check-in with its parent and open historical file content.
5. Open annotate for a tracked file.

## Update and merge

1. Create a second branch and commit a distinct change.
2. Switch branches from the status bar.
3. Run an update and confirm the preview and final checkout identity.
4. Create a merge conflict and confirm that the command reports affected paths without leaving a persistent conflict group claim.

## Branch, tag, stash, and sync

1. Create and switch to a branch.
2. Add and list a tag.
3. Save, list, apply, pop, and drop a stash.
4. Configure a disposable remote, then exercise pull, push, and sync.
5. Exercise Git export and its confirmation setting.

## Missing executable

1. Launch with `zit` absent from `PATH` and `zit.path` empty.
2. Confirm that the guidance names Zit and links to the official Zit download page.
3. Set `zit.path` to a valid executable and confirm recovery without changing the workspace.

## Media policy

Capture screenshots or recordings only from the scenarios above. Crop secrets and remote credentials. Store no media that shows staging, wiki rendering, patch commands, a web UI, private branches, tag cancellation, or checkout-close mutation, because those surfaces are deliberately unsupported.
