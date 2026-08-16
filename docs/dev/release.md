# Releasing the Zit extension

## Prepare

1. Update the version in `package.json` and its lockfile.
2. Update `CHANGELOG.md` with user-visible changes.
3. Confirm that CI builds current Zit trunk with Zig 0.16 and `zig build --release=fast`.

## Qualify locally

Run the same gates as CI:

```sh
npm ci
npm run lint -- --format @microsoft/eslint-formatter-sarif --output-file eslint-results.sarif
npm run coverage-ci /tmp/vscode-zit-step-summary.md
npm run grammar-test
rm -rf out
npm run package
```

On Linux, run coverage with `xvfb-run -a`. Then install the generated `zit-<version>.vsix` and smoke-test repository discovery, status groups, add, commit, historical diff, update, merge diagnostics, branch/tag/stash, sync, Git export, and missing-binary guidance in an Extension Development Host.

## Publish

1. Open a release pull request and require all checks to pass.
2. Merge the release through the normal protected-branch process.
3. Tag the merged revision with `v<version>`.
4. Verify that the release workflow attached `zit-<version>.vsix`.
5. Publish that exact verified VSIX through the configured extension registries.

Never publish a VSIX produced from a dirty tree or a run that skipped the integration or packaging gates.
