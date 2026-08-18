# Releasing the Zit extension

The permanent extension ID is `danmestas.zit`. A release is built once in the
test workflow, checksummed, attached to a GitHub Release, and later promoted
unchanged to Open VSX. Official Zit binaries currently support macOS ARM64 and
Linux x86-64/ARM64; Windows is not a supported release target.

## Pre-account boundary

Repository preparation stops before any irreversible external state is
created. Do not create an Eclipse/Open VSX account, accept the Publisher
Agreement, create the `danmestas` namespace, generate or store a token, create
a tag or GitHub Release, or publish an extension while preparing the release.

The repository may contain the release automation before an Open VSX account
exists. CI and pull requests do not receive `OVSX_PAT`; only a manually
dispatched job protected by the `open-vsx` GitHub environment can access it.

## First-account handoff

The repository owner performs these one-time steps:

1. Create or select the Eclipse account that will own the extension, connect
   it to Open VSX, and accept the Open VSX Publisher Agreement.
2. Generate an Open VSX access token.
3. From a locked checkout, create the permanent namespace:

    ```sh
    npm ci
    export OVSX_PAT='<token>'
    ./node_modules/.bin/ovsx create-namespace danmestas -p "$OVSX_PAT"
    ```

4. In the GitHub repository settings, create an environment named
   `open-vsx`. Add required reviewers so publication remains an explicit
   approval step.
5. Add the token as an environment secret named `OVSX_PAT`. Do not add it as
   a repository or organization secret.

The namespace must match the `publisher` field in `package.json`; changing it
would change the extension ID rather than rename the existing listing.

## Prepare and qualify

1. Update the version in `package.json` and `package-lock.json`.
2. Add a matching `## <version> - YYYY-MM-DD` heading to `CHANGELOG.md`.
3. Confirm the public listing metadata and explicit activation event with:

    ```sh
    npm ci
    npm run release:test
    npm run release:contract
    ```

4. Run the same lint, coverage, grammar, Zit-build, and packaging gates as CI.
   The packaging gate is:

    ```sh
    rm -rf out
    npm run release:package
    ```

    It creates only `dist/zit-<version>.vsix` and
    `dist/zit-<version>.vsix.sha256`.
    Packaging fails if `.zig-cache` content is visible to `vsce` or the VSIX
    exceeds 5 MiB. Investigate the leaked/generated content instead of raising
    that limit.

5. Install that VSIX in a clean Extension Development Host and smoke-test
   repository discovery, status groups, add, commit, historical diff, update,
   merge diagnostics, branch/tag/stash, sync, Git export, and missing-binary
   guidance on a supported platform.

## Tag and create the GitHub Release

1. Open a release pull request and require all checks to pass.
2. Merge through the protected `main` branch process.
3. Tag the merged release commit with exactly `v<package.json version>` and
   push the tag. For 0.8.0, the tag is `v0.8.0`.
4. The `Zit` workflow validates the tag, runs the full test gates, invokes the
   shared release packager once, and uploads the VSIX plus checksum as an
   Actions artifact.
5. On a tag build, the release job downloads that tested Actions artifact and
   attaches those exact two files to the GitHub Release. It does not rebuild
   the extension.
6. Confirm the release contains both canonical assets before considering it
   promotable:

    ```text
    zit-<version>.vsix
    zit-<version>.vsix.sha256
    ```

## Promote to Open VSX

Promotion is a separate, manual, environment-gated operation. In the Actions
UI, choose **Publish to Open VSX**, select **Run workflow**, and enter the
existing release tag. The equivalent CLI dispatch is:

```sh
gh workflow run publish-open-vsx.yml -f tag=v0.8.0
```

The workflow checks out the explicit `refs/tags/<tag>` ref, derives the
filenames from the release contract, and validates the tag before running any
dependency lifecycle scripts. It then installs the locked dependencies,
downloads both assets from the GitHub Release, verifies the checksum, and
passes the existing VSIX to the locally installed `ovsx` 1.1.1. It never runs
the bundler, `vsce`, or any packaging command.

## Immutable artifact rule

The checksum file uses the standard form:

```text
<64 lowercase hexadecimal SHA-256 characters>  zit-<version>.vsix
```

The two spaces before the filename are significant. Every destination must
receive the exact VSIX bytes produced by the tested tag workflow. Never
repackage for promotion, replace a GitHub Release asset with different bytes,
or reuse a published version number. Any source or byte change requires a new
version and a new tag.

## Failure and rollback

- If tag validation, asset download, or checksum verification fails, do not
  publish. Correct the source metadata or automation, increment the version,
  and create a new release tag. Do not rewrite the existing tag or assets.
- If the GitHub Release is missing an asset, promotion remains blocked. A
  workflow retry is acceptable only when it restores the original tested
  artifact bytes; compare the checksum before attaching anything.
- If authentication fails before publication, revoke or replace the token in
  the `open-vsx` environment and manually dispatch again after approval.
- If the publish command has an uncertain result, inspect
  `danmestas.zit` on Open VSX before retrying. Never retry blindly after a
  successful publication.
- A published Open VSX version is not rolled back by rebuilding or overwriting
  it. Disable further promotions, document the problem, and ship a corrected
  patch version with a new immutable artifact.
