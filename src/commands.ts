/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ben Crowl. All rights reserved.
 *  Original Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
    Uri,
    commands,
    Disposable,
    window,
    workspace,
    SourceControlResourceState,
    SourceControlResourceGroup,
    TextDocumentShowOptions,
    ViewColumn,
    Selection,
    SourceControl,
    LogOutputChannel,
} from 'vscode';
import { LineChange, revertChanges } from './revert';
import * as path from 'path';
import {
    OpenedRepository,
    ZitRoot,
    ZitCheckin,
    MergeAction,
    ZitHash,
    ZitSpecialTags,
    ZitCommitMessage,
    ResourceStatus,
} from './openedRepository';
import type { Model } from './model';
import { ZitResource, CommitOptions, Repository } from './repository';
import { ZitResourceGroup, isResourceGroup } from './resourceGroups';
import * as interaction from './interaction';
import { CommitSources } from './interaction';
import * as humanise from './humanise';
import { partition } from './util';
import { fromZitUri, toZitEmptyUri, toZitUri } from './uri';
import { ZitAnnotator } from './praise';
import type { DocumentFsPath, ZitExecutable } from './zitExecutable';

import { localize } from './main';
import { exportGit } from './gitExport';

type CommandKey =
    | 'add'
    | 'addAll'
    | 'branch'
    | 'branchChange'
    | 'cherrypick'
    | 'clean'
    | 'clone'
    | 'closeBranch'
    | 'commit'
    | 'commitAll'
    | 'commitBranch'
    | 'commitWithInput'
    | 'fileLog'
    | 'forget'
    | 'gitExport'
    | 'init'
    | 'log'
    | 'merge'
    | 'open'
    | 'openChange'
    | 'openChangeFromUri'
    | 'openFile'
    | 'openFileFromUri'
    | 'openFiles'
    | 'openResource'
    | 'annotate'
    | 'pull'
    | 'push'
    | 'pushTo'
    | 'redo'
    | 'refresh'
    | 'rename'
    | 'revert'
    | 'revertAll'
    | 'revertChange'
    | 'showOutput'
    | 'stashApply'
    | 'stashDrop'
    | 'stashPop'
    | 'stashSave'
    | 'tagAdd'
    | 'stashShow'
    | 'sync'
    | 'undo'
    | 'update';
export type CommandId = `zit.${CommandKey}`;

interface Command {
    id: CommandId;
    method: CommandMethod;
}
type CommandMethod = (() => any) | ((...args: any) => Promise<void>);

function makeCommandWithRepository(method: CommandMethod): CommandMethod {
    return async function (this: CommandCenter, ...args: any[]): Promise<void> {
        const repository = await this.guessRepository(args[0]);
        if (repository) {
            return method.call(this, repository, ...args);
        }
    };
}

/**
 * Decorator
 */
const register: Command[] = [];
const enum Inline {
    Repository = 1,
}

// function command(repository?: 1) {
//     return (
//         fn: CommandMethod,
//         context: ClassMethodDecoratorContext<CommandCenter, CommandMethod> & {
//             name: CommandKey;
//         }
//     ) => {
//         if (repository) {
//             fn = makeCommandWithRepository(fn);
//         }
//         register.push({
//             id: `zit.${context.name as CommandKey}`,
//             method: fn,
//         });
//         return fn;
//     };
// }

function command(repository?: 1) {
    return (
        _target: any,
        key: CommandKey,
        descriptor: TypedPropertyDescriptor<CommandMethod>
    ) => {
        let fn = descriptor.value!;
        if (repository) {
            fn = makeCommandWithRepository(fn);
        }
        register.push({
            id: `zit.${key}`,
            method: fn,
        });
    };
}

export class CommandCenter {
    private readonly disposables: Disposable[];

    constructor(
        private readonly executable: ZitExecutable,
        private readonly model: Model,
        private readonly outputChannel: LogOutputChannel
    ) {
        this.disposables = register.map(command =>
            commands.registerCommand(command.id, command.method, this)
        );
        register.length = 0;
    }

    @command(Inline.Repository)
    async refresh(repository: Repository): Promise<void> {
        await repository.refresh();
    }

    @command()
    async openResource(resource: ZitResource): Promise<void> {
        await this._openResource(resource, undefined, true);
    }

    private async _openResource(
        resource: ZitResource | undefined,
        preview?: boolean,
        preserveFocus?: boolean
    ): Promise<void> {
        if (!resource) {
            return;
        }
        const left = this.getLeftResource(resource);
        let right = this.getRightResource(resource);
        const title = this.getTitle(resource);
        const opts: TextDocumentShowOptions = {
            preserveFocus,
            preview,
            viewColumn: ViewColumn.Active,
        };

        if (!left) {
            const document = await workspace.openTextDocument(
                resource.resourceUri
            );
            await window.showTextDocument(document, opts);
            return;
        }
        if (!right) {
            right = toZitEmptyUri(resource.original);
        }
        await commands.executeCommand<void>(
            'vscode.diff',
            left,
            right,
            title,
            opts
        );
    }

    private getLeftResource(resource: ZitResource): Uri | undefined {
        switch (resource.status) {
            case ResourceStatus.ADDED:
            case ResourceStatus.EXTRA:
                return;
            case ResourceStatus.MODIFIED:
            case ResourceStatus.DELETED:
            case ResourceStatus.MISSING:
            default:
                return toZitUri(resource.original);
        }
    }

    private getRightResource(resource: ZitResource): Uri | undefined {
        switch (resource.status) {
            case ResourceStatus.DELETED:
            case ResourceStatus.MISSING:
                return;
            case ResourceStatus.ADDED:
            case ResourceStatus.MODIFIED:
            case ResourceStatus.EXTRA:
            default:
                return resource.resourceUri;
        }
    }

    private getTitle(resource: ZitResource): string {
        const basename = path.basename(resource.resourceUri.fsPath);
        switch (resource.status) {
            case ResourceStatus.DELETED:
                return `${basename} (Deleted)`;
            case ResourceStatus.MISSING:
                return `${basename} (Missing)`;
            case ResourceStatus.ADDED:
            case ResourceStatus.MODIFIED:
            case ResourceStatus.EXTRA:
            default:
                return `${basename} (Working Directory)`;
        }
    }

    @command()
    async clone(): Promise<void> {
        const url = await interaction.inputRepoUrl();
        if (!url) {
            return;
        }
        const root = await interaction.selectCheckoutDirectory('Clone');
        if (!root) {
            return;
        }

        const result = await interaction.runCloneWithProgress(signal =>
            OpenedRepository.clone(this.executable, url, root, signal)
        );
        if (result.exitCode === 0) {
            await this.askOpenRepository(root);
        }
    }

    async openRepository(
        root: ZitRoot,
        checkin?: ZitCheckin,
        forceOpen = false
    ): Promise<void> {
        if (
            !forceOpen &&
            (await OpenedRepository.isMaterialized(this.executable, root))
        ) {
            await this.model.tryOpenRepository(root);
            return;
        }
        const result = await OpenedRepository.open(
            this.executable,
            root,
            checkin
        );
        if (result.exitCode === 0) {
            await this.model.tryOpenRepository(root);
        }
    }

    private async askOpenRepository(root: ZitRoot): Promise<void> {
        if (await interaction.promptOpenClonedRepo()) {
            await this.openRepository(root, undefined, true);
        }
    }

    @command()
    async init(): Promise<void> {
        const root = await interaction.selectCheckoutDirectory('Create');
        if (!root) {
            return;
        }
        const result = await OpenedRepository.init(this.executable, root);
        if (result.exitCode === 0) {
            await this.model.tryOpenRepository(root);
        }
    }

    @command()
    async open(): Promise<void> {
        const root = await interaction.selectCheckoutDirectory('Open');
        if (root) {
            await this.openRepository(root);
        }
    }

    @command()
    openFiles(
        ...resources: (ZitResource | SourceControlResourceGroup)[]
    ): Promise<void> {
        if (resources.length === 1) {
            // a resource group proxy object?
            const [resourceGroup] = resources;
            if (isResourceGroup(resourceGroup)) {
                // const groupId = resourceGroup.id
                resources = resourceGroup.resourceStates as ZitResource[];
            }
        }

        return this.openFile(...(<ZitResource[]>resources));
    }

    // user clicked `Open file` action in diff view or in the scm panel
    @command()
    async openFile(...resources: ZitResource[]): Promise<void> {
        const uris = resources.map(res => res.resourceUri);
        const preview = uris.length === 1;
        const activeTextEditor = window.activeTextEditor;

        for (const uri of uris) {
            const opts: TextDocumentShowOptions = {
                preserveFocus: true,
                preview,
                viewColumn: ViewColumn.Active,
            };

            // Check if active text editor has same path as other editor. we cannot compare via
            // URI.toString() here because the schemas can be different. Instead we just go by path.
            if (
                activeTextEditor &&
                activeTextEditor.document.uri.path === uri.path
            ) {
                opts.selection = activeTextEditor.selection;
            }

            const document = await workspace.openTextDocument(uri);
            await window.showTextDocument(document, opts);
        }
    }

    @command()
    async openChange(...resources: ZitResource[]): Promise<void> {
        if (resources.length === 1) {
            // a resource group proxy object?
            const [resourceGroup] = resources;
            if (isResourceGroup(resourceGroup)) {
                // const groupId = resourceGroup.id;
                const resources = resourceGroup.resourceStates as ZitResource[];
                return this.openChange(...resources);
            }
        }

        const preview = resources.length === 1 ? undefined : false;
        for (const resource of resources) {
            await this._openResource(resource, preview, true);
        }
    }

    @command()
    async openFileFromUri(uri?: Uri): Promise<void> {
        const resource = this.getSCMResource(uri);

        if (!resource) {
            return;
        }

        return this.openFile(resource);
    }

    @command()
    async openChangeFromUri(uri?: Uri): Promise<void> {
        const resource = this.getSCMResource(uri);
        return this._openResource(resource);
    }

    @command(Inline.Repository)
    async addAll(repository: Repository): Promise<void> {
        const untracked = repository.untrackedGroup.resourceStates;
        if (untracked.length) {
            return repository.add(...untracked.map(r => r.resourceUri));
        }
    }

    @command()
    async add(...resourceStates: SourceControlResourceState[]): Promise<void> {
        this.maybeUseDefaultResource(resourceStates);

        const scmResources = resourceStates.filter(
            s => s instanceof ZitResource && s.resourceGroup.is('untracked')
        );

        if (!scmResources.length) {
            return;
        }

        const resources = scmResources.map(r => r.resourceUri);
        const repository = this.model.getRepository(resources[0]);
        if (repository) {
            await repository.add(...resources);
        }
    }
    @command()
    async rename(resourceState: SourceControlResourceState): Promise<void> {
        if (!(resourceState instanceof ZitResource)) {
            return;
        }
        const uri = resourceState.resourceUri;
        const repository = this.model.getRepository(uri);

        if (repository) {
            const defaultUri = Uri.file(path.dirname(uri.fsPath));
            const relativePath = repository.mapFileUriToRepoRelativePath(uri);
            const newPath = await interaction.selectNewFileLocation(
                defaultUri,
                relativePath,
                repository.untrackedGroup.resourceStates.map(r =>
                    repository.mapFileUriToRepoRelativePath(r.resourceUri)
                )
            );
            if (newPath) {
                const destination = path.isAbsolute(newPath)
                    ? repository.mapFileUriToRepoRelativePath(Uri.file(newPath))
                    : newPath;
                await repository.rename(relativePath, destination);
            }
        }
    }
    @command()
    async forget(
        ...resourceStates: SourceControlResourceState[]
    ): Promise<void> {
        this.maybeUseDefaultResource(resourceStates);

        const scmResources = resourceStates.filter(
            s =>
                s instanceof ZitResource &&
                (s.resourceGroup.is('added') || s.resourceGroup.is('working'))
        );

        if (!scmResources.length) {
            return;
        }

        const resources = scmResources.map(r => r.resourceUri);
        const repository = this.model.getRepository(resources[0]);
        if (repository) {
            await repository.forget(...resources);
        }
    }

    @command()
    async revert(
        ...resourceStates: SourceControlResourceState[]
    ): Promise<void> {
        this.maybeUseDefaultResource(resourceStates);

        const scmResources = resourceStates.filter(
            (s): s is ZitResource => s instanceof ZitResource && s.isDirtyStatus
        );

        if (!scmResources.length) {
            return;
        }

        const [discardResources, addedResources] = partition(
            scmResources,
            s => s.status !== ResourceStatus.ADDED
        );
        if (discardResources.length) {
            const confirmFilenames = discardResources.map(r =>
                path.basename(r.resourceUri.fsPath)
            );
            const addedFilenames = addedResources.map(r =>
                path.basename(r.resourceUri.fsPath)
            );

            const confirmed = await interaction.confirmDiscardChanges(
                confirmFilenames,
                addedFilenames
            );
            if (!confirmed) {
                return;
            }
        }

        const resources = scmResources.map(r => r.resourceUri);
        const repository = this.model.getRepository(resources[0]);
        if (repository) {
            await repository.revert(...resources);
        }
    }

    @command(Inline.Repository)
    async revertAll(
        repository: Repository,
        ...groups: ZitResourceGroup[]
    ): Promise<void> {
        if (!groups.length) {
            groups = [repository.addedGroup, repository.workingGroup];
        }
        const name = groups.map(g => `"${g.label}"`).join(' and ');
        if (await interaction.confirmDiscardAllChanges(name, groups.length)) {
            await repository.revert(
                ...groups
                    .map(g => g.resourceStates)
                    .flat()
                    .map(r => r.resourceUri)
            );
        }
    }

    @command(Inline.Repository)
    async clean(repository: Repository): Promise<void> {
        const preview = await repository.clean(true);
        if (preview.exitCode) {
            return;
        }
        const paths = preview.stdout.split(/\r?\n/).filter(Boolean);
        if (paths.length && (await interaction.confirmDeleteResources(paths))) {
            await repository.clean(false);
        }
    }

    private async checkTrackedUnsavedFiles(
        repository: Repository
    ): Promise<{ proceed: boolean; saved: boolean }> {
        const allUnsavedDocuments = workspace.textDocuments.filter(
            doc => !doc.isUntitled && doc.isDirty
        );
        const existingUris = new Set<string>();
        if (allUnsavedDocuments.length) {
            for (const uri of await repository.ls()) {
                existingUris.add(uri.fsPath);
            }
        }
        const documents = allUnsavedDocuments.filter(
            doc =>
                existingUris.has(doc.uri.fsPath) ||
                repository.isInAnyGroup(doc.uri)
        );
        if (documents.length > 0) {
            const message =
                documents.length === 1
                    ? localize(
                          'unsaved files single',
                          "The following file has unsaved changes which won't be included in the commit if you proceed: {0}.\n\nWould you like to save it before committing?",
                          path.basename(documents[0].uri.fsPath)
                      )
                    : localize(
                          'unsaved files',
                          'There are {0} unsaved files.\n\nWould you like to save them before committing?',
                          documents.length
                      );
            const saveAndCommit = localize(
                'save and commit',
                'Save All & Commit'
            );
            const commit = localize('commit', 'C&&ommit Without Saving');
            const pick = await window.showWarningMessage(
                message,
                { modal: true },
                saveAndCommit,
                commit
            );

            if (pick === saveAndCommit) {
                const saved = await Promise.all(documents.map(d => d.save()));
                const succeeded = saved.every(Boolean);
                return { proceed: succeeded, saved: succeeded };
            }
            if (pick !== commit) {
                return { proceed: false, saved: false };
            }
        }
        return { proceed: true, saved: false };
    }
    private async smartCommit(
        repository: Repository,
        getCommitMessage: () => Promise<ZitCommitMessage | undefined>,
        opts: CommitOptions = {}
    ): Promise<boolean> {
        const unsavedFiles = await this.checkTrackedUnsavedFiles(repository);
        if (!unsavedFiles.proceed) {
            return false;
        }
        if (
            !repository.zitStatus?.isMerge &&
            repository.addedGroup.resourceStates.length === 0 &&
            repository.workingGroup.resourceStates.length === 0 &&
            !unsavedFiles.saved
        ) {
            interaction.informNoChangesToCommit();
            return false;
        }
        const newBranch = opts.useBranch
            ? await interaction.inputNewBranchOptions()
            : undefined;
        if (opts.useBranch && !newBranch) {
            return false;
        }

        const message = await getCommitMessage();
        if (message === undefined) {
            return false;
        }

        const result = await repository.commit(
            message,
            newBranch,
            opts.closeBranch
        );
        return !result.exitCode;
    }

    private async commitWithAnyInput(
        repository: Repository,
        opts: CommitOptions
    ): Promise<void> {
        const inputBox = repository.sourceControl.inputBox;
        const message = inputBox.value as ZitCommitMessage;
        const didCommit = await this.smartCommit(
            repository,
            () =>
                message
                    ? Promise.resolve(message)
                    : interaction.inputCommitMessage(),
            opts
        );
        if (message && didCommit) {
            inputBox.value = '';
        }
    }

    @command(Inline.Repository)
    async commit(repository: Repository): Promise<void> {
        await this.commitWithAnyInput(repository, {});
    }

    @command(Inline.Repository)
    async commitWithInput(repository: Repository): Promise<void> {
        const didCommit = await this.smartCommit(
            repository,
            async () =>
                repository.sourceControl.inputBox.value as ZitCommitMessage
        );

        if (didCommit) {
            repository.sourceControl.inputBox.value = '';
        }
    }

    @command(Inline.Repository)
    async commitAll(repository: Repository): Promise<void> {
        await this.commitWithAnyInput(repository, {});
    }

    @command(Inline.Repository)
    async commitBranch(repository: Repository): Promise<void> {
        await this.commitWithAnyInput(repository, { useBranch: true });
    }

    private async undoOrRedo(
        repository: Repository,
        command: 'undo' | 'redo'
    ): Promise<void> {
        if (!(await interaction.confirmUndoOrRedo(command))) {
            return;
        }
        const result = await repository.undoOrRedo(command);
        if (result === 'NoUndo') {
            await interaction.warnNoUndoOrRedo(command);
        }
    }

    @command(Inline.Repository)
    async undo(repository: Repository): Promise<void> {
        return this.undoOrRedo(repository, 'undo');
    }

    @command(Inline.Repository)
    async redo(repository: Repository): Promise<void> {
        return this.undoOrRedo(repository, 'redo');
    }

    private async stash(repository: Repository): Promise<void> {
        const now = new Date();
        const dateTime = new Date(
            now.getTime() - now.getTimezoneOffset() * 60000
        )
            .toISOString()
            .slice(0, 19)
            .replace('T', ' ');
        const defaultMessage = `vscode-stash ${dateTime}` as ZitCommitMessage;
        const message = await interaction.inputCommitMessage(defaultMessage);
        if (message === undefined) {
            return;
        }
        const unsavedFiles = await this.checkTrackedUnsavedFiles(repository);
        if (!unsavedFiles.proceed) {
            return;
        }
        await repository.stash(message);
    }

    @command(Inline.Repository)
    async stashSave(repository: Repository): Promise<void> {
        return this.stash(repository);
    }

    @command(Inline.Repository)
    async stashShow(repository: Repository): Promise<void> {
        const items = await repository.stashList();
        const stashId = await interaction.pickStashItem(items, 'show');
        if (stashId === undefined) {
            return;
        }
        const details = await repository.stashShow(stashId);
        this.outputChannel.appendLine(details.trimEnd());
        this.outputChannel.show();
    }

    private async stashApplyOrDrop(
        repository: Repository,
        operation: 'apply' | 'drop'
    ) {
        const items = await repository.stashList();
        const stashId = await interaction.pickStashItem(items, operation);
        if (stashId !== undefined) {
            return repository.stashApplyOrDrop(operation, stashId);
        }
    }

    @command(Inline.Repository)
    async stashPop(repository: Repository): Promise<void> {
        const items = await repository.stashList();
        const stashId = await interaction.pickStashItem(items, 'pop');
        if (stashId !== undefined) {
            return repository.stashPop(stashId);
        }
    }

    @command(Inline.Repository)
    async stashApply(repository: Repository): Promise<void> {
        return this.stashApplyOrDrop(repository, 'apply');
    }

    @command(Inline.Repository)
    async stashDrop(repository: Repository): Promise<void> {
        return this.stashApplyOrDrop(repository, 'drop');
    }

    @command(Inline.Repository)
    async branchChange(repository: Repository): Promise<void> {
        // branches/tags
        if (await interaction.checkActiveMerge(repository)) {
            return;
        }
        const refs = await repository.getBranchesAndTags();

        const checkin = await interaction.pickUpdateCheckin(refs);
        if (checkin) {
            await repository.update(checkin);
        }
    }

    @command(Inline.Repository)
    async branch(repository: Repository): Promise<void> {
        await this.commitWithAnyInput(repository, { useBranch: true });
    }

    @command(Inline.Repository)
    async update(repository: Repository): Promise<void> {
        const checkin = await interaction.pickUpdateCheckin(
            await repository.getBranchesAndTags()
        );
        if (checkin) {
            await repository.update(checkin);
        }
    }

    @command(Inline.Repository)
    async pull(repository: Repository): Promise<void> {
        if (!(await repository.getRemote())) {
            return interaction.warnNoRemotes();
        }
        await repository.pull();
    }

    private async mergeCommon(
        repository: Repository,
        mergeAction: MergeAction,
        placeholder: string
    ): Promise<void> {
        if (await interaction.checkActiveMerge(repository)) {
            return;
        }

        const openedBranches = await repository.getBranches();
        const branch = await interaction.pickBranch(
            openedBranches,
            placeholder
        );
        if (branch) {
            return this.doMerge(repository, branch, mergeAction);
        }
    }

    @command(Inline.Repository)
    async merge(repository: Repository): Promise<void> {
        const placeholder = localize(
            'choose branch',
            'Choose branch to merge into working directory:'
        );
        return this.mergeCommon(repository, MergeAction.Merge, placeholder);
    }

    @command(Inline.Repository)
    async cherrypick(repository: Repository): Promise<void> {
        const logEntries = await repository.getLogEntries();
        const checkin = await interaction.pickCommitToCherrypick(logEntries);

        if (checkin) {
            return this.doMerge(repository, checkin, MergeAction.Cherrypick);
        }
    }

    private async doMerge(
        repository: Repository,
        otherRevision: ZitCheckin,
        mergeAction: MergeAction
    ) {
        const result = await repository.merge(otherRevision, mergeAction);
        if (result.exitCode) {
            return;
        }
        const { currentBranch } = repository;

        if (currentBranch) {
            const defaultMergeMessage = humanise.describeMerge(
                currentBranch,
                otherRevision
            );
            const didCommit = await this.smartCommit(
                repository,
                async () =>
                    await interaction.inputCommitMessage(defaultMergeMessage)
            );

            if (didCommit) {
                repository.sourceControl.inputBox.value = '';
            }
        }
    }

    @command(Inline.Repository)
    async closeBranch(repository: Repository): Promise<void> {
        await this.commitWithAnyInput(repository, { closeBranch: true });
    }

    @command(Inline.Repository)
    async tagAdd(repository: Repository, checkin?: ZitCheckin): Promise<void> {
        const target = checkin ?? repository.zitStatus?.checkin;
        if (!target) {
            return;
        }
        const tag = await interaction.inputTagName();
        if (tag) {
            await repository.addTag(target, tag);
        }
    }

    @command(Inline.Repository)
    async push(repository: Repository): Promise<void> {
        if (!(await repository.getRemote())) {
            return interaction.warnNoRemotes();
        }
        const credentials = await interaction.inputSyncCredentials();
        if (credentials !== undefined) {
            await repository.push(undefined, credentials ?? undefined);
        }
    }

    @command(Inline.Repository)
    async pushTo(repository: Repository): Promise<void> {
        const url = await interaction.inputRemoteUrl(
            await repository.getRemote()
        );
        if (!url) {
            return;
        }
        const credentials = await interaction.inputSyncCredentials();
        if (credentials !== undefined) {
            await repository.push(url, credentials ?? undefined);
        }
    }

    @command()
    showOutput(): void {
        this.outputChannel.show();
    }

    @command(Inline.Repository)
    async log(repository: Repository): Promise<void> {
        await interaction.presentLogSourcesMenu(repository);
    }

    @command()
    async fileLog(uri?: Uri): Promise<void> {
        if (!uri) {
            uri = window.activeTextEditor?.document.uri;
        }
        if (!uri || uri.scheme !== 'file') {
            return;
        }

        const repository = this.model.getRepository(uri);
        if (!repository) {
            return;
        }

        const onCommitPicked = (checkin: ZitCheckin) => async () => {
            await interaction.pickDiffAction(
                logEntries,
                (to: ZitHash | ZitSpecialTags | undefined) =>
                    (): Promise<void> =>
                        this.diff(repository, checkin, to, uri!),
                this.fileLog
            );
        };

        const logEntries = await repository.getLogEntries({ fileUri: uri });
        const choice = await interaction.pickCommit(
            CommitSources.File,
            logEntries,
            onCommitPicked
        );

        if (choice) {
            await choice.run();
        }
    }

    @command()
    async revertChange(
        uri: Uri | undefined,
        changes: LineChange[] | undefined,
        index: number
    ): Promise<void> {
        if (!uri || !changes) {
            return;
        }
        const textEditor = window.visibleTextEditors.find(
            e => e.document.uri.toString() === uri.toString()
        );
        if (!textEditor) {
            return;
        }
        await revertChanges(textEditor, [
            ...changes.slice(0, index),
            ...changes.slice(index + 1),
        ]);
        const selectionLine = changes[index].modifiedStartLineNumber - 1;
        textEditor.selections = [
            new Selection(selectionLine, 0, selectionLine, 0),
        ];
    }

    @command(Inline.Repository)
    async sync(repository: Repository): Promise<void> {
        if (!(await repository.getRemote())) {
            return interaction.warnNoRemotes();
        }
        const credentials = await interaction.inputSyncCredentials();
        if (credentials !== undefined) {
            await repository.sync(credentials ?? undefined);
        }
    }

    @command()
    async annotate(): Promise<void> {
        const editor = window.activeTextEditor;
        if (!editor) {
            return;
        }
        if (ZitAnnotator.tryDelete(editor)) {
            return;
        }
        const uri = editor.document.uri;
        const repository = this.model.getRepository(uri);
        if (!repository) {
            return;
        }
        const annotations = await repository.annotate(
            uri.fsPath as DocumentFsPath
        );
        await ZitAnnotator.create(repository, editor, annotations);
    }

    @command(Inline.Repository)
    async gitExport(repository: Repository): Promise<void> {
        await exportGit(repository);
    }

    private async diff(
        repository: Repository,
        checkin: ZitCheckin,
        target: ZitHash | ZitSpecialTags | undefined,
        uri: Uri
    ) {
        const resolvedCheckin = await repository.getInfo(checkin, 'hash');
        let fromUri = toZitUri(uri, resolvedCheckin);
        let fromName = resolvedCheckin.slice(0, 12);
        let toUri: Uri;
        let toName: string;
        if (target === 'parent') {
            const repoPath = repository.mapFileUriToRepoRelativePath(uri);
            const details = await repository.getCommitDetails(resolvedCheckin);
            const status = details.files.find(
                file => file.path === repoPath
            )?.status;
            const parent = await repository.getInfo(resolvedCheckin, 'parent');
            if (status === ResourceStatus.DELETED) {
                fromUri = toZitEmptyUri(uri);
                fromName = 'empty';
            }
            toUri =
                parent && status !== ResourceStatus.ADDED
                    ? toZitUri(uri, parent)
                    : toZitEmptyUri(uri);
            toName = parent?.slice(0, 12) ?? 'empty';
        } else if (target === undefined) {
            toUri = uri;
            toName = 'local';
        } else {
            const resolvedTarget = await repository.getInfo(target, 'hash');
            toUri = toZitUri(uri, resolvedTarget);
            toName = resolvedTarget.slice(0, 12);
        }
        const relativePath = repository.mapFileUriToWorkspaceRelativePath(uri);
        const title = `${relativePath} (${fromName} vs. ${toName})`;

        return commands.executeCommand<void>(
            'vscode.diff',
            fromUri,
            toUri,
            title
        );
    }

    public guessRepository(
        arg: Uri | SourceControl | Repository
    ): Promise<Repository | undefined> {
        const repository = this.model.getRepository(arg);
        let repositoryPromise: Promise<Repository | undefined>;

        if (repository) {
            repositoryPromise = Promise.resolve(repository);
        } else if (this.model.repositories.length === 1) {
            repositoryPromise = Promise.resolve(this.model.repositories[0]);
        } else {
            repositoryPromise = this.model.pickRepository();
        }
        return repositoryPromise;
    }

    private getSCMResource(uri?: Uri): ZitResource | undefined {
        uri = uri || window.activeTextEditor?.document.uri;
        if (!uri) {
            return;
        }
        if (uri.scheme === 'zit') {
            if (!uri.query) {
                return;
            }
            try {
                uri = Uri.file(fromZitUri(uri).path);
            } catch {
                return;
            }
        }
        if (uri.scheme !== 'file') {
            return;
        }
        const repository = this.model.getRepository(uri);
        if (!repository) {
            return;
        }
        return (
            repository.addedGroup.getResource(uri) ||
            repository.workingGroup.getResource(uri) ||
            repository.untrackedGroup.getResource(uri)
        );
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
    }

    private maybeUseDefaultResource(
        resourceStates: SourceControlResourceState[]
    ): void {
        if (!resourceStates.length) {
            const resource = this.getSCMResource();
            if (resource) {
                resourceStates.push(resource);
            }
        }
    }
}
