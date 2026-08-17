/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ben Crowl. All rights reserved.
 *  Original Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as os from 'os';
import {
    CancellationError,
    InputBoxOptions,
    ProgressLocation,
    QuickPickItem,
    QuickPickItemKind,
    Uri,
    window,
    workspace,
} from 'vscode';
import {
    Commit,
    CommitDetails,
    FileStatus,
    ZitRoot,
    ZitURI,
    ZitBranch,
    BranchDetails,
    ZitTag,
    ZitCheckin,
    ZitHash,
    ZitSpecialTags,
    ZitCommitMessage,
    ZitUsername,
    ZitPassword,
    StashItem,
    ResourceStatus,
    UserPath,
    RelativePath,
    StashID,
    SyncCredentials,
} from './openedRepository';
import * as humanise from './humanise';
import { Repository, LogEntriesOptions } from './repository';
import typedConfig from './config';
import { localize } from './main';
import { ExecFailure, ZitArgsWithOptions, ZitStdOut } from './zitExecutable';

const SHORT_HASH_LENGTH = 12;
const LONG_HASH_LENGTH = SHORT_HASH_LENGTH * 2;
let lastUsedRepoUrl = '';
let lastUsedZitRoot: Uri | undefined;
let lastUsedUser: string | undefined;
let lastUsedSyncUser = '';

export const enum CommitSources {
    File,
    Repo,
}

export interface NewBranchOptions {
    readonly branch: ZitBranch;
}

function suggestCheckout(): Uri {
    const folders = workspace.workspaceFolders;
    if (folders?.length) {
        return folders[0].uri;
    }
    return Uri.joinPath(Uri.file(os.homedir()), 'repo_name');
}

export async function selectCheckoutDirectory(
    openLabel: 'Clone' | 'Create' | 'Open'
): Promise<ZitRoot | undefined> {
    const uris = await window.showOpenDialog({
        defaultUri: lastUsedZitRoot || suggestCheckout(),
        title: 'Select Zit Checkout Directory',
        openLabel,
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
    });
    const uri = uris?.[0];
    if (uri) {
        lastUsedZitRoot = uri;
    }
    return uri?.fsPath as ZitRoot | undefined;
}

export async function runCloneWithProgress<T>(
    runClone: (signal: AbortSignal) => Promise<T>
): Promise<T> {
    return window.withProgress(
        {
            title: localize('cloning', 'Cloning Zit repository...'),
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
                const result = await runClone(controller.signal);
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

export function informNoChangesToCommit(): void {
    window.showInformationMessage(
        localize('no changes', 'There are no changes to commit.')
    );
}

export async function checkActiveMerge(
    repository: Repository
): Promise<boolean> {
    if (repository.zitStatus?.isMerge) {
        const doit = localize('continue', 'Continue');
        const answer = await window.showWarningMessage(
            localize('outstanding merge', 'Merge is in progress'),
            { modal: true },
            doit
        );
        return answer != doit;
    }
    return false;
}

export async function warnNoRemotes(): Promise<void> {
    await window.showErrorMessage(
        localize(`no remotes`, `Your repository has no remotes configured.`)
    );
}

export async function warnMergeConflicts(
    paths: readonly string[]
): Promise<void> {
    await window.showWarningMessage(
        localize(
            'merge conflicts',
            'Merge conflicts require resolution:\n{0}',
            paths.map(path => ` • ${path}`).join('\n')
        )
    );
}

export async function warnNoUndoOrRedo(
    this: void,
    command: 'undo' | 'redo'
): Promise<void> {
    await window.showWarningMessage(
        localize(`no ${command}`, `Nothing to ${command}.`)
    );
}

export async function errorPromptOpenLog(err: ExecFailure): Promise<boolean> {
    const hint = (err.stderr || err.message || String(err))
        .replace(/^abort: /im, '')
        .split(/[\r\n]/)
        .filter((line: string) => !!line)[0];

    const message = hint
        ? localize('zit error details', 'Zit: {0}', hint)
        : localize('zit error', 'Zit error');

    const openOutputChannelChoice = localize('open zit log', 'Open Zit Log');
    const choice = await window.showErrorMessage(
        message,
        openOutputChannelChoice
    );
    return choice === openOutputChannelChoice;
}

export async function promptOpenClonedRepo(this: void): Promise<boolean> {
    const open = localize('openrepo', 'Open Repository');
    const result = await window.showInformationMessage(
        localize(
            'proposeopen',
            'Would you like to open the cloned repository?'
        ),
        open
    );
    return result === open;
}

export async function confirmRename(
    oldPath: RelativePath,
    newPath: RelativePath
): Promise<boolean> {
    const question = localize(
        'rename {0} to {1}',
        '"{0}" was renamed to "{1}" on filesystem. Rename in Zit repository too?',
        oldPath,
        newPath
    );
    const dontShowAgain = localize('neverAgain', "Don't show again");
    const answer = await window.showInformationMessage(
        question,
        { modal: false },
        'Yes',
        'Cancel',
        dontShowAgain
    );
    if (answer === dontShowAgain) {
        await typedConfig.disableRenaming();
    }
    return answer === 'Yes';
}

export async function inputRepoUrl(this: void): Promise<ZitURI | undefined> {
    const url = await window.showInputBox({
        value: lastUsedRepoUrl,
        valueSelection: [lastUsedRepoUrl.indexOf('//') + 2, 99999],
        prompt: localize('repourl', 'Repository URI'),
        ignoreFocusOut: true,
    });
    if (url) {
        const uri = Uri.parse(url) as ZitURI;
        const authority = uri.authority.replace(/^([^:@]+):[^@]*@/, '$1@');
        lastUsedRepoUrl = uri.with({ authority }).toString();
        return uri;
    }
    return undefined;
}

export async function inputPrompt(
    stdout: ZitStdOut,
    args: ZitArgsWithOptions
): Promise<string | undefined> {
    const lines = stdout.split('\n');
    return window.showInputBox({
        title: `Zit: ${args[0] ?? 'command'}`,
        prompt: lines[lines.length - 1],
        ignoreFocusOut: true,
    });
}

async function inputCommon<TRet extends string = string>(
    this: void,
    key: 'repourl' | 'commit hash',
    message: string,
    extra: InputBoxOptions = {}
): Promise<TRet | undefined> {
    return window.showInputBox({
        prompt: localize(key, message),
        ignoreFocusOut: true,
        ...extra,
    }) as Thenable<TRet | undefined>;
}

class PathPickItem implements QuickPickItem {
    get label(): string {
        return `$(symbol-file) ${this.path}`;
    }
    constructor(readonly path: RelativePath) {}
}

export async function selectNewFileLocation(
    defaultUri: Uri,
    srcRelativePath: RelativePath,
    paths: RelativePath[]
): Promise<UserPath | RelativePath | undefined> {
    const items = paths.map(res => new PathPickItem(res));
    const userSelect: QuickPickItem = {
        label: localize('Open Dialog', '$(folder-opened) Open Dialog'),
        alwaysShow: true,
    };
    const separator: QuickPickItem = {
        label: 'Untracked Files',
        kind: QuickPickItemKind.Separator,
    };
    const title = localize(
        'New location for {0}',
        'New location for {0}',
        srcRelativePath
    );
    const selection = await window.showQuickPick(
        [userSelect, separator, ...items],
        { title }
    );
    if (selection === userSelect) {
        const uris = await window.showOpenDialog({
            defaultUri,
            canSelectMany: false,
            openLabel: localize(
                'Select as new location',
                'Select as new location'
            ),
            title,
        });
        if (uris?.length == 1) {
            return uris[0].fsPath as UserPath;
        }
        return undefined;
    }
    return (selection as PathPickItem | undefined)?.path;
}

export async function inputCloneUser(
    this: void
): Promise<ZitUsername | undefined> {
    const value = lastUsedUser || typedConfig.username || process.env.USER;
    const user = await window.showInputBox({
        prompt: localize('username', 'Username'),
        placeHolder: 'None',
        ignoreFocusOut: true,
        value,
    });
    lastUsedUser = user;
    return user as ZitUsername | undefined;
}

export async function inputClonePassword(
    this: void
): Promise<ZitPassword | undefined> {
    const auth = await window.showInputBox({
        prompt: localize('user authentication', 'User Authentication'),
        placeHolder: localize('password', 'Password. Leave empty for none'),
        password: true,
        ignoreFocusOut: true,
    });
    return auth as ZitPassword | undefined;
}

export async function inputNewBranchOptions(
    this: void
): Promise<NewBranchOptions | undefined> {
    const branch = await window.showInputBox({
        placeHolder: localize('branch name', 'Branch name'),
        prompt: localize('provide branch name', 'Please provide a branch name'),
        ignoreFocusOut: true,
        validateInput: value =>
            value.trim()
                ? undefined
                : localize('branch required', 'Branch name is required'),
    });
    return branch ? { branch: branch as ZitBranch } : undefined;
}

export async function inputTagName(this: void): Promise<ZitTag | undefined> {
    const tag = await window.showInputBox({
        placeHolder: localize('tag name', 'Tag name'),
        prompt: localize('provide tag name', 'Please provide a tag name'),
        ignoreFocusOut: true,
        validateInput: value =>
            value.trim()
                ? undefined
                : localize('tag required', 'Tag name is required'),
    });
    return tag ? (tag as ZitTag) : undefined;
}

export async function pickBranch(
    branches: BranchDetails[],
    placeHolder: string
): Promise<ZitBranch | undefined> {
    const headChoices = branches.map(head => new BranchItem(head));
    const choice = await window.showQuickPick(headChoices, { placeHolder });
    return choice?.checkin;
}

export async function pickUpdateCheckin(
    refs: [BranchDetails[], ZitTag[]]
): Promise<ZitCheckin | undefined> {
    const branches = refs[0].map(ref => new BranchItem(ref));
    const tags = refs[1].map(ref => new TagItem(ref));
    const picks = [
        new UserInputItem(),
        {
            kind: QuickPickItemKind.Separator,
            label: '',
            run: () => {
                /* separator action */
            },
            description: '',
        } as RunnableQuickPickItem,
        ...branches,
        ...tags,
    ];

    let result: CheckinItem<ZitCheckin> | RunnableQuickPickItem | undefined =
        await window.showQuickPick(picks, {
            placeHolder: 'Select a branch/tag to update to:',
            matchOnDescription: true,
        });
    while (result) {
        if (result instanceof CheckinItem) {
            return result.checkin;
        }
        result = await result.run();
    }
    return undefined;
}

function describeLogEntrySource(kind: CommitSources): string {
    switch (kind) {
        case CommitSources.Repo:
            return localize('repo history', 'Repo history');
        case CommitSources.File:
            return localize('file history', 'File history');
    }
}

function describeCommitOneLine(commit: Commit): string {
    return `#${commit.hash.slice(0, LONG_HASH_LENGTH)} • ${
        commit.author
    }, ${humanise.ageFromNow(commit.date)} • ${commit.message}`;
}

function asBackItem(
    description: string,
    action: RunnableAction
): RunnableQuickPickItem {
    const goBack = localize('go back', 'go back');
    const to = localize('to', 'to');
    return new LiteralRunnableQuickPickItem(
        `$(arrow-left)  ${goBack}`,
        `${to} ${description}`,
        '',
        action
    );
}

export async function presentLogSourcesMenu(
    commands: InteractionAPI
): Promise<void> {
    const entries = await commands.getLogEntries({});
    let result = await pickCommitAsShowCommitDetailsRunnable(
        CommitSources.Repo,
        entries,
        commands
    );
    while (result) {
        result = await result.run();
    }
}

export async function presentCommit(
    commands: InteractionAPI,
    checkin: ZitCheckin
): Promise<void> {
    const details = await commands.getCommitDetails(checkin);
    const close = asBackItem(localize('timeline', 'timeline'), () =>
        Promise.resolve(undefined)
    );
    let result = await presentCommitDetails(details, close, commands);
    while (result) {
        result = await result.run();
    }
}

async function pickCommitAsShowCommitDetailsRunnable(
    source: CommitSources,
    entries: Commit[],
    commands: InteractionAPI,
    back?: RunnableQuickPickItem
): Promise<RunnableQuickPickItem | undefined> {
    const backhere = asBackItem(
        describeLogEntrySource(source).toLowerCase(),
        () =>
            pickCommitAsShowCommitDetailsRunnable(
                source,
                entries,
                commands,
                back
            )
    );
    const commitPickedActionFactory = (checkin: ZitCheckin) => async () => {
        const details = await commands.getCommitDetails(checkin);
        return presentCommitDetails(details, backhere, commands);
    };

    const choice = await pickCommit(
        source,
        entries,
        commitPickedActionFactory,
        back
    );
    return choice;
}

/**
 * Present user with a list of Commit[]s
 *
 * @param source represent commit source
 * @param commits the commits
 * @param action what to do when commit is selected
 * @param backItem optional "back" action
 * @returns
 */
export async function pickCommit(
    source: CommitSources,
    commits: Commit[],
    action: (commit: ZitCheckin) => RunnableAction,
    backItem?: RunnableQuickPickItem
): Promise<RunnableQuickPickItem | undefined> {
    const logEntryPickItems: RunnableQuickPickItem[] = commits.map(
        commit => new RunnableTimelineEntryItem(commit, action(commit.hash))
    );
    const current = new LiteralRunnableQuickPickItem(
        '$(tag) Current',
        '',
        'Current checkout',
        action('current')
    );
    logEntryPickItems.unshift(current);
    const placeHolder = describeLogEntrySource(source);
    const pickItems = backItem
        ? [backItem, ...logEntryPickItems]
        : logEntryPickItems;
    const choice = await window.showQuickPick(pickItems, {
        placeHolder,
        matchOnDescription: true,
        matchOnDetail: true,
    });

    return choice;
}

export async function pickCommitToCherrypick(
    logEntries: Commit[]
): Promise<ZitHash | undefined> {
    const logEntryPickItems = logEntries.map(
        entry => new TimelineEntryItem(entry)
    );
    const placeHolder = localize('cherrypick commit', 'Commit to cherrypick');
    const choice = await window.showQuickPick(logEntryPickItems, {
        placeHolder,
        matchOnDescription: true,
        matchOnDetail: true,
    });
    return choice?.commit.hash;
}

export async function pickStashItem(
    items: StashItem[],
    operation: 'show' | 'drop' | 'apply' | 'pop'
): Promise<StashID | undefined> {
    const stashItems = items.map(entry => new StashEntryItem(entry));
    const placeHolder = localize(
        `stash to ${operation}`,
        `Stash to ${operation}`
    );
    const item = await window.showQuickPick(stashItems, {
        placeHolder,
        matchOnDescription: true,
        matchOnDetail: true,
    });
    return item?.item.stashId;
}

/**
 * Use the selected commit in the `zit.log` command.
 */
async function presentCommitDetails(
    details: CommitDetails,
    back: RunnableQuickPickItem,
    commands: InteractionAPI
): Promise<RunnableQuickPickItem | undefined> {
    const placeHolder = describeCommitOneLine(details);
    const diff = (status: FileStatus) =>
        commands.diffToParent(status.path, details.hash, status.status);
    const filePickItems = details.files.map(
        f => new FileStatusQuickPickItem(f, () => diff(f))
    );
    const editCommitMessageItem = new LiteralRunnableQuickPickItem(
        '$(edit) Edit commit message',
        '',
        '',
        () => editCommitMessage(details, commands)
    );

    const openChngesItem = new LiteralRunnableQuickPickItem(
        '$(go-to-file) Open all changed files',
        '',
        '',
        async () => {
            for (const status of details.files) {
                await diff(status);
            }
        }
    );

    const changesLabel = {
        label: 'Changes',
        kind: QuickPickItemKind.Separator,
    } as const;

    const items = [
        back,
        editCommitMessageItem,
        openChngesItem,
        changesLabel,
        ...filePickItems,
    ] satisfies (
        RunnableQuickPickItem | { kind: QuickPickItemKind.Separator }
    )[];

    const choice = await window.showQuickPick(items, {
        matchOnDescription: true,
        matchOnDetail: true,
        placeHolder,
    });

    return choice as RunnableQuickPickItem;
}

async function editCommitMessage(
    commitDetails: CommitDetails,
    interactionAPI: InteractionAPI
): Promise<void> {
    const newCommitMessage = await inputCommitMessage(commitDetails.message);
    if (
        newCommitMessage === undefined ||
        newCommitMessage == commitDetails.message
    ) {
        return;
    }
    await interactionAPI.updateCommitMessage(
        commitDetails.hash,
        newCommitMessage
    );
    window.showInformationMessage(
        localize('updated message', 'Commit message was updated.')
    );
}

export async function pickDiffAction(
    commits: Commit[],
    diffAction: (to: ZitHash | ZitSpecialTags | undefined) => RunnableAction,
    backAction: RunnableAction
): Promise<void> {
    const items = [
        new LiteralRunnableQuickPickItem(
            '$(circle-outline) Parent',
            '',
            'Show what this commit changed',
            diffAction('parent')
        ),
        new LiteralRunnableQuickPickItem(
            '$(tag) Current',
            'special Zit tag',
            'Show difference with the current checked-out version ',
            diffAction('current')
        ),
        new LiteralRunnableQuickPickItem(
            '$(tag) Tip',
            'special Zit tag',
            'Show difference with the most recent check-in',
            diffAction('tip')
        ),
        new LiteralRunnableQuickPickItem(
            '$(circle-outline) Checkout',
            '',
            'Show differences with checkout',
            diffAction(undefined)
        ),
        new LiteralRunnableQuickPickItem(
            `$(arrow-left)  Go back`,
            '',
            'Select first commit',
            backAction
        ),
        {
            kind: QuickPickItemKind.Separator,
            label: '',
            run: () => {
                /* separator action */
            },
            description: '',
        } as RunnableQuickPickItem,
        ...commits.map(
            commit =>
                new RunnableTimelineEntryItem(commit, diffAction(commit.hash))
        ),
    ];
    const placeHolder = localize('compare with', 'Compare with');
    const choice = await window.showQuickPick(items, {
        placeHolder,
        matchOnDescription: true,
        matchOnDetail: true,
    });
    if (choice) {
        await choice.run();
    }
}
export async function inputRemoteUrl(
    defaultUrl?: ZitURI
): Promise<ZitURI | undefined> {
    const value = await window.showInputBox({
        prompt: localize('remote URL', 'Remote URL'),
        value: defaultUrl?.toString() ?? lastUsedRepoUrl,
        ignoreFocusOut: true,
        validateInput: input => {
            let url: URL;
            try {
                url = new URL(input);
            } catch {
                return localize(
                    'remote protocol',
                    'Remote URL must use HTTP or HTTPS'
                );
            }
            if (url.protocol !== 'http:' && url.protocol !== 'https:') {
                return localize(
                    'remote protocol',
                    'Remote URL must use HTTP or HTTPS'
                );
            }
            if (url.username || url.password) {
                return localize(
                    'remote credentials',
                    'Do not put credentials in the remote URL'
                );
            }
            return undefined;
        },
    });
    if (!value) {
        return undefined;
    }
    lastUsedRepoUrl = value;
    return Uri.parse(value) as ZitURI;
}

export async function inputSyncCredentials(): Promise<
    SyncCredentials | null | undefined
> {
    const username = await window.showInputBox({
        prompt: localize(
            'sync username',
            'Remote username (leave empty for anonymous access)'
        ),
        value: lastUsedSyncUser,
        ignoreFocusOut: true,
    });
    if (username === undefined) {
        return undefined;
    }
    if (!username) {
        return null;
    }
    const password = await window.showInputBox({
        prompt: localize('sync password', 'Remote password'),
        password: true,
        ignoreFocusOut: true,
    });
    if (password === undefined) {
        return undefined;
    }
    lastUsedSyncUser = username;
    return {
        username: username as ZitUsername,
        password: password as ZitPassword,
    };
}

export async function confirmUndoOrRedo(
    command: 'undo' | 'redo'
): Promise<boolean> {
    const confirmText = command[0].toUpperCase() + command.slice(1);
    const choice = await window.showInformationMessage(
        localize(command, `${confirmText} the last working-tree operation?`),
        { modal: true },
        confirmText
    );
    return choice === confirmText;
}

export async function inputCommitMessage(
    defaultMessage?: ZitCommitMessage
): Promise<ZitCommitMessage | undefined> {
    return window.showInputBox({
        value: defaultMessage,
        placeHolder: localize('commit message', 'Commit message'),
        prompt: localize(
            'provide commit message',
            'Please provide a commit message'
        ),
        ignoreFocusOut: true,
    }) as Promise<ZitCommitMessage | undefined>;
}

export async function confirmDiscardAllChanges(
    this: void,
    where: string,
    groupCount: number
): Promise<boolean> {
    const message =
        groupCount === 1
            ? localize(
                  'confirm discard all',
                  'Are you sure you want to discard changes in {0} group?',
                  where
              )
            : localize(
                  'confirm discard all multiple groups',
                  'Are you sure you want to discard changes in {0} groups?',
                  where
              );
    const discard = localize('discard', '&&Discard Changes');
    const choice = await window.showWarningMessage(
        message,
        { modal: true },
        discard
    );
    return choice === discard;
}

export async function confirmMoveResourcesToTrash(
    this: void,
    paths: string[]
): Promise<boolean> {
    const message =
        paths.length === 1
            ? localize(
                  'confirm move to trash',
                  'Move {0} to the Trash?',
                  path.basename(paths[0])
              )
            : localize(
                  'confirm move multiple to trash',
                  'Move {0} untracked resources to the Trash?',
                  paths.length
              );
    const move = localize('move to trash', '&&Move to Trash');
    const choice = await window.showWarningMessage(
        message,
        { modal: true },
        move
    );
    return choice === move;
}

export async function confirmDiscardChanges(
    discardFilesnames: string[],
    addedFilenames: string[]
): Promise<boolean> {
    let addedMessage = '';
    if (addedFilenames.length > 0) {
        if (addedFilenames.length === 1) {
            addedMessage = localize(
                'and forget',
                "\n\n(and forget added file '{0}')",
                path.basename(addedFilenames[0])
            );
        } else {
            addedMessage = localize(
                'and forget multiple',
                '\n\n(and forget {0} other added files)',
                addedFilenames.length
            );
        }
    }

    let message: string;
    if (discardFilesnames.length === 1) {
        message = localize(
            'confirm discard',
            "Are you sure you want to discard changes to '{0}'?{1}",
            path.basename(discardFilesnames[0]),
            addedMessage
        );
    } else {
        const fileList = humanise.formatFilesAsBulletedList(discardFilesnames);
        message = localize(
            'confirm discard multiple',
            'Are you sure you want to discard changes to {0} files?\n\n{1}{2}',
            discardFilesnames.length,
            fileList,
            addedMessage
        );
    }

    const discard = localize('discard', '&&Discard Changes');
    const choice = await window.showWarningMessage(
        message,
        { modal: true },
        discard
    );
    return choice === discard;
}

export async function confirmGitExport(): Promise<boolean> {
    const fromConfig = typedConfig.gitExport;
    if (fromConfig == 'Automatically') {
        return true;
    } else if (fromConfig == 'Never') {
        return false;
    }

    const answer = await window.showInformationMessage(
        'Export repository to git?',
        'Yes',
        'No',
        'Automatically',
        'Never'
    );
    if (answer == 'Yes') {
        return true;
    }
    if (!answer || answer == 'No') {
        return false;
    }
    await typedConfig.setGitExport(answer);
    return answer == 'Automatically';
}

abstract class RunnableQuickPickItem implements QuickPickItem {
    abstract get label(): string;
    abstract run(): RunnableReturnType;
}

class TimelineEntryItem extends RunnableQuickPickItem {
    constructor(public commit: Commit) {
        super();
    }
    protected get age(): string {
        return humanise.ageFromNow(this.commit.date);
    }
    get label(): string {
        const hash = this.commit.hash.slice(0, SHORT_HASH_LENGTH);
        return `$(circle-outline) ${hash} • ${this.commit.branch}`;
    }
    get description(): string {
        return `$(person)${this.commit.author} $(calendar) ${this.age}`;
    }
    get detail(): string {
        return this.commit.message;
    }
    run() {
        // do nothing.
    }
}

class StashEntryItem implements QuickPickItem {
    constructor(public item: StashItem) {}
    get label(): string {
        const hash = this.item.hash.slice(0, SHORT_HASH_LENGTH);
        return `$(circle-outline) ${this.item.stashId} • ${hash}`;
    }
    get description(): string {
        const files = `${this.item.fileCount} file(s)`;
        return this.item.date
            ? `${files} • $(calendar) ${humanise.ageFromNow(this.item.date)}`
            : files;
    }
    get detail(): string {
        return this.item.comment;
    }
}

class RunnableTimelineEntryItem extends TimelineEntryItem {
    constructor(
        commit: Commit,
        private action: RunnableAction
    ) {
        super(commit);
    }
    override run() {
        return this.action();
    }
}

class CheckinItem<T extends ZitCheckin> {
    constructor(public readonly checkin: T) {}
}

class BranchItem extends CheckinItem<ZitBranch> implements QuickPickItem {
    get label(): string {
        return `$(git-branch) ${this.checkin}`;
    }
    get description(): string {
        return [
            ...(this.branch.isCurrent ? ['current'] : []),
            ...(this.branch.isClosed ? ['closed'] : []),
        ].join(', ');
    }
    constructor(private branch: BranchDetails) {
        super(branch.name);
    }
}

class TagItem extends CheckinItem<ZitTag> implements QuickPickItem {
    get label(): string {
        return `$(tag) ${this.checkin}`;
    }
}

class FileStatusQuickPickItem extends RunnableQuickPickItem {
    get basename(): string {
        return path.basename(this.status.path);
    }
    get label(): string {
        return `    ${this.icon}  ${this.basename}`;
    }
    get description(): string {
        return path.dirname(this.status.path);
    }
    get icon(): string {
        return (
            {
                [ResourceStatus.ADDED]: 'A', // $(diff-added)
                [ResourceStatus.EXTRA]: 'A', // $(diff-added)
                [ResourceStatus.MODIFIED]: 'M', // $(diff-modified)
                [ResourceStatus.DELETED]: 'R', // $(diff-removed)
                [ResourceStatus.MISSING]: 'R', // $(diff-removed)
            }[this.status.status] ?? ''
        );
    }

    constructor(
        private readonly status: FileStatus,
        private readonly action: RunnableAction
    ) {
        super();
    }

    async run(): Promise<void> {
        return this.action();
    }
}

/**
 * Simplest possible `RunnableQuickPickItem`
 */
class LiteralRunnableQuickPickItem extends RunnableQuickPickItem {
    constructor(
        public readonly label: string,
        public readonly description: string,
        public readonly detail: string,
        private _action: RunnableAction
    ) {
        super();
    }

    run(): RunnableReturnType {
        return this._action();
    }
}

class UserInputItem extends RunnableQuickPickItem implements QuickPickItem {
    readonly alwaysShow = true;
    readonly label = '$(pencil) Checkout by hash';

    async run(): Promise<CheckinItem<ZitCheckin> | undefined> {
        const userInput = await inputCommon<ZitCheckin>(
            'commit hash',
            'Enter hash/check-in/tag to update to',
            { placeHolder: 'hash/check-in/tag' }
        );
        if (userInput) {
            return new CheckinItem(userInput);
        }
        return;
    }
}

type RunnableReturnType = Promise<any> | void;
export type RunnableAction = () => RunnableReturnType;
export interface InteractionAPI {
    get currentBranch(): ZitBranch | undefined;
    getCommitDetails(revision: ZitCheckin): Promise<CommitDetails>;
    getLogEntries(options: LogEntriesOptions): Promise<Commit[]>;
    diffToParent(
        filePath: string,
        commit: ZitCheckin,
        status?: ResourceStatus
    ): Promise<void>;
    updateCommitMessage(
        hash: ZitHash,
        new_commit_message: ZitCommitMessage
    ): Promise<void>;
}
