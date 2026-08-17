/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ben Crowl. All rights reserved.
 *  Original Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import type { Stats } from 'fs';
import * as fs from 'fs/promises';
import { Uri } from 'vscode';
import {
    ZitExecutable,
    ZitSpawnOptions,
    ZitArgs,
    ZitCWD,
    ExecResult,
    Reason,
    DocumentFsPath,
} from './zitExecutable';
import { NewBranchOptions } from './interaction';
import typedConfig from './config';

export type Distinct<T, DistinctName extends string> = T & {
    __TYPE__: DistinctName;
};
/** Local checkout root containing the `.zit` store marker. */
export type ZitRoot = Distinct<string, 'local Zit checkout root'>;
export type RelativePath = Distinct<string, 'path relative to `ZitRoot`'>;
/** path that came from  `showOpenDialog` or `showSaveDialog`*/
export type UserPath = Distinct<string, 'user path'>;
/** path from `SourceControlResourceState.resourceUri.fsPath` */
export type ResourcePath = Distinct<string, 'resourceUri.fsPath'>;
export type AnyPath = RelativePath | ResourcePath | UserPath;

export type ZitURIString = Distinct<string, 'Zit URI string'>;
/** HTTP(S) sync endpoint accepted by `zit clone`, `pull`, `push`, and `sync`. */
export interface ZitURI extends Uri {
    __TYPE__: 'Zit URI';
    toString(): ZitURIString;
}

export type ZitBranch = Distinct<string, 'Zit branch name'>;
export type ZitSpecialTags = 'current' | 'parent' | 'tip';
export type ZitTag = Distinct<string, 'Zit tag name'>;
export type ZitHash = Distinct<string, 'Zit SHA3-256 hash'>;
export type ZitCheckin = ZitBranch | ZitTag | ZitHash | ZitSpecialTags;
/** Stdout of `zit status`. */
export type StatusString = Distinct<string, 'zit status stdout'>;
/** Any commit message */
export type ZitCommitMessage = Distinct<string, 'Commit Message'>;
export const enum MergeAction {
    Merge,
    Cherrypick,
}
export type ZitUsername = Distinct<string, 'Zit username'>;
export type ZitPassword = Distinct<string, 'Zit password'>;
export type StashID = Distinct<number, 'stash id'>;

export interface TimelineOptions extends LogEntryOptions {
    /** Output items affecting filePath only */
    readonly filePath?: RelativePath;
    /**
     * Maximum entries requested from Zit. Values are normalized to the
     * extension's bounded 1–512 history window.
     */
    readonly limit: number;
    /** Output the list of files changed by each commit */
    readonly verbose?: boolean;
}

interface LogEntryOptions {
    readonly checkin?: ZitCheckin;
}

export const enum ResourceStatus {
    MODIFIED,
    ADDED,
    DELETED,
    EXTRA,
    MISSING,
}

export interface FileStatus {
    readonly status: ResourceStatus;
    readonly klass: ZitClass;
    readonly path: string;
}

/** Parsed output from `zit status`, `zit extras`, and `zit diff --brief`. */
export interface ZitStatus {
    readonly statuses: FileStatus[];
    readonly branch: ZitBranch;
    readonly checkin?: ZitCheckin;
    readonly isMerge: boolean;
}

export interface ZitStatusResults {
    readonly status: ExecResult;
    readonly extras: ExecResult;
    readonly diff: ExecResult;
}

export interface BranchDetails {
    readonly name: ZitBranch;
    readonly isCurrent: boolean;
    readonly isClosed: boolean;
}

export interface SyncCredentials {
    readonly username: ZitUsername;
    readonly password: ZitPassword;
}

export interface StashItem {
    readonly stashId: StashID;
    readonly hash: string;
    readonly fileCount: number;
    readonly date?: Date;
    readonly comment: ZitCommitMessage;
}

export interface Revision {
    readonly hash: ZitHash;
}

export interface Commit extends Revision {
    readonly branch: ZitBranch;
    readonly message: ZitCommitMessage;
    readonly author: ZitUsername;
    readonly date: Date;
}

export interface CommitDetails extends Commit {
    files: FileStatus[];
}

export type Annotation = [ZitHash, string, ZitUsername];

interface ArtifactFile {
    readonly path: RelativePath;
    readonly hash?: string;
}

interface ArtifactDetails {
    readonly comment?: ZitCommitMessage;
    readonly date?: string;
    readonly user?: ZitUsername;
    readonly parents: ZitHash[];
    readonly files: ArtifactFile[];
}

interface ResolvedZitInfo {
    readonly hash: ZitHash;
    readonly fields: Readonly<Record<string, string>>;
}

interface CommitSummary {
    readonly checkin: ZitCheckin;
    readonly branch?: ZitBranch;
    readonly message?: ZitCommitMessage;
    readonly date?: string;
}

export const MAX_HISTORY_ENTRIES = 512;

const classes = {
    EDITED: ResourceStatus.MODIFIED,
    ADDED: ResourceStatus.ADDED,
    DELETED: ResourceStatus.DELETED,
    MISSING: ResourceStatus.MISSING,
    EXTRA: ResourceStatus.EXTRA,
} as const;
export type ZitClass = keyof typeof classes;

function toStatus(klass: ZitClass, value: string): FileStatus {
    return { klass, status: classes[klass], path: value as RelativePath };
}

export class OpenedRepository {
    private constructor(
        private readonly executable: ZitExecutable,
        public readonly root: ZitRoot
    ) {}

    static async tryOpen(
        executable: ZitExecutable,
        anyPath: string
    ): Promise<OpenedRepository | undefined> {
        const root = await executable.findRoot(anyPath);
        return root ? new OpenedRepository(executable, root) : undefined;
    }

    static init(
        executable: ZitExecutable,
        directory: ZitRoot
    ): Promise<ExecResult> {
        const cwd = path.dirname(directory) as ZitCWD;
        return executable.exec(cwd, ['init', directory]);
    }

    static clone(
        executable: ZitExecutable,
        uri: ZitURI,
        directory: ZitRoot,
        signal?: AbortSignal
    ): Promise<ExecResult> {
        const cwd = path.dirname(directory) as ZitCWD;
        const args: ZitArgs = ['clone', uri.toString(), directory];
        return signal
            ? executable.exec(cwd, args, undefined, { signal })
            : executable.exec(cwd, args);
    }

    static async isMaterialized(
        executable: ZitExecutable,
        directory: ZitRoot
    ): Promise<boolean> {
        try {
            const [store, checkout] = await Promise.all([
                fs.stat(path.join(directory, '.zit')),
                fs.stat(path.join(directory, '.zit-checkout')),
            ]);
            if (
                !(store.isDirectory() || store.isFile()) ||
                !checkout.isFile()
            ) {
                return false;
            }

            const status = await executable.exec(
                directory as ZitCWD,
                ['status'],
                undefined,
                { logErrors: false }
            );
            return (
                status.exitCode === 0 &&
                /^On branch .+ \(check-in [0-9a-f]+\)$/m.test(status.stdout)
            );
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'ENOTDIR') {
                return false;
            }
            throw error;
        }
    }

    static open(
        executable: ZitExecutable,
        directory: ZitRoot,
        checkin?: ZitCheckin
    ): Promise<ExecResult> {
        return executable.exec(directory as ZitCWD, [
            'open',
            ...(checkin ? [checkin] : []),
        ]);
    }

    async exec(
        args: ZitArgs,
        reason?: Reason,
        options: Omit<ZitSpawnOptions, 'cwd'> = {}
    ): Promise<ExecResult> {
        return this.executable.exec(this.root, args, reason, options);
    }

    async add(paths?: RelativePath[]): Promise<void> {
        await this.exec(['add', '--', ...(paths || [])]);
    }

    async ls(): Promise<string[]> {
        const result = await this.exec(['ls']);
        if (result.exitCode) {
            throw new Error(result.stderr.trim() || 'zit ls failed');
        }
        return result.stdout
            .split(/\r?\n/)
            .filter(Boolean)
            .map(line => {
                const match = /^[0-9a-f]{64} (.+)$/i.exec(line);
                if (!match) {
                    throw new Error(`Unexpected zit ls output: ${line}`);
                }
                return this.decodeArtifactField(match[1]);
            });
    }

    async cat(
        relativePath: RelativePath,
        checkin: ZitCheckin
    ): Promise<Buffer | undefined> {
        return this.executable.cat(this.root, ['cat', relativePath, checkin]);
    }

    async update(checkin: ZitCheckin, reason?: Reason): Promise<ExecResult> {
        return this.exec(['update', checkin], reason);
    }

    async commit(
        message: ZitCommitMessage,
        user: ZitUsername,
        newBranch: NewBranchOptions | undefined,
        closeBranch: boolean = false
    ): Promise<ExecResult> {
        const configuredArgs = typedConfig.commitArgs;
        const author = configuredArgs.includes('--user')
            ? undefined
            : user || typedConfig.defaultUsername;
        const commitArgs: string[] = [
            'commit',
            ...configuredArgs,
            ...(author ? ['--user', author] : []),
            ...(newBranch ? ['--branch', newBranch.branch] : []),
            ...(closeBranch ? ['--close'] : []),
            '-m',
            message,
        ];
        return this.exec(commitArgs);
    }

    async getCurrentBranch(): Promise<ZitBranch | undefined> {
        return (await this.getBranches({ includeClosed: true })).find(
            branch => branch.isCurrent
        )?.name;
    }

    async addTag(checkin: ZitCheckin, tag: ZitTag): Promise<void> {
        await this.exec(['tag', 'add', tag, checkin]);
    }

    async updateCommitMessage(
        checkin: ZitCheckin,
        commitMessage: ZitCommitMessage
    ): Promise<void> {
        await this.exec(['amend', checkin, '--comment', commitMessage]);
    }

    async annotate(
        documentPath: DocumentFsPath,
        checkin?: ZitCheckin
    ): Promise<Annotation[]> {
        const relativePath = (
            path.isAbsolute(documentPath)
                ? path.relative(this.root, documentPath)
                : documentPath
        ).replace(/\\/g, '/') as RelativePath;
        const result = await this.exec([
            'annotate',
            relativePath,
            ...(checkin ? [checkin] : []),
            '--full',
        ]);
        if (result.exitCode) {
            return [];
        }

        const annotations: Annotation[] = [];
        for (const line of result.stdout.split('\n')) {
            const match = line.match(
                /^([0-9a-f]{10}|[0-9a-f]{40}|[0-9a-f]{64})\s+(\d{4}-\d{2}-\d{2})\s/
            );
            if (match) {
                annotations.push([
                    match[1] as ZitHash,
                    match[2],
                    '' as ZitUsername,
                ]);
            }
        }

        const authors = new Map<ZitHash, ZitUsername>();
        for (const [checkin] of annotations) {
            if (!authors.has(checkin)) {
                const artifact = await this.readArtifact(checkin);
                authors.set(checkin, artifact.user ?? ('' as ZitUsername));
            }
        }
        return annotations.map(([checkin, date]) => [
            checkin,
            date,
            authors.get(checkin)!,
        ]);
    }

    async revert(paths: RelativePath[]): Promise<void> {
        await this.exec(['revert', '--', ...paths]);
    }

    async forget(paths: RelativePath[]): Promise<void> {
        await this.exec(['rm', '--', ...paths]);
    }

    async rename(
        oldPath: AnyPath,
        newPath: RelativePath | UserPath
    ): Promise<void> {
        const oldRelativePath = (
            path.isAbsolute(oldPath)
                ? path.relative(this.root, oldPath)
                : oldPath
        ).replace(/\\/g, '/') as RelativePath;
        const newRelativePath = (
            path.isAbsolute(newPath)
                ? path.relative(this.root, newPath)
                : newPath
        ).replace(/\\/g, '/') as RelativePath;
        const oldAbsolutePath = path.join(this.root, oldRelativePath);
        const newAbsolutePath = path.join(this.root, newRelativePath);

        let oldStatus: Stats | undefined;
        let newStatus: Stats | undefined;
        try {
            oldStatus = await fs.lstat(oldAbsolutePath);
        } catch (error: unknown) {
            if (
                !error ||
                typeof error !== 'object' ||
                !('code' in error) ||
                error.code !== 'ENOENT'
            ) {
                throw error;
            }
        }
        try {
            newStatus = await fs.lstat(newAbsolutePath);
        } catch (error: unknown) {
            if (
                !error ||
                typeof error !== 'object' ||
                !('code' in error) ||
                error.code !== 'ENOENT'
            ) {
                throw error;
            }
        }

        if (
            oldStatus ||
            !newStatus ||
            newStatus.isDirectory() ||
            oldRelativePath === '..' ||
            oldRelativePath.startsWith('../') ||
            newRelativePath === '..' ||
            newRelativePath.startsWith('../')
        ) {
            const result = await this.exec([
                'mv',
                '--',
                oldRelativePath,
                newRelativePath,
            ]);
            if (result.exitCode !== 0) {
                throw new Error(result.stderr.trim() || 'zit mv failed');
            }
            return;
        }

        await fs.rename(newAbsolutePath, oldAbsolutePath);
        let result: ExecResult;
        try {
            result = await this.exec([
                'mv',
                '--',
                oldRelativePath,
                newRelativePath,
            ]);
        } catch (error: unknown) {
            await fs.rename(oldAbsolutePath, newAbsolutePath);
            throw error;
        }
        if (result.exitCode !== 0) {
            await fs.rename(oldAbsolutePath, newAbsolutePath);
            throw new Error(result.stderr.trim() || 'zit mv failed');
        }
    }

    async clean(dryRun: boolean): Promise<ExecResult> {
        return this.exec(['clean', dryRun ? '--dry-run' : '--force']);
    }

    async undoOrRedo(command: 'undo' | 'redo'): Promise<undefined | 'NoUndo'> {
        const result = await this.exec([command]);
        if (result.exitCode === 0) {
            return;
        }
        if (
            result.exitCode === 1 &&
            new RegExp(`^zit ${command}: nothing to ${command}$`, 'm').test(
                result.stderr
            )
        ) {
            return 'NoUndo';
        }
        throw new Error(result.stderr.trim() || `zit ${command} failed`);
    }

    async pull(
        url?: ZitURI,
        options?: Omit<ZitSpawnOptions, 'cwd'>
    ): Promise<void> {
        const args: ZitArgs = ['pull', ...(url ? [url.toString()] : [])];
        await (options ? this.exec(args, undefined, options) : this.exec(args));
    }

    async push(
        url?: ZitURI,
        credentials?: SyncCredentials,
        options?: Omit<ZitSpawnOptions, 'cwd'>
    ): Promise<void> {
        const args: ZitArgs = [
            'push',
            ...(url ? [url.toString()] : []),
            ...(credentials
                ? [
                      '--user',
                      credentials.username,
                      '--password',
                      credentials.password,
                  ]
                : []),
        ];
        await (options ? this.exec(args, undefined, options) : this.exec(args));
    }

    async sync(
        url?: ZitURI,
        credentials?: SyncCredentials,
        options?: Omit<ZitSpawnOptions, 'cwd'>
    ): Promise<ExecResult> {
        const args: ZitArgs = [
            'sync',
            ...(url ? [url.toString()] : []),
            ...(credentials
                ? [
                      '--user',
                      credentials.username,
                      '--password',
                      credentials.password,
                  ]
                : []),
        ];
        return options ? this.exec(args, undefined, options) : this.exec(args);
    }

    async getRemote(): Promise<ZitURI | undefined> {
        const result = await this.exec(['remote']);
        const value = result.stdout.trim();
        return value && value !== 'no remote set'
            ? (Uri.parse(value) as ZitURI)
            : undefined;
    }

    async setRemote(url?: ZitURI): Promise<ExecResult> {
        return this.exec(
            url ? ['remote', url.toString()] : ['remote', '--unset']
        );
    }

    async setAutoSync(enabled: boolean): Promise<void> {
        await this.exec(['settings', 'autosync', enabled ? 'on' : 'off']);
    }

    async merge(
        checkin: ZitCheckin,
        action: MergeAction,
        options?: Omit<ZitSpawnOptions, 'cwd'>
    ): Promise<ExecResult> {
        const extraArgs =
            action === MergeAction.Cherrypick
                ? (['--cherrypick'] as const)
                : ([] as const);
        const args: ZitArgs = ['merge', ...extraArgs, checkin];
        return options ? this.exec(args, undefined, options) : this.exec(args);
    }

    parseMergeConflictPaths(stderr: string): RelativePath[] {
        const conflicts = new Set<RelativePath>();
        for (const line of stderr.split(/\r?\n/)) {
            const match = /^zit merge: conflict in (.+)$/.exec(line);
            if (match) {
                conflicts.add(
                    path.normalize(match[1]).replace(/\\/g, '/') as RelativePath
                );
            }
        }
        return [...conflicts];
    }

    async stash(message: ZitCommitMessage): Promise<void> {
        await this.exec(['stash', 'save', '-m', message]);
    }

    async stashList(): Promise<StashItem[]> {
        const result = await this.exec(['stash', 'list']);
        const entries: StashItem[] = [];
        const pattern =
            /^(?<id>\d+):\s+\[(?<hash>[0-9a-f]+)\]\s+(?<files>\d+)\s+file\(s\)(?:\s+(?:-|—)\s+(?<message>.*\S))?\s*$/i;
        for (const line of result.stdout.split('\n')) {
            const groups = line.match(pattern)?.groups;
            if (!groups) {
                continue;
            }
            entries.push({
                stashId: Number.parseInt(groups.id, 10) as StashID,
                hash: groups.hash,
                fileCount: Number.parseInt(groups.files, 10),
                comment: (groups.message ?? '') as ZitCommitMessage,
            });
        }
        return entries;
    }

    async stashShow(stashId?: StashID): Promise<string> {
        const result = await this.exec([
            'stash',
            'show',
            ...(stashId === undefined ? [] : [`${stashId}`]),
        ]);
        return result.stdout;
    }

    async stashPop(stashId?: StashID): Promise<void> {
        await this.exec([
            'stash',
            'pop',
            ...(stashId === undefined ? [] : [`${stashId}`]),
        ]);
    }

    async stashApplyOrDrop(
        operation: 'apply' | 'drop',
        stashId: StashID
    ): Promise<void> {
        await this.exec(['stash', operation, `${stashId}`]);
    }

    /** Report the change status of files in the current checkout
     *  Status call is expected to be throttled by the caller
     */
    /** Report the current checkout state from Zit’s three status surfaces. */
    async getStatus(reason: Reason): Promise<ZitStatusResults> {
        const [status, extras, diff] = await Promise.all([
            this.exec(['status'], reason),
            this.exec(['extras'], reason),
            this.exec(['diff', '--brief'], reason),
        ]);
        return { status, extras, diff };
    }

    parseStatusString(status: StatusString, extras = '', diff = ''): ZitStatus {
        const statuses = new Map<string, FileStatus>();
        let branch: ZitBranch | undefined;
        let checkin: ZitCheckin | undefined;
        let isMerge = false;

        const normalizePath = (value: string): string => {
            const trimmed = value.trim();
            return trimmed ? path.normalize(trimmed).replace(/\\/g, '/') : '';
        };
        const addStatus = (klass: ZitClass, value: string): void => {
            const normalized = normalizePath(value);
            if (normalized && !statuses.has(normalized)) {
                statuses.set(normalized, toStatus(klass, normalized));
            }
        };

        for (const line of status.split(/\r?\n/)) {
            const header =
                /^On branch (.+) \(check-in ([0-9a-f]+)\)$/.exec(line) ??
                /^On branch (.+) \(no check-ins yet\)$/.exec(line);
            if (header) {
                branch = header[1] as ZitBranch;
                checkin = header[2] as ZitCheckin | undefined;
                continue;
            }
            const file = /^(added|edited|missing) (.+)$/.exec(line);
            if (file) {
                const klass = {
                    added: 'ADDED',
                    edited: 'EDITED',
                    missing: 'MISSING',
                }[file[1]] as ZitClass;
                addStatus(klass, file[2]);
                continue;
            }
            if (/^pending (?:merge|cherry-pick|backout) with /.test(line)) {
                isMerge = true;
            }
        }

        for (const line of diff.split(/\r?\n/)) {
            const match = /^([AMD]) (.+)$/.exec(line);
            if (!match) {
                continue;
            }
            const klass = { A: 'ADDED', M: 'EDITED', D: 'DELETED' }[
                match[1]
            ] as ZitClass;
            addStatus(klass, this.decodeArtifactField(match[2]));
        }

        for (const line of extras.split(/\r?\n/)) {
            const extraPath = normalizePath(line);
            if (extraPath && extraPath !== '.zit-stash') {
                addStatus('EXTRA', extraPath);
            }
        }

        if (!branch) {
            throw new Error('Unexpected zit status output: missing branch');
        }
        return {
            statuses: [...statuses.values()],
            branch,
            checkin,
            isMerge,
        };
    }

    private decodeArtifactField(value: string): string {
        return value.replace(
            /\\([snrt\\])/g,
            (_match: string, escaped: string) => {
                switch (escaped) {
                    case 's':
                        return ' ';
                    case 'n':
                        return '\n';
                    case 'r':
                        return '\r';
                    case 't':
                        return '\t';
                    default:
                        return '\\';
                }
            }
        );
    }

    private parseArtifact(raw: string): ArtifactDetails {
        let comment: ZitCommitMessage | undefined;
        let date: string | undefined;
        let user: ZitUsername | undefined;
        const parents: ZitHash[] = [];
        const files: ArtifactFile[] = [];

        for (const line of raw.split('\n')) {
            const card = line[0];
            const value = line.slice(2);
            switch (card) {
                case 'C':
                    comment = this.decodeArtifactField(
                        value
                    ) as ZitCommitMessage;
                    break;
                case 'D':
                    date = value;
                    break;
                case 'F': {
                    const [encodedPath, hash] = value.split(' ');
                    if (encodedPath) {
                        files.push({
                            path: this.decodeArtifactField(
                                encodedPath
                            ) as RelativePath,
                            hash,
                        });
                    }
                    break;
                }
                case 'P':
                    for (const hash of value.split(' ')) {
                        if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(hash)) {
                            parents.push(hash as ZitHash);
                        }
                    }
                    break;
                case 'U':
                    user = this.decodeArtifactField(value) as ZitUsername;
                    break;
            }
        }
        return { comment, date, user, parents, files };
    }

    private async resolveInfo(checkin: ZitCheckin): Promise<ResolvedZitInfo> {
        const result = await this.exec(['info', checkin]);
        const lines = result.stdout.trimEnd().split('\n');
        const hash = lines[0];
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(hash)) {
            throw new Error(`zit check-in '${checkin}' did not resolve`);
        }

        const fields: Record<string, string> = {};
        for (const line of lines.slice(1)) {
            const match = line.match(/^([a-z]+):\s*(.*)$/);
            if (match) {
                fields[match[1]] = match[2];
            }
        }
        return { hash: hash as ZitHash, fields };
    }

    private async readArtifact(checkin: ZitHash): Promise<ArtifactDetails> {
        const result = await this.exec(['artifact', checkin, '--raw']);
        if (result.exitCode) {
            throw new Error(`zit artifact '${checkin}' could not be read`);
        }
        return this.parseArtifact(result.stdout);
    }

    private async changedFiles(
        checkin: ZitHash,
        artifact: ArtifactDetails
    ): Promise<FileStatus[]> {
        const parent = artifact.parents[0];
        if (!parent) {
            return artifact.files
                .filter(file => file.hash !== undefined)
                .map(file => ({
                    klass: 'ADDED',
                    status: ResourceStatus.ADDED,
                    path: file.path,
                }));
        }

        const result = await this.exec([
            'diff',
            '--brief',
            '--from',
            parent,
            '--to',
            checkin,
        ]);
        const changed: FileStatus[] = [];
        for (const line of result.stdout.split('\n')) {
            const match = line.match(/^([AMD])(?:\t| +)(.+)$/);
            if (!match) {
                continue;
            }
            const klass: ZitClass =
                match[1] === 'A'
                    ? 'ADDED'
                    : match[1] === 'D'
                      ? 'DELETED'
                      : 'EDITED';
            const normalizedPath = path
                .normalize(this.decodeArtifactField(match[2]))
                .replace(/\\/g, '/') as RelativePath;
            changed.push({
                klass,
                status: classes[klass],
                path: normalizedPath,
            });
        }
        return changed;
    }

    private async enrichCommit(
        summary: CommitSummary,
        includeFiles: boolean
    ): Promise<Commit | CommitDetails> {
        const info = await this.resolveInfo(summary.checkin);
        const artifact = await this.readArtifact(info.hash);
        const date = summary.date ?? artifact.date;
        if (!date) {
            throw new Error(`zit check-in '${info.hash}' has no date`);
        }
        const commit: Commit = {
            hash: info.hash,
            branch:
                summary.branch ??
                ((info.fields.branch || 'trunk') as ZitBranch),
            message:
                summary.message ?? artifact.comment ?? ('' as ZitCommitMessage),
            author:
                (info.fields.user as ZitUsername | undefined) ??
                artifact.user ??
                ('' as ZitUsername),
            date: new Date(date.endsWith('Z') ? date : `${date}Z`),
        };
        if (!includeFiles) {
            return commit;
        }
        return {
            ...commit,
            files: await this.changedFiles(info.hash, artifact),
        };
    }

    async getLogEntries({
        checkin,
        filePath,
        limit,
        verbose,
    }: TimelineOptions): Promise<Commit[] | CommitDetails[]> {
        const boundedLimit = Math.min(
            Math.max(Math.abs(limit) || MAX_HISTORY_ENTRIES, 1),
            MAX_HISTORY_ENTRIES
        );
        const useLog = checkin !== undefined || filePath !== undefined;
        if (useLog && checkin === undefined) {
            throw new Error('Zit file history requires a check-in');
        }
        const args: ZitArgs = useLog
            ? [
                  'log',
                  '-n',
                  `${boundedLimit}`,
                  checkin!,
                  ...(filePath ? [filePath] : []),
              ]
            : ['timeline', '-n', `${boundedLimit}`];
        const result = await this.exec(args);
        const summaries: CommitSummary[] = [];

        for (const line of result.stdout.split('\n')) {
            if (useLog) {
                const match = line.match(
                    /^checkin ([0-9a-f]{40}|[0-9a-f]{64})$/
                );
                if (match) {
                    summaries.push({ checkin: match[1] as ZitHash });
                }
                continue;
            }

            const match = line.match(
                /^(?:M | {2})([0-9a-f]{12}) {2}(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}) {2}(.+?) {2}(.*)$/
            );
            if (match) {
                summaries.push({
                    checkin: match[1] as ZitHash,
                    date: match[2],
                    branch: match[3] as ZitBranch,
                    message: match[4] as ZitCommitMessage,
                });
            }
        }

        const commits: (Commit | CommitDetails)[] = [];
        for (const summary of summaries) {
            commits.push(await this.enrichCommit(summary, verbose === true));
        }
        return commits as CommitDetails[];
    }

    async getInfo(
        checkin: ZitCheckin,
        field: 'parent'
    ): Promise<ZitHash | undefined>;
    async getInfo(checkin: ZitCheckin, field: 'hash'): Promise<ZitHash>;
    async getInfo(
        checkin: ZitCheckin,
        field: 'parent' | 'hash'
    ): Promise<ZitHash | undefined> {
        const info = await this.resolveInfo(checkin);
        if (field === 'hash') {
            return info.hash;
        }
        return (await this.readArtifact(info.hash)).parents[0];
    }

    async gitExport(
        destination: UserPath,
        options?: Omit<ZitSpawnOptions, 'cwd'>
    ): Promise<void> {
        const args: ZitArgs = ['export-git', this.root, destination];
        await (options ? this.exec(args, undefined, options) : this.exec(args));
    }

    async info(checkin: ZitCheckin): Promise<{ [key: string]: string }> {
        const info = await this.resolveInfo(checkin);
        const artifact = await this.readArtifact(info.hash);
        const details: { [key: string]: string } = {
            checkin: info.hash,
            ...info.fields,
        };
        const comment = info.fields.comment ?? artifact.comment;
        const user = info.fields.user ?? artifact.user;
        const date = info.fields.date ?? artifact.date;
        if (comment !== undefined) {
            details.comment = comment;
        }
        if (user !== undefined) {
            details.user = user;
        }
        if (date !== undefined) {
            details.date = date;
        }
        if (artifact.parents[0]) {
            details.parent = artifact.parents[0];
        }
        return details;
    }

    async getTags(checkin?: ZitCheckin): Promise<ZitTag[]> {
        const result = await this.exec([
            'tag',
            'list',
            ...(checkin ? [checkin] : []),
        ]);
        const tags = result.stdout
            .split('\n')
            .map(tag => tag.trim())
            .filter(Boolean);
        if (checkin && /^branch\s+\S/.test(tags[0] ?? '')) {
            tags.shift();
        }
        return tags as ZitTag[];
    }

    async getBranches(
        opts: { includeClosed?: boolean } = {}
    ): Promise<BranchDetails[]> {
        const result = await this.exec(['branch']);
        const branches: BranchDetails[] = [];
        for (const line of result.stdout.split('\n')) {
            const match = line.match(/^(?<marker>\*| ) (?<branch>.+?)\s*$/);
            const groups = match?.groups;
            if (!groups) {
                continue;
            }
            const isClosed = /\s+\(closed\)$/.test(groups.branch);
            if (isClosed && !opts.includeClosed) {
                continue;
            }
            branches.push({
                name: groups.branch.replace(/\s+\(closed\)$/, '') as ZitBranch,
                isCurrent: groups.marker === '*',
                isClosed,
            });
        }
        return branches;
    }
}
