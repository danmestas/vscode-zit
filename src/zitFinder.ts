import * as cp from 'child_process';
import { LogOutputChannel } from 'vscode';
import type { Distinct } from './openedRepository';
import type { ZitExecutablePath, ZitStdOut, ZitVersion } from './zitExecutable';

export type UnvalidatedZitExecutablePath = Distinct<
    string,
    'unvalidated zit executable path' | 'zit executable path'
>;

export interface ZitExecutableInfo {
    path: ZitExecutablePath;
    version: ZitVersion;
}

export type VersionSpawn = (
    path: UnvalidatedZitExecutablePath,
    args: readonly string[],
    options: cp.SpawnOptionsWithoutStdio
) => cp.ChildProcessWithoutNullStreams;

export function parseZitVersion(output: string): ZitVersion | undefined {
    const match = output.match(/^zit (\d+)\.(\d+)\.(\d+)\b/);
    if (!match) {
        return;
    }
    return match.slice(1, 4).map(value => Number(value)) as ZitVersion;
}

function getVersion(
    path: UnvalidatedZitExecutablePath,
    spawn: VersionSpawn
): Promise<ZitStdOut> {
    return new Promise<ZitStdOut>((resolve, reject) => {
        const buffers: Buffer[] = [];
        const child = spawn(path, ['version'], {});
        let settled = false;
        const fail = (error: Error): void => {
            if (!settled) {
                settled = true;
                reject(error);
            }
        };
        child.stdout.on('data', (buffer: Buffer) => buffers.push(buffer));
        child.on('error', fail);
        child.on('close', code => {
            if (settled) {
                return;
            }
            if (code === 0) {
                settled = true;
                resolve(
                    Buffer.concat(
                        buffers.map(buffer => new Uint8Array(buffer))
                    ).toString('utf8') as ZitStdOut
                );
                return;
            }
            fail(new Error(`'zit version' exited with code ${code}`));
        });
    });
}

export async function findZit(
    hint: UnvalidatedZitExecutablePath,
    outputChannel: LogOutputChannel,
    spawnVersion: VersionSpawn = cp.spawn
): Promise<ZitExecutableInfo | undefined> {
    const hasConfiguredPath = Boolean(hint) && hint !== 'zit';
    const candidates = [hint, 'zit' as UnvalidatedZitExecutablePath].filter(
        (candidate, index, all) =>
            Boolean(candidate) && all.indexOf(candidate) === index
    );

    for (const path of candidates) {
        let stdout: ZitStdOut;
        try {
            stdout = await getVersion(path, spawnVersion);
        } catch (error: unknown) {
            if (hasConfiguredPath && path === hint) {
                outputChannel.warn(
                    `\`zit.path\` '${path}' is unavailable (${error}). Will try 'zit' on PATH`
                );
            } else {
                outputChannel.error(
                    `'zit' is unavailable (${error}). Zit extension commands will be disabled`
                );
            }
            continue;
        }

        const version = parseZitVersion(stdout);
        if (!version) {
            outputChannel.error(
                `Failed to parse zit version from output: '${stdout}'`
            );
            continue;
        }

        outputChannel.info(`Using zit ${version.join('.')} from ${path}`);
        return {
            path: path as ZitExecutablePath,
            version,
        };
    }
    return;
}
