import * as cp from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { LogOutputChannel } from 'vscode';
import typedConfig from './config';
import * as interaction from './interaction';
import type { Distinct, ZitRoot } from './openedRepository';
import type { ZitExecutableInfo } from './zitFinder';

export type ZitVersion = Distinct<number[], 'zit version'>;
export type ZitStdOut = Distinct<
    string,
    'raw zit stdout' | 'zit status stdout'
>;
export type ZitStdErr = Distinct<string, 'raw zit stderr'>;
export type Reason = Distinct<string, 'exec reason'> | undefined;
export type DocumentFsPath = Distinct<string, 'vscode document fsPath'>;
export type ZitCWD = Distinct<string, 'cwd for executing zit'> | ZitRoot;
export type ZitExecutablePath = Distinct<string, 'zit executable path'>;
export type ZitArgs = readonly string[];
export type ZitArgsWithOptions = readonly string[];
export type ZitExitCode = 0 | 1 | 2;

export interface ZitSpawnOptions extends cp.SpawnOptionsWithoutStdio {
    readonly cwd: ZitCWD;
    /** Abort and terminate the spawned Zit process. */
    readonly signal?: AbortSignal;
    /** Log stderr and offer to open the Zit output channel. */
    readonly logErrors?: boolean;
    /** Supply data to stdin and close it. */
    readonly stdin_data?: string;
}

export interface SpawnFailure {
    readonly name: string;
    readonly message: string;
    readonly code?: string;
}

interface BaseResult {
    readonly zitPath: ZitExecutablePath;
    readonly exitCode: ZitExitCode;
    readonly args: ZitArgsWithOptions;
    readonly cwd: ZitCWD;
    readonly command: string;
    readonly durationMs: number;
    readonly spawnFailure?: SpawnFailure;
}

export type RawExecResult = BaseResult & {
    readonly stdout: Buffer;
    readonly stderr: Buffer;
};

interface ExecSuccess extends BaseResult {
    readonly exitCode: 0;
    readonly stdout: ZitStdOut;
    readonly stderr: ZitStdErr;
}

export interface ExecFailure extends BaseResult {
    readonly exitCode: 1 | 2;
    readonly stdout: ZitStdOut;
    readonly stderr: ZitStdErr;
    readonly message: string;
    toString(): string;
}

export type ExecResult = ExecSuccess | ExecFailure;

export function toString(this: ExecFailure): string {
    const { message, toString: _toString, ...details } = this;
    return `${message} ${JSON.stringify(details, null, 2)}`;
}

function msFromHighResTime(hiResTime: [number, number]): number {
    const [seconds, nanoSeconds] = hiResTime;
    return seconds * 1e3 + nanoSeconds / 1e6;
}

function normalizeExitCode(code: number | null): ZitExitCode {
    return code === 0 || code === 2 ? code : 1;
}

function spawnFailureOf(error: Error & { code?: string }): SpawnFailure {
    return {
        name: error.name,
        message: error.message,
        ...(error.code ? { code: error.code } : {}),
    };
}

function isCancellation(error: Error & { code?: string }): boolean {
    return error.name === 'AbortError' || error.code === 'ABORT_ERR';
}

function redactArgs(args: ZitArgs): ZitArgsWithOptions {
    const redacted = [...args];
    for (let index = 0; index < redacted.length; index++) {
        const arg = redacted[index];
        if (arg === '--password' && index + 1 < redacted.length) {
            redacted[++index] = '*********';
            continue;
        }
        if (arg.startsWith('--password=')) {
            redacted[index] = '--password=*********';
            continue;
        }
        redacted[index] = arg.replace(
            /(\w+:\/\/[^\s/:@]+:)[^\s@]+(@)/,
            '$1*********$2'
        );
    }
    return redacted;
}

export class ZitExecutable {
    private zitPath!: ZitExecutablePath;
    public version!: ZitVersion;

    constructor(public readonly outputChannel: LogOutputChannel) {}

    setInfo(info: ZitExecutableInfo): void {
        this.zitPath = info.path;
        this.version = info.version;
    }

    async findRoot(anyPath: string): Promise<ZitRoot | undefined> {
        let current = path.resolve(anyPath);
        try {
            if ((await fs.stat(current)).isFile()) {
                current = path.dirname(current);
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
            return;
        }

        while (true) {
            try {
                const checkout = await fs.stat(
                    path.join(current, '.zit-checkout')
                );
                if (checkout.isFile()) {
                    return current as ZitRoot;
                }
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code !== 'ENOENT' && code !== 'ENOTDIR') {
                    throw error;
                }
            }

            const parent = path.dirname(current);
            if (parent === current) {
                return;
            }
            current = parent;
        }
    }

    async cat(cwd: ZitCWD, args: ZitArgs): Promise<Buffer | undefined> {
        const result = await this.loggingExec(args, { cwd });
        return result.exitCode === 0 ? result.stdout : undefined;
    }

    /** Public for focused process-contract tests. */
    async rawExec(
        args: ZitArgsWithOptions,
        options: ZitSpawnOptions
    ): Promise<RawExecResult> {
        const start = process.hrtime();
        const redactedArgs = redactArgs(args);
        const command = [this.zitPath, ...redactedArgs].join(' ');
        const base = () => ({
            zitPath: this.zitPath,
            args: redactedArgs,
            cwd: options.cwd,
            command,
            durationMs: msFromHighResTime(process.hrtime(start)),
        });

        const childOptions = {
            ...options,
        } as cp.SpawnOptions & {
            stdin_data?: string;
            logErrors?: boolean;
        };
        delete childOptions.stdin_data;
        delete childOptions.logErrors;
        const spawnOptions: cp.SpawnOptions = {
            ...childOptions,
            stdio: 'pipe',
            env: {
                ...process.env,
                ...options.env,
                LC_ALL: 'en_US',
                LANG: 'en_US.UTF-8',
            },
        };

        return new Promise<RawExecResult>((resolve, reject) => {
            let child: cp.ChildProcessWithoutNullStreams;
            try {
                child = cp.spawn(
                    this.zitPath,
                    [...args],
                    spawnOptions
                ) as cp.ChildProcessWithoutNullStreams;
            } catch (error) {
                const spawnError = error as Error & { code?: string };
                if (isCancellation(spawnError)) {
                    reject(spawnError);
                    return;
                }
                const failure = spawnFailureOf(spawnError);
                resolve({
                    ...base(),
                    exitCode: 1,
                    stdout: Buffer.alloc(0),
                    stderr: Buffer.alloc(0),
                    spawnFailure: failure,
                });
                return;
            }

            const stdout: Buffer[] = [];
            const stderr: Buffer[] = [];
            let promptTimeout: ReturnType<typeof setTimeout> | undefined;
            let failure: SpawnFailure | undefined;
            let settled = false;

            const finish = (code: number | null): void => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(promptTimeout);
                resolve({
                    ...base(),
                    exitCode: failure ? 1 : normalizeExitCode(code),
                    stdout: Buffer.concat(
                        stdout.map(buffer => new Uint8Array(buffer))
                    ),
                    stderr: Buffer.concat(
                        stderr.map(buffer => new Uint8Array(buffer))
                    ),
                    ...(failure ? { spawnFailure: failure } : {}),
                });
            };

            const checkForPrompt = ![
                'cat',
                'status',
                'extras',
                'diff',
            ].includes(args[0]);
            child.stdout.on('data', (buffer: Buffer) => {
                stdout.push(buffer);
                if (!checkForPrompt) {
                    return;
                }
                clearTimeout(promptTimeout);
                promptTimeout = setTimeout(async () => {
                    const tail = buffer.toString();
                    if (/[:?]\s?$/.test(tail)) {
                        const response = await interaction.inputPrompt(
                            Buffer.concat(
                                stdout.map(buffer => new Uint8Array(buffer))
                            ).toString('utf8') as ZitStdOut,
                            args
                        );
                        child.stdin.write(`${response}\n`);
                    }
                }, 50);
            });
            child.stderr.on('data', (buffer: Buffer) => stderr.push(buffer));
            child.once('error', error => {
                const spawnError = error as Error & { code?: string };
                if (isCancellation(spawnError)) {
                    settled = true;
                    clearTimeout(promptTimeout);
                    reject(spawnError);
                    return;
                }
                failure = spawnFailureOf(spawnError);
                setImmediate(() => finish(1));
            });
            child.once('close', finish);

            if (options.stdin_data !== undefined) {
                child.stdin.end(options.stdin_data);
            }
        });
    }

    private async loggingExec(
        args: ZitArgs,
        options: ZitSpawnOptions,
        reason?: Reason
    ): Promise<RawExecResult> {
        const waitAndLog = (timeout: number): ReturnType<typeof setTimeout> =>
            setTimeout(() => {
                this.logArgs(args, 'still running', reason);
                logTimeout = waitAndLog(timeout * 4);
            }, timeout);
        let logTimeout = waitAndLog(500);
        const globalArgs = typedConfig.globalArgs;
        const rawArgs =
            globalArgs.length && args.length
                ? [args[0], ...globalArgs, ...args.slice(1)]
                : args;
        try {
            const result = await this.rawExec(rawArgs, options);
            this.logArgs(args, `${Math.floor(result.durationMs)}ms`, reason);
            return result;
        } finally {
            clearTimeout(logTimeout);
        }
    }

    async exec(
        cwd: ZitCWD,
        args: ZitArgs,
        reason?: Reason,
        options: Omit<ZitSpawnOptions, 'cwd'> = {}
    ): Promise<ExecResult> {
        const raw = await this.loggingExec(args, { cwd, ...options }, reason);
        const result = {
            ...raw,
            stdout: raw.stdout.toString('utf8') as ZitStdOut,
            stderr: raw.stderr.toString('utf8') as ZitStdErr,
        };
        if (result.exitCode === 0) {
            return result as ExecSuccess;
        }

        if (options.logErrors !== false) {
            const diagnostic = result.stderr || result.spawnFailure?.message;
            if (diagnostic) {
                this.outputChannel.error(`(${result.command}): ${diagnostic}`);
            }
        }
        const failure: ExecFailure = {
            ...result,
            exitCode: result.exitCode,
            message: 'Failed to execute zit',
            toString,
        };
        if (options.logErrors !== false) {
            const openLog = await interaction.errorPromptOpenLog(failure);
            if (openLog) {
                this.outputChannel.show();
            }
        }
        return failure;
    }

    private logArgs(args: ZitArgs, info: string, reason: Reason): void {
        const safeArgs = redactArgs(args);
        this.outputChannel.info(
            `zit ${safeArgs.join(' ')}: ${info}${reason ? ` // ${reason}` : ''}`
        );
    }
}
