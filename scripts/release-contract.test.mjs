import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    assertReleaseTag,
    createReleaseContract,
    readReleaseContract,
    verifyChecksum,
    writeChecksum,
} from './release-contract.mjs';

const readyManifest = {
    name: 'zit',
    publisher: 'danmestas',
    version: '0.8.0',
    license: 'MIT',
    repository: {
        type: 'git',
        url: 'https://github.com/danmestas/vscode-zit.git',
    },
    homepage: 'https://github.com/danmestas/vscode-zit#readme',
    bugs: {
        url: 'https://github.com/danmestas/vscode-zit/issues',
    },
    activationEvents: ['onStartupFinished'],
};

const changelog = '# Changelog\n\n## 0.8.0 - 2026-08-18\n';

test('creates one immutable artifact contract from package metadata', () => {
    assert.deepEqual(createReleaseContract(readyManifest, changelog), {
        extensionId: 'danmestas.zit',
        version: '0.8.0',
        tag: 'v0.8.0',
        vsix: 'zit-0.8.0.vsix',
        checksum: 'zit-0.8.0.vsix.sha256',
    });
});

test('rejects incomplete public listing metadata', () => {
    for (const field of ['license', 'repository', 'homepage', 'bugs']) {
        const manifest = structuredClone(readyManifest);
        delete manifest[field];
        assert.throws(
            () => createReleaseContract(manifest, changelog),
            new RegExp(field)
        );
    }
});

test('rejects wildcard activation and an unversioned changelog', () => {
    assert.throws(
        () =>
            createReleaseContract(
                { ...readyManifest, activationEvents: ['*'] },
                changelog
            ),
        /activationEvents/
    );
    assert.throws(
        () => createReleaseContract(readyManifest, '# Changelog\n'),
        /changelog/
    );
});

test('requires the release tag to match the packaged version', () => {
    const contract = createReleaseContract(readyManifest, changelog);
    assert.doesNotThrow(() => assertReleaseTag(contract, 'v0.8.0'));
    assert.throws(
        () => assertReleaseTag(contract, 'v0.8.1'),
        /does not match/
    );
});

test('reads the repository changelog using its canonical filename', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zit-contract-'));
    try {
        await Promise.all([
            writeFile(
                path.join(directory, 'package.json'),
                JSON.stringify(readyManifest)
            ),
            writeFile(path.join(directory, 'CHANGELOG.md'), changelog),
            writeFile(path.join(directory, 'README.md'), '# Zit\n'),
        ]);
        assert.deepEqual(await readReleaseContract(directory), {
            extensionId: 'danmestas.zit',
            version: '0.8.0',
            tag: 'v0.8.0',
            vsix: 'zit-0.8.0.vsix',
            checksum: 'zit-0.8.0.vsix.sha256',
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('rejects missing local README images', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zit-contract-'));
    try {
        await Promise.all([
            writeFile(
                path.join(directory, 'package.json'),
                JSON.stringify(readyManifest)
            ),
            writeFile(path.join(directory, 'CHANGELOG.md'), changelog),
            writeFile(
                path.join(directory, 'README.md'),
                '# Zit\n\n![Missing screenshot](images/missing.png)\n'
            ),
        ]);
        await assert.rejects(
            () => readReleaseContract(directory),
            /README image .* does not exist/
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('writes and verifies a checksum for the exact VSIX bytes', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zit-release-'));
    const vsix = path.join(directory, 'zit-0.8.0.vsix');
    try {
        await writeFile(vsix, 'immutable-vsix-bytes');
        const checksumPath = await writeChecksum(vsix);
        const checksum = await readFile(checksumPath, 'utf8');
        assert.match(
            checksum,
            /^[a-f0-9]{64}  zit-0\.8\.0\.vsix\n$/
        );
        await assert.doesNotReject(() => verifyChecksum(vsix));
        await writeFile(vsix, 'different-bytes');
        await assert.rejects(() => verifyChecksum(vsix), /checksum mismatch/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
