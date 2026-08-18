# Building, testing, and packaging

## Requirements

- Node.js 24 LTS
- npm
- a current Zit executable built with Zig 0.16, available on `PATH` or configured through `zit.path`

To build Zit from its current trunk, clone the public repository at `https://fossil.craftdesign.group/zit`, open the checkout, and run:

```sh
zig build --release=fast
```

Put `zig-out/bin/zit` on `PATH` before running integration tests.

## Install and compile

```sh
npm ci
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host.

## Test and qualify

The integration runner creates its workspace under the operating system temporary directory. Tests must initialize fresh Zit checkouts and must not depend on a developer repository.

```sh
npm run lint -- --format @microsoft/eslint-formatter-sarif --output-file eslint-results.sarif
npm run coverage-ci /tmp/vscode-zit-step-summary.md
npm run grammar-test
```

On Linux, run coverage through Xvfb:

```sh
xvfb-run -a npm run coverage-ci /tmp/vscode-zit-step-summary.md
```

## Package

```sh
rm -rf out
npm run package
```

The package name is `zit-<version>.vsix`. Install it locally with **Extensions: Install from VSIX…** and smoke-test a real Zit checkout before release.
