import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), '..');

function requireString(manifest, field) {
    const value = manifest[field];
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`package.json ${field} must be a non-empty string`);
    }
    return value;
}

function requireListingUrl(manifest, field) {
    const value = manifest[field];
    const url = typeof value === 'string' ? value : value?.url;
    if (typeof url !== 'string' || url.trim() === '') {
        throw new Error(`package.json ${field} must provide a non-empty URL`);
    }
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function requireReadmeImages(root, readme) {
    const imagePattern =
        /!\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
    for (const [, reference] of readme.matchAll(imagePattern)) {
        if (/^[a-z][a-z\d+.-]*:/i.test(reference) || reference.startsWith('#')) {
            continue;
        }

        const imagePath = path.resolve(root, reference);
        const relativePath = path.relative(root, imagePath);
        if (
            relativePath.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relativePath)
        ) {
            throw new Error(`README image ${reference} escapes the repository`);
        }
        try {
            await access(imagePath);
        } catch {
            throw new Error(`README image ${reference} does not exist`);
        }
    }
}

export function createReleaseContract(manifest, changelog) {
    if (!manifest || typeof manifest !== 'object') {
        throw new Error('package.json manifest is required');
    }

    const name = requireString(manifest, 'name');
    const publisher = requireString(manifest, 'publisher');
    const version = requireString(manifest, 'version');
    requireString(manifest, 'license');
    requireListingUrl(manifest, 'repository');
    requireString(manifest, 'homepage');
    requireListingUrl(manifest, 'bugs');

    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
        throw new Error(`package.json version is not a release version: ${version}`);
    }
    if (
        !Array.isArray(manifest.activationEvents) ||
        manifest.activationEvents.length === 0 ||
        manifest.activationEvents.includes('*')
    ) {
        throw new Error(
            'package.json activationEvents must be explicit and must not contain "*"'
        );
    }
    if (typeof changelog !== 'string') {
        throw new Error('changelog content is required');
    }

    const versionHeading = new RegExp(
        `^##[ \\t]+${escapeRegExp(version)}(?:[ \\t]+.*)?$`,
        'm'
    );
    if (!versionHeading.test(changelog)) {
        throw new Error(`changelog must contain a heading for ${version}`);
    }

    const vsix = `${name}-${version}.vsix`;
    return {
        extensionId: `${publisher}.${name}`,
        version,
        tag: `v${version}`,
        vsix,
        checksum: `${vsix}.sha256`,
    };
}

export function assertReleaseTag(contract, tag) {
    if (tag !== contract.tag) {
        throw new Error(
            `release tag ${JSON.stringify(tag)} does not match packaged version ${contract.tag}`
        );
    }
}

async function sha256(filePath) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filePath)) {
        hash.update(chunk);
    }
    return hash.digest('hex');
}

export async function writeChecksum(vsixPath) {
    const checksumPath = `${vsixPath}.sha256`;
    const digest = await sha256(vsixPath);
    await writeFile(checksumPath, `${digest}  ${path.basename(vsixPath)}\n`);
    return checksumPath;
}

export async function verifyChecksum(vsixPath) {
    const checksumPath = `${vsixPath}.sha256`;
    const checksum = await readFile(checksumPath, 'utf8');
    const match = /^([a-f0-9]{64})  ([^\r\n]+)\n$/.exec(checksum);
    if (!match) {
        throw new Error(`invalid checksum file: ${checksumPath}`);
    }
    if (match[2] !== path.basename(vsixPath)) {
        throw new Error(
            `checksum filename ${JSON.stringify(match[2])} does not match ${path.basename(vsixPath)}`
        );
    }

    const actual = await sha256(vsixPath);
    if (actual !== match[1]) {
        throw new Error(`checksum mismatch for ${vsixPath}`);
    }
    return actual;
}

export async function readReleaseContract(root = projectRoot) {
    const [manifestSource, changelog, readme] = await Promise.all([
        readFile(path.join(root, 'package.json'), 'utf8'),
        readFile(path.join(root, 'CHANGELOG.md'), 'utf8'),
        readFile(path.join(root, 'README.md'), 'utf8'),
    ]);
    await requireReadmeImages(root, readme);
    return createReleaseContract(JSON.parse(manifestSource), changelog);
}

function releasePaths(contract, root = projectRoot) {
    const dist = path.join(root, 'dist');
    return {
        dist,
        vsixPath: path.join(dist, contract.vsix),
        checksumPath: path.join(dist, contract.checksum),
    };
}

export async function emitGithubOutputs(
    contract,
    outputFile = process.env.GITHUB_OUTPUT
) {
    const outputs = {
        extensionId: contract.extensionId,
        version: contract.version,
        tag: contract.tag,
        vsix: contract.vsix,
        checksum: contract.checksum,
        vsix_path: `dist/${contract.vsix}`,
        checksum_path: `dist/${contract.checksum}`,
    };
    const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
    process.stdout.write(`${lines.join('\n')}\n`);
    if (outputFile) {
        await appendFile(outputFile, `${lines.join('\n')}\n`);
    }
    return outputs;
}

export async function packageRelease(contract, root = projectRoot) {
    const { dist, vsixPath, checksumPath } = releasePaths(contract, root);
    await mkdir(dist, { recursive: true });

    const executable = path.join(
        root,
        'node_modules',
        '.bin',
        process.platform === 'win32' ? 'vsce.cmd' : 'vsce'
    );
    const result = spawnSync(executable, ['package', '--out', vsixPath], {
        cwd: root,
        stdio: 'inherit',
        shell: process.platform === 'win32',
    });
    if (result.error) {
        throw new Error(`unable to run locally installed vsce: ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error(`locally installed vsce exited with status ${result.status}`);
    }

    const writtenChecksum = await writeChecksum(vsixPath);
    if (writtenChecksum !== checksumPath) {
        throw new Error(`unexpected checksum path: ${writtenChecksum}`);
    }
    return { vsixPath, checksumPath };
}

async function main(args = process.argv.slice(2)) {
    const command = args[0] ?? 'contract';
    const contract = await readReleaseContract();
    const { vsixPath } = releasePaths(contract);

    switch (command) {
        case 'contract':
            await emitGithubOutputs(contract);
            break;
        case 'assert-tag':
            assertReleaseTag(contract, args[1] ?? process.env.GITHUB_REF_NAME);
            await emitGithubOutputs(contract);
            break;
        case 'package':
            await packageRelease(contract);
            await emitGithubOutputs(contract);
            break;
        case 'verify':
            await verifyChecksum(args[1] ?? vsixPath);
            await emitGithubOutputs(contract);
            break;
        default:
            throw new Error(
                'usage: release-contract.mjs [contract|assert-tag <tag>|package|verify [vsix]]'
            );
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    });
}
