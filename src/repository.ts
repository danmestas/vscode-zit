import {
    CancellationError,
    commands,
    Command,
    Disposable,
    Event,
    EventEmitter,
    ProgressLocation,
    RelativePattern,
    scm,
    SourceControl,
    SourceControlResourceDecorations,
    SourceControlResourceState,
    TextDocumentShowOptions,
    Uri,
    window,
    workspace,
} from 'vscode';
import {
    AnyPath,
    BranchDetails,
    Commit,
    CommitDetails,
    ZitBranch,
    ZitCheckin,
    ZitClass,
    ZitCommitMessage,
    ZitHash,
    ZitRoot,
    ZitStatus,
    ZitTag,
    MergeAction,
    OpenedRepository,
    Annotation,
    RelativePath,
    ResourceStatus,
    StashID,
    StashItem,
    StatusString,
    SyncCredentials,
    TimelineOptions,
    UserPath,
    ZitURI,
} from './openedRepository';
import {
    anyEvent,
    filterEvent,
    eventToPromise,
    dispose,
    IDisposable,
    delay,
} from './util';
import { memoize, throttle, debounce } from './decorators';
import { StatusBarCommands } from './statusBar';
import typedConfig, { AutoSyncIntervalMs } from './config';

import * as path from 'path';
import {
    ZitResourceGroup,
    createEmptyStatusGroups,
    IStatusGroups,
    groupStatuses,
} from './resourceGroups';
import * as interaction from './interaction';
import type { InteractionAPI, NewBranchOptions } from './interaction';
import { ZitUriParams, toZitEmptyUri, toZitUri } from './uri';

import { localize } from './main';
import type {
    DocumentFsPath,
    ExecFailure,
    ExecResult,
    Reason,
} from './zitExecutable';
import { ThrottlingQueue, queue } from './throttlingQueue';
const iconsRootPath = path.join(path.dirname(__dirname), 'resources', 'icons');

type AvailableIcons =
    | 'status-added'
    | 'status-deleted'
    | 'status-missing'
    | 'status-modified'
    | 'status-untracked';

function getIconUri(iconName: AvailableIcons, theme: 'dark' | 'light'): Uri {
    return Uri.file(path.join(iconsRootPath, theme, `${iconName}.svg`));
}

export interface LogEntriesOptions extends Omit<
    TimelineOptions,
    'filePath' | 'limit'
> {
    readonly fileUri?: Uri;
    readonly limit?: TimelineOptions['limit'];
}

export const enum RepositoryState {
    Idle,
    Disposed,
}

type ThemeName = 'light' | 'dark';

export class ZitResource implements SourceControlResourceState {
    @memoize
    get command(): Command {
        return {
            command: 'zit.openResource',
            title: localize('open', 'Open'),
            arguments: [this],
        };
    }

    get isDirtyStatus(): boolean {
        switch (this.status) {
            case ResourceStatus.EXTRA:
                return false;

            case ResourceStatus.ADDED:
            case ResourceStatus.DELETED:
            case ResourceStatus.MISSING:
            case ResourceStatus.MODIFIED:
            default:
                return true;
        }
    }

    get original(): Uri {
        return this._resourceUri;
    }
    @memoize
    get resourceUri(): Uri {
        return this._resourceUri;
    }

    private static Icons: {
        [key in ThemeName]: { [key in ResourceStatus]: Uri };
    } = {
        light: {
            [ResourceStatus.MODIFIED]: getIconUri('status-modified', 'light'),
            [ResourceStatus.MISSING]: getIconUri('status-missing', 'light'),
            [ResourceStatus.ADDED]: getIconUri('status-added', 'light'),
            [ResourceStatus.DELETED]: getIconUri('status-deleted', 'light'),
            [ResourceStatus.EXTRA]: getIconUri('status-untracked', 'light'),
        },
        dark: {
            [ResourceStatus.MODIFIED]: getIconUri('status-modified', 'dark'),
            [ResourceStatus.MISSING]: getIconUri('status-missing', 'dark'),
            [ResourceStatus.ADDED]: getIconUri('status-added', 'dark'),
            [ResourceStatus.DELETED]: getIconUri('status-deleted', 'dark'),
            [ResourceStatus.EXTRA]: getIconUri('status-untracked', 'dark'),
        },
    };

    private getIconPath(theme: ThemeName): Uri {
        return ZitResource.Icons[theme][this.status];
    }

    get contextValue(): string | undefined {
        if (this.status == ResourceStatus.MISSING) {
            return 'MISSING';
        }
        return;
    }

    get decorations(): SourceControlResourceDecorations {
        const light = { iconPath: this.getIconPath('light') };
        const dark = { iconPath: this.getIconPath('dark') };

        return {
            strikeThrough: this.status == ResourceStatus.DELETED,
            light,
            dark,
            tooltip: this._tooltip,
        };
    }

    constructor(
        public resourceGroup: ZitResourceGroup,
        private readonly _resourceUri: Uri,
        public readonly status: ResourceStatus,
        private readonly _tooltip: ZitClass
    ) {}
}

type SideEffects = {
    /** Files or current branch could change. */
    status?: true;
    /** Tooltip text shown while an operation runs. */
    syncText?: string;
};

const UpdateStatus: SideEffects = { status: true };
const UpdateAll: SideEffects = { status: true };

export interface CommitOptions {
    readonly useBranch?: boolean;
    readonly closeBranch?: boolean;
}

export class Repository implements IDisposable, InteractionAPI {
    private _onDidChangeRepository = new EventEmitter<Uri>();
    readonly onDidChangeRepository: Event<Uri> =
        this._onDidChangeRepository.event;

    private _onDidChangeState = new EventEmitter<RepositoryState>();
    readonly onDidChangeState: Event<RepositoryState> =
        this._onDidChangeState.event;

    /**
     * repository was:
     * - disposed
     */
    private _onDidChangeResources = new EventEmitter<void>();
    private readonly onDidChangeResources: Event<void> =
        this._onDidChangeResources.event;

    private _onDidChangeOriginalResource = new EventEmitter<Uri>();
    readonly onDidChangeOriginalResource: Event<Uri> =
        this._onDidChangeOriginalResource.event;

    private _onRunOperation = new EventEmitter<void>();
    private readonly onRunOperation: Event<void> = this._onRunOperation.event;

    private _onDidRunOperation = new EventEmitter<void>();
    readonly onDidRunOperation: Event<void> = this._onDidRunOperation.event;

    private _sourceControl: SourceControl;
    private autoSyncTimer: ReturnType<typeof setTimeout> | undefined;

    private _currentBranch: ZitBranch | undefined;
    private _operations = new Map<symbol, SideEffects>();
    private _state = RepositoryState.Idle;
    private readonly disposables: Disposable[] = [];
    private readonly statusBar: StatusBarCommands;
    private _zitStatus: ZitStatus | undefined;
    private _groups: IStatusGroups;

    get sourceControl(): Readonly<SourceControl> {
        return this._sourceControl;
    }

    /**
     * An operation started or stopped running
     */
    @memoize
    private get onDidChangeOperations(): Event<void> {
        return anyEvent(
            this.onRunOperation as Event<any>,
            this.onDidRunOperation as Event<any>
        );
    }

    get addedGroup(): ZitResourceGroup {
        return this._groups.added;
    }
    get workingGroup(): ZitResourceGroup {
        return this._groups.working;
    }
    get untrackedGroup(): ZitResourceGroup {
        return this._groups.untracked;
    }

    get currentBranch(): ZitBranch | undefined {
        return this._currentBranch;
    }

    get zitStatus(): ZitStatus | undefined {
        return this._zitStatus;
    }

    get operations(): ReadonlyMap<symbol, SideEffects> {
        return this._operations;
    }

    toUri(rawPath: RelativePath): Uri {
        return Uri.file(path.join(this.repository.root, rawPath));
    }

    get state(): RepositoryState {
        return this._state;
    }
    set state(state: RepositoryState) {
        this._state = state;
        this._onDidChangeState.fire(state);

        this._currentBranch = undefined;
        this._groups.added.updateResources([]);
        this._groups.working.updateResources([]);
        this._groups.untracked.updateResources([]);
        this._onDidChangeResources.fire();
    }

    get root(): ZitRoot {
        return this.repository.root;
    }

    public queue: ThrottlingQueue = new ThrottlingQueue();
    readonly initialization: Promise<void>;

    constructor(private readonly repository: OpenedRepository) {
        const repoRootWatcher = workspace.createFileSystemWatcher(
            new RelativePattern(repository.root, '**')
        );
        this.disposables.push(repoRootWatcher);

        const onRepositoryChange = anyEvent(
            repoRootWatcher.onDidChange,
            repoRootWatcher.onDidCreate,
            repoRootWatcher.onDidDelete
        );
        onRepositoryChange(this.onFSChange, this, this.disposables);

        const onCheckoutDatabaseChange = filterEvent(onRepositoryChange, uri =>
            /\/\.zit$/.test(uri.path)
        );
        onCheckoutDatabaseChange(
            this._onDidChangeRepository.fire,
            this._onDidChangeRepository,
            this.disposables
        );

        this._sourceControl = scm.createSourceControl(
            'zit',
            'Zit',
            Uri.file(repository.root)
        );
        this.disposables.push(this._sourceControl);

        this._sourceControl.acceptInputCommand = {
            command: 'zit.commitWithInput',
            title: localize('commit', 'Commit'),
            arguments: [this satisfies Repository],
        };
        this._sourceControl.quickDiffProvider = this;

        const groups = createEmptyStatusGroups(this._sourceControl);

        this._groups = groups;
        this.disposables.push(
            ...Object.values(groups).map(
                (group: ZitResourceGroup) => group.disposable
            )
        );

        this.statusBar = new StatusBarCommands(this, this.sourceControl);
        this.onDidChangeOperations(
            this.statusBar.update,
            this.statusBar,
            this.disposables
        );
        this.initialization = this.updateModelState(
            UpdateAll,
            'opening repository' as Reason
        ).finally(() =>
            this.updateAutoSyncInterval(typedConfig.autoSyncIntervalMs)
        );
    }

    provideOriginalResource(uri: Uri): Uri | undefined {
        if (uri.scheme !== 'file') {
            return;
        }
        return toZitUri(uri);
    }

    @throttle
    async refresh(): Promise<void> {
        await this.runWithProgress(UpdateAll, () => Promise.resolve());
    }

    private onFSChange(_uri: Uri): void {
        if (!typedConfig.autoRefresh) {
            return;
        }

        if (this.operations.size !== 0) {
            return;
        }

        this.eventuallyUpdateWhenIdleAndWait();
    }

    @debounce(1000)
    private eventuallyUpdateWhenIdleAndWait(): void {
        this.updateWhenIdleAndWait();
    }

    @throttle
    private async updateWhenIdleAndWait(): Promise<void> {
        await this.whenIdleAndFocused();
        await this.updateModelState(UpdateAll, 'idle update' as Reason);
        await delay(5000);
    }

    private updateInputBoxPlaceholder(branch: ZitBranch): void {
        this._sourceControl.inputBox.placeholder = localize(
            'Message ({0} to commit on "{1}")',
            'Message ({0} to commit on "{1}")',
            '{0}',
            branch
        );
    }

    /**
     *  wait till all operations are complete and the window is in focus
     */
    async whenIdleAndFocused(): Promise<void> {
        while (true) {
            if (this.operations.size !== 0) {
                await eventToPromise(this.onDidRunOperation);
                continue;
            }

            if (!window.state.focused) {
                const onDidFocusWindow = filterEvent(
                    window.onDidChangeWindowState,
                    e => e.focused
                );
                await eventToPromise(onDidFocusWindow);
                continue;
            }

            return;
        }
    }

    @throttle
    async add(...uris: Uri[]): Promise<void> {
        let resources: ZitResource[];
        if (uris.length === 0) {
            resources = this._groups.untracked.resourceStates;
        } else {
            resources = this.mapResources(uris);
        }
        const relativePaths = resources.map(r =>
            this.mapResourceToRepoRelativePath(r)
        );
        await this.runWithProgress(UpdateStatus, () =>
            this.repository.add(relativePaths)
        );
    }
    async ls(): Promise<Uri[]> {
        const lsResult = await this.repository.ls();
        const rootUri = Uri.file(this.root);
        return lsResult.map(relativePath =>
            Uri.joinPath(rootUri, relativePath)
        );
    }

    @throttle
    async forget(...uris: Uri[]): Promise<void> {
        const resources =
            uris.length === 0
                ? this._groups.added.resourceStates
                : this.mapResources(uris);
        const relativePaths = resources.map(resource =>
            this.mapResourceToRepoRelativePath(resource)
        );
        if (relativePaths.length) {
            await this.runWithProgress(UpdateStatus, () =>
                this.repository.forget(relativePaths)
            );
        }
    }

    async rename(
        oldPath: AnyPath,
        newPath: RelativePath | UserPath
    ): Promise<void> {
        await this.runWithProgress(UpdateStatus, () =>
            this.repository.rename(oldPath, newPath)
        );
    }

    mapResources(resourceUris: Uri[]): ZitResource[] {
        const resources: ZitResource[] = [];
        const { added, working, untracked } = this._groups;
        const groups = [added, working, untracked];
        for (const uri of resourceUris) {
            for (const group of groups) {
                const resource = group.getResource(uri);
                if (resource) {
                    resources.push(resource);
                    break;
                }
            }
        }
        return resources;
    }

    // resource --> repo-relative path
    private mapResourceToRepoRelativePath(resource: ZitResource): RelativePath {
        const relativePath = this.mapFileUriToRepoRelativePath(
            resource.resourceUri
        );
        return relativePath;
    }

    // file uri --> repo-relative path
    public mapFileUriToRepoRelativePath(fileUri: Uri): RelativePath {
        const relativePath = path
            .relative(this.repository.root, fileUri.fsPath)
            .replace(/\\/g, '/');
        return relativePath as RelativePath;
    }

    // resource --> workspace-relative path
    public mapResourceToWorkspaceRelativePath(
        resource: ZitResource
    ): RelativePath {
        const relativePath = this.mapFileUriToWorkspaceRelativePath(
            resource.resourceUri
        );
        return relativePath;
    }

    // file uri --> workspace-relative path
    public mapFileUriToWorkspaceRelativePath(fileUri: Uri): RelativePath {
        const relativePath = path
            .relative(this.repository.root, fileUri.fsPath)
            .replace(/[/\\]/g, path.sep);
        return relativePath as RelativePath;
    }

    @throttle
    async commit(
        message: ZitCommitMessage,
        newBranch: NewBranchOptions | undefined,
        closeBranch: boolean = false
    ): Promise<ExecResult> {
        return this.runWithProgress(UpdateStatus, () =>
            this.repository.commit(
                message,
                typedConfig.username,
                newBranch,
                closeBranch
            )
        );
    }

    @throttle
    async revert(...uris: Uri[]): Promise<void> {
        const resources = this.mapResources(uris);
        await this.runWithProgress(UpdateStatus, async () => {
            const added: RelativePath[] = [];
            const working: RelativePath[] = [];
            for (const resource of resources) {
                if (resource.status === ResourceStatus.EXTRA) {
                    continue;
                }
                const relativePath =
                    this.mapResourceToRepoRelativePath(resource);
                if (resource.status === ResourceStatus.ADDED) {
                    added.push(relativePath);
                } else {
                    working.push(relativePath);
                }
            }
            if (added.length) {
                await this.repository.forget(added);
            }
            if (working.length) {
                await this.repository.revert(working);
            }
        });
    }

    @throttle
    async clean(dryRun: boolean): Promise<ExecResult> {
        return this.runWithProgress(dryRun ? {} : UpdateStatus, () =>
            this.repository.clean(dryRun)
        );
    }

    async update(checkin: ZitCheckin): Promise<ExecResult> {
        return this.runWithProgress(
            { syncText: 'Updating...', ...UpdateAll },
            () => this.repository.update(checkin)
        );
    }

    @throttle
    async undoOrRedo(command: 'undo' | 'redo'): Promise<undefined | 'NoUndo'> {
        return this.runWithProgress(UpdateAll, () =>
            this.repository.undoOrRedo(command)
        );
    }

    private _isInAnyGroup(
        check: (group: ZitResourceGroup) => boolean
    ): boolean {
        return [this.addedGroup, this.workingGroup].some(check);
    }

    public isInAnyGroup(uri: Uri): boolean {
        return this._isInAnyGroup((group: ZitResourceGroup) =>
            group.includesUri(uri)
        );
    }

    public isDirInAnyGroup(uri: Uri): boolean {
        const dir = uri.toString() + path.sep;
        return this._isInAnyGroup((group: ZitResourceGroup) =>
            group.includesDir(dir)
        );
    }
    async pull(url?: ZitURI): Promise<void> {
        return this.runWithProgress(
            {},
            async signal => {
                await this.queue.enqueue(
                    () => this.repository.pull(url, { signal }),
                    'p'
                );
            },
            () => true,
            'Pulling from Zit remote…'
        );
    }

    async push(url?: ZitURI, credentials?: SyncCredentials): Promise<void> {
        return this.runWithProgress(
            {},
            async signal => {
                await this.queue.enqueue(
                    () => this.repository.push(url, credentials, { signal }),
                    'P'
                );
            },
            () => true,
            'Pushing to Zit remote…'
        );
    }

    @throttle
    async merge(
        checkin: ZitCheckin,
        mergeAction: MergeAction
    ): Promise<ExecResult> {
        const result = await this.runWithProgress(
            UpdateStatus,
            signal => this.repository.merge(checkin, mergeAction, { signal }),
            () => true,
            'Merging Zit check-in…'
        );
        const conflicts = this.repository.parseMergeConflictPaths(
            result.stderr
        );
        if (conflicts.length) {
            await interaction.warnMergeConflicts(conflicts);
            for (const conflict of conflicts) {
                const document = await workspace.openTextDocument(
                    this.toUri(conflict)
                );
                await window.showTextDocument(document, { preview: false });
            }
        }
        return result;
    }
    addTag(checkin: ZitCheckin, tag: ZitTag): Promise<void> {
        return this.repository.addTag(checkin, tag);
    }

    async updateCommitMessage(
        checkin: ZitCheckin,
        commitMessage: ZitCommitMessage
    ): Promise<void> {
        return this.repository.updateCommitMessage(checkin, commitMessage);
    }

    async annotate(path: DocumentFsPath): Promise<Annotation[]> {
        return this.repository.annotate(path);
    }

    // Used for annotation tooltips.
    async info(checkin: ZitCheckin): Promise<{ [key: string]: string }> {
        return this.repository.info(this.resolveHistoryCheckin(checkin));
    }

    async gitExport(destination: UserPath, signal: AbortSignal): Promise<void> {
        return this.repository.gitExport(destination, { signal });
    }

    private resolveHistoryCheckin(checkin: ZitCheckin): ZitCheckin {
        if (checkin !== 'current') {
            return checkin;
        }
        const current = this._zitStatus?.checkin;
        if (!current) {
            throw new Error('Zit checkout has no current check-in');
        }
        return current;
    }

    async cat(params: ZitUriParams): Promise<Buffer | undefined> {
        if (params.empty) {
            return Buffer.alloc(0);
        }
        const checkin = params.checkin;
        if (!checkin) {
            return undefined;
        }

        return this.runWithProgress({}, async () => {
            const relativePath = path
                .relative(this.repository.root, params.path)
                .replace(/\\/g, '/') as RelativePath;
            return this.repository.cat(
                relativePath,
                this.resolveHistoryCheckin(checkin)
            );
        });
    }

    async stash(message: ZitCommitMessage): Promise<void> {
        return this.runWithProgress(UpdateStatus, async () =>
            this.repository.stash(message)
        );
    }

    async stashList(): Promise<StashItem[]> {
        return this.runWithProgress({}, async () =>
            this.repository.stashList()
        );
    }

    async stashShow(stashId?: StashID): Promise<string> {
        return this.runWithProgress({}, async () =>
            this.repository.stashShow(stashId)
        );
    }

    async stashPop(stashId?: StashID): Promise<void> {
        return this.runWithProgress(UpdateStatus, async () =>
            this.repository.stashPop(stashId)
        );
    }

    async stashApplyOrDrop(
        operation: 'apply' | 'drop',
        stashId: StashID
    ): Promise<void> {
        return this.runWithProgress(
            operation === 'apply' ? UpdateStatus : {},
            async () => this.repository.stashApplyOrDrop(operation, stashId)
        );
    }
    private async runWithProgress<T>(
        sideEffects: SideEffects,
        runOperation: (signal?: AbortSignal) => Promise<T>,
        runSideEffects: (arg0: T) => boolean = () => true,
        cancellableTitle?: string
    ): Promise<T> {
        if (this.state !== RepositoryState.Idle) {
            throw new Error('Repository not initialized');
        }

        const run = async (signal?: AbortSignal): Promise<T> => {
            const key = Symbol();
            this._operations.set(key, sideEffects);
            this._onRunOperation.fire();

            try {
                const operationResult = await runOperation(signal);
                if (runSideEffects(operationResult)) {
                    await this.updateModelState(
                        sideEffects,
                        'Triggered by previous operation' as Reason
                    );
                }
                return operationResult;
            } finally {
                this._operations.delete(key);
                this._onDidRunOperation.fire();
            }
        };

        if (!cancellableTitle) {
            return window.withProgress(
                { location: ProgressLocation.SourceControl },
                () => run()
            );
        }

        return window.withProgress(
            {
                title: cancellableTitle,
                location: ProgressLocation.Notification,
                cancellable: true,
            },
            async (_progress, token) => {
                const controller = new AbortController();
                const cancellation = token.onCancellationRequested(() =>
                    controller.abort()
                );
                if (token.isCancellationRequested) {
                    controller.abort();
                }
                try {
                    const result = await run(controller.signal);
                    if (controller.signal.aborted) {
                        throw new CancellationError();
                    }
                    return result;
                } catch (error) {
                    if (controller.signal.aborted) {
                        throw new CancellationError();
                    }
                    throw error;
                } finally {
                    cancellation.dispose();
                }
            }
        );
    }

    @throttle
    public async getRemote(): Promise<ZitURI | undefined> {
        return this.repository.getRemote();
    }

    public setRemote(url?: ZitURI): Promise<void> {
        return this.repository.setRemote(url);
    }

    @throttle
    public async getBranchesAndTags(): Promise<[BranchDetails[], ZitTag[]]> {
        const [branches, tags] = await Promise.all([
            this.repository.getBranches(),
            this.repository.getTags(),
        ]);
        const branchesSet = new Set<ZitCheckin>(
            branches.map(info => info.name)
        );
        // Exclude tags that are branches
        return [branches, tags.filter(tag => !branchesSet.has(tag))];
    }

    /** Show one committed file change against the check-in's primary parent. */
    async diffToParent(
        filePath: RelativePath,
        checkin: ZitCheckin,
        status?: ResourceStatus
    ): Promise<void> {
        const resolvedCheckin = this.resolveHistoryCheckin(checkin);
        const uri = this.toUri(filePath);
        const parent = await this.getInfo(resolvedCheckin, 'parent');
        const left =
            parent && status !== ResourceStatus.ADDED
                ? toZitUri(uri, parent)
                : toZitEmptyUri(uri);
        const right =
            status === ResourceStatus.DELETED
                ? toZitEmptyUri(uri)
                : toZitUri(uri, resolvedCheckin);
        const leftLabel = parent?.slice(0, 12) ?? 'empty';
        const rightLabel =
            status === ResourceStatus.DELETED
                ? 'empty'
                : resolvedCheckin.slice(0, 12);
        const title = `${path.basename(
            uri.fsPath
        )} (${leftLabel} vs. ${rightLabel})`;

        return commands.executeCommand<void>(
            'vscode.diff',
            left,
            right,
            title,
            { preview: false } as TextDocumentShowOptions
        );
    }

    public getInfo(
        checkin: ZitCheckin,
        field: 'parent'
    ): Promise<ZitHash | undefined>;
    public getInfo(checkin: ZitCheckin, field: 'hash'): Promise<ZitHash>;
    public getInfo(
        checkin: ZitCheckin,
        field: 'parent' | 'hash'
    ): Promise<ZitHash | undefined> {
        const resolvedCheckin = this.resolveHistoryCheckin(checkin);
        return field === 'hash'
            ? this.repository.getInfo(resolvedCheckin, 'hash')
            : this.repository.getInfo(resolvedCheckin, 'parent');
    }

    @throttle
    public getBranches(
        opts: { includeClosed?: boolean } = {}
    ): Promise<BranchDetails[]> {
        return this.repository.getBranches(opts);
    }

    @throttle
    public async getCommitDetails(checkin: ZitCheckin): Promise<CommitDetails> {
        const commits = await this.getLogEntries({
            checkin: checkin,
            limit: 1,
            verbose: true,
        });
        return commits[0]; // technically can be undefined. ignore.
    }

    public getLogEntries(
        options: LogEntriesOptions & { verbose: true }
    ): Promise<CommitDetails[]>;

    public getLogEntries(options?: LogEntriesOptions): Promise<Commit[]>;

    @throttle
    public getLogEntries(options: LogEntriesOptions = {}): Promise<Commit[]> {
        let filePath: RelativePath | undefined;
        if (options.fileUri) {
            filePath = this.mapFileUriToRepoRelativePath(options.fileUri);
        }

        const requestedCheckin =
            options.checkin ??
            (filePath ? ('current' as ZitCheckin) : undefined);
        const opts: TimelineOptions = {
            ...options,
            checkin:
                requestedCheckin === undefined
                    ? undefined
                    : this.resolveHistoryCheckin(requestedCheckin),
            filePath,
            limit: options.limit || 512,
        } as const;
        return this.repository.getLogEntries(opts);
    }

    /** Refresh the Zit checkout model after a mutating operation. */
    @throttle
    public async updateModelState(
        sideEffects: SideEffects,
        reason: Reason = 'model state is updating' as Reason
    ): Promise<void> {
        if (!sideEffects.status) {
            return;
        }
        const failure = await this.updateStatus(reason);
        if (failure) {
            throw new Error(
                failure.stderr.trim() ||
                    failure.spawnFailure?.message ||
                    'zit status failed'
            );
        }
    }

    @queue('queue', 'u')
    public async updateStatus(
        reason?: Reason
    ): Promise<ExecFailure | undefined> {
        const { status, extras, diff } = await this.repository.getStatus(
            reason ?? ('updating status' as Reason)
        );
        const failure = [status, extras, diff].find(
            (result): result is ExecFailure => result.exitCode !== 0
        );
        if (failure) {
            return failure;
        }

        const zitStatus = (this._zitStatus = this.repository.parseStatusString(
            status.stdout as StatusString,
            extras.stdout,
            diff.stdout
        ));
        this._currentBranch = zitStatus.branch;
        groupStatuses({
            repositoryRoot: this.repository.root,
            fileStatuses: zitStatus.statuses,
            statusGroups: this._groups,
        });
        this._sourceControl.count = this.count;
        this.updateInputBoxPlaceholder(zitStatus.branch);
        this.statusBar.update();
        return;
    }

    private get count(): number {
        return (
            this.addedGroup.resourceStates.length +
            this.workingGroup.resourceStates.length +
            this.untrackedGroup.resourceStates.length
        );
    }

    public async updateAutoSyncInterval(
        interval: AutoSyncIntervalMs,
        persistNativeSetting: boolean = false
    ): Promise<void> {
        clearTimeout(this.autoSyncTimer);
        interval =
            interval && (Math.max(interval, 15000) as AutoSyncIntervalMs);
        const nextSyncTime = interval
            ? new Date(Date.now() + interval)
            : undefined;
        this.statusBar.onSyncTimeUpdated(nextSyncTime);
        if (interval) {
            this.autoSyncTimer = setTimeout(
                () => void this.periodicSync(),
                interval
            );
        }
        if (persistNativeSetting) {
            await this.repository.setAutoSync(Boolean(interval));
        }
    }

    @queue('queue', 's')
    private async syncSilently(): Promise<ExecResult> {
        return this.repository.sync(undefined, undefined, {
            logErrors: false,
        });
    }

    private async syncVerbosely(
        credentials?: SyncCredentials
    ): Promise<ExecResult> {
        return this.runWithProgress(
            { syncText: 'Syncing' },
            signal =>
                this.queue.enqueue(
                    () =>
                        this.repository.sync(undefined, credentials, {
                            signal,
                        }),
                    'S'
                ),
            result => !result.exitCode,
            'Syncing Zit repository…'
        );
    }

    async periodicSync(): Promise<void> {
        const remote = await this.getRemote();
        if (remote) {
            const syncResult = await this.syncSilently();
            this.statusBar.onSyncReady(syncResult);
        } else {
            this.statusBar.onNoRemote();
        }
        await this.updateAutoSyncInterval(typedConfig.autoSyncIntervalMs);
    }

    async sync(credentials?: SyncCredentials): Promise<void> {
        const syncResult = await this.syncVerbosely(credentials);
        this.statusBar.onSyncReady(syncResult);
        await this.updateAutoSyncInterval(typedConfig.autoSyncIntervalMs);
    }

    dispose(): void {
        clearTimeout(this.autoSyncTimer);
        dispose(this.disposables);
    }
}
