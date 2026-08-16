import * as vscode from 'vscode';
import { Uri, window, workspace, commands } from 'vscode';
import * as sinon from 'sinon';
import {
    add,
    assertGroups,
    cleanupZit,
    fakeExecutionResult,
    fakeZitStatus,
    fakeRawExecutionResult,
    fakeStatusResult,
    getExecStub,
    getOpenedRepository,
    getRawExecStub,
    getRepository,
    statusBarCommands,
} from './common';
import * as assert from 'assert/strict';
import * as fs from 'fs/promises';
import {
    Commit,
    CommitDetails,
    ZitBranch,
    ZitCommitMessage,
    ZitCheckin,
    ZitClass,
    ZitHash,
    ZitUsername,
    OpenedRepository,
    RelativePath,
    ResourceStatus,
    StatusString,
} from '../../openedRepository';
import { CommandCenter } from '../../commands';
import { Suite } from 'mocha';
import { toZitEmptyUri, toZitUri } from '../../uri';
import { ZitFileSystemProvider } from '../../fileSystemProvider';
import type {
    Model,
    ModelChangeEvent,
    OriginalResourceChangeEvent,
} from '../../model';
import { delay } from '../../util';
import { Reason } from '../../zitExecutable';

declare module 'mocha' {
    interface Context {
        sandbox: sinon.SinonSandbox;
        workspaceUri: vscode.Uri;
    }
}

export function StatusSuite(this: Suite): void {
    test('Missing is visible in Source Control panel', async () => {
        const filename = 'smiviscp.txt';
        const path = await add(
            'smiviscp.txt',
            'test\n',
            `added  ${filename}\n`
        );
        await fs.unlink(path.fsPath);
        const repository = getRepository();
        await repository.updateStatus('Test' as Reason);
        assertGroups(repository, {
            working: [[path.fsPath, ResourceStatus.MISSING]],
        });
        await cleanupZit(repository);
    }).timeout(5000);

    test('Rename is visible in Source Control panel', async () => {
        const repository = getRepository();
        await cleanupZit(repository);
        const oldFilename = 'sriciscp-new.txt' as RelativePath;
        const newFilename = 'sriciscp-renamed.txt' as RelativePath;
        const oldUri = await add(oldFilename, 'test\n', `add ${oldFilename}`);
        await repository.updateStatus('Test' as Reason);
        assertGroups(repository, {});

        const openedRepository: OpenedRepository = (repository as any)
            .repository;

        await openedRepository.exec(['mv', oldFilename, newFilename]);
        await repository.updateStatus('Test' as Reason);
        const newPath = Uri.joinPath(oldUri, '..', newFilename).fsPath;
        assertGroups(repository, {
            added: [[newPath, ResourceStatus.ADDED]],
            working: [[oldUri.fsPath, ResourceStatus.DELETED]],
        });
        await openedRepository.exec(['mv', newFilename, oldFilename]);
        await repository.updateStatus('Test cleanup' as Reason);
        assertGroups(repository, {});
    }).timeout(15000);

    test('Pending merge is visible in Source Control panel', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        fakeZitStatus(
            execStub,
            'added bar-xa.txt\nedited foo-xa.txt\npending merge with ' +
                'a'.repeat(64)
        );
        const repository = getRepository();

        await repository.updateStatus('Test' as Reason);

        assert.equal(repository.zitStatus?.isMerge, true);
        assertGroups(repository, {
            added: [
                [
                    Uri.joinPath(this.ctx.workspaceUri, 'bar-xa.txt').fsPath,
                    ResourceStatus.ADDED,
                ],
            ],
            working: [
                [
                    Uri.joinPath(this.ctx.workspaceUri, 'foo-xa.txt').fsPath,
                    ResourceStatus.MODIFIED,
                ],
            ],
        });
    });

    test('Metadata and type changes use Zit status classes', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        fakeZitStatus(
            execStub,
            'edited executable\nedited status_unexec\nmissing not_file'
        );
        const repository = getRepository();

        await repository.updateStatus('Test' as Reason);

        assertGroups(repository, {
            working: [
                [
                    Uri.joinPath(this.ctx.workspaceUri, 'executable').fsPath,
                    ResourceStatus.MODIFIED,
                ],
                [
                    Uri.joinPath(this.ctx.workspaceUri, 'status_unexec').fsPath,
                    ResourceStatus.MODIFIED,
                ],
                [
                    Uri.joinPath(this.ctx.workspaceUri, 'not_file').fsPath,
                    ResourceStatus.MISSING,
                ],
            ],
        });
    });

    test('decodes brief-diff paths before status deduplication', () => {
        const parsed = getOpenedRepository().parseStatusString(
            (`On branch trunk (check-in ${'0'.repeat(64)})\n` +
                'edited spaced name.txt\n' +
                'edited folder/file.txt') as StatusString,
            '',
            'M spaced\\sname.txt\nM folder\\\\file.txt'
        );

        assert.deepEqual(
            parsed.statuses.map(file => [file.status, file.path]),
            [
                [ResourceStatus.MODIFIED, 'spaced name.txt'],
                [ResourceStatus.MODIFIED, 'folder/file.txt'],
            ]
        );
    });

    test('"Refresh" command refreshes all status surfaces', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        const status = fakeZitStatus(
            execStub,
            'added new.txt\nedited changed.txt\nmissing deleted.txt\n' +
                'extra refresh.txt',
            'A new.txt\nM changed.txt\nD deleted.txt'
        );

        await commands.executeCommand('zit.refresh');

        sinon.assert.calledThrice(execStub);
        sinon.assert.calledOnce(status);
        const repository = getRepository();
        assert.equal(repository.zitStatus?.branch, 'trunk');
        assert.equal(repository.zitStatus?.checkin, '0'.repeat(64));
        assert.equal(repository.zitStatus?.isMerge, false);
        assertGroups(repository, {
            added: [
                [
                    Uri.joinPath(this.ctx.workspaceUri, 'new.txt').fsPath,
                    ResourceStatus.ADDED,
                ],
            ],
            working: [
                [
                    Uri.joinPath(this.ctx.workspaceUri, 'changed.txt').fsPath,
                    ResourceStatus.MODIFIED,
                ],
                [
                    Uri.joinPath(this.ctx.workspaceUri, 'deleted.txt').fsPath,
                    ResourceStatus.MISSING,
                ],
            ],
            untracked: [
                [
                    Uri.joinPath(this.ctx.workspaceUri, 'refresh.txt').fsPath,
                    ResourceStatus.EXTRA,
                ],
            ],
        });

        status.resolves(fakeStatusResult(''));
        execStub
            .withArgs(['extras'])
            .resolves(fakeExecutionResult({ stdout: '' }));
        execStub
            .withArgs(['diff', '--brief'])
            .resolves(fakeExecutionResult({ stdout: '' }));
        await commands.executeCommand('zit.refresh');
        assertGroups(getRepository(), {});
    });

    test('Rejects status output without a branch header', () => {
        assert.throws(
            () => getOpenedRepository().parseStatusString('' as StatusString),
            /missing branch/
        );
    });

    test('Repository selection uses direct matches and the model picker', async () => {
        const repository = getRepository();
        const getRepositoryForArg = this.ctx.sandbox.stub();
        getRepositoryForArg.onFirstCall().returns(repository);
        getRepositoryForArg.onSecondCall().returns(undefined);
        const pickRepository = this.ctx.sandbox.stub().resolves(undefined);
        const model = {
            getRepository: getRepositoryForArg,
            repositories: [repository, {}],
            pickRepository,
        } as unknown as Model;
        const commandCenter = Object.assign(
            Object.create(CommandCenter.prototype),
            { model }
        ) as CommandCenter;
        const uri = Uri.file('/tmp/repository-selection.txt');

        assert.equal(await commandCenter.guessRepository(uri), repository);
        assert.equal(await commandCenter.guessRepository(uri), undefined);
        sinon.assert.calledOnce(pickRepository);
    });

    test('Status failures propagate through model updates', async () => {
        const repository = getRepository();
        const execStub = getExecStub(this.ctx.sandbox);
        const failure = fakeExecutionResult({
            exitCode: 1,
            stderr: 'zit status: repository unavailable\n',
        });
        execStub.withArgs(['status']).resolves(failure);
        execStub
            .withArgs(['extras'])
            .resolves(fakeExecutionResult({ stdout: '' }));
        execStub
            .withArgs(['diff', '--brief'])
            .resolves(fakeExecutionResult({ stdout: '' }));

        assert.equal(
            await repository.updateStatus('Expected status failure' as Reason),
            failure
        );
        await assert.rejects(
            repository.updateModelState(
                { status: true },
                'Expected model failure' as Reason
            ),
            /repository unavailable/
        );
    });
    test('Status failures fall back to spawn and generic diagnostics', async () => {
        const repository = getRepository();
        const execStub = getExecStub(this.ctx.sandbox);
        const status = execStub.withArgs(['status']);
        execStub
            .withArgs(['extras'])
            .resolves(fakeExecutionResult({ stdout: '' }));
        execStub
            .withArgs(['diff', '--brief'])
            .resolves(fakeExecutionResult({ stdout: '' }));
        const spawnFailure = Object.assign(
            fakeExecutionResult({ exitCode: 1 }),
            { spawnFailure: new Error('spawn unavailable') }
        );
        status.resolves(spawnFailure);

        await assert.rejects(
            repository.updateModelState(
                { status: true },
                'Spawn model failure' as Reason
            ),
            /spawn unavailable/
        );

        status.resolves(fakeExecutionResult({ exitCode: 1 }));
        await assert.rejects(
            repository.updateModelState(
                { status: true },
                'Generic model failure' as Reason
            ),
            /zit status failed/
        );
    });

    test('Refresh accepts an explicitly supplied repository', async () => {
        const repository = getRepository();
        const refresh = this.ctx.sandbox.stub(repository, 'refresh').resolves();

        await commands.executeCommand('zit.refresh', repository);

        sinon.assert.calledOnce(refresh);
    });

    test('Branch change is reflected in status bar', async () => {
        const repository = getRepository();
        const branchName = 'statusbar1' as ZitBranch;
        const commitMessage = 'Create statusbar1 branch' as ZitCommitMessage;
        const execStub = getExecStub(this.ctx.sandbox);
        const status = execStub
            .withArgs(['status'])
            .resolves(fakeStatusResult(''));
        status
            .onFirstCall()
            .resolves(fakeStatusResult('edited branch-status.txt'));
        status.onSecondCall().resolves(
            fakeExecutionResult({
                stdout:
                    `On branch ${branchName} (check-in ${'a'.repeat(64)})\n` +
                    'nothing to report\n',
            })
        );
        const diff = execStub
            .withArgs(['diff', '--brief'])
            .resolves(fakeExecutionResult());
        diff.onFirstCall().resolves(
            fakeExecutionResult({ stdout: 'M branch-status.txt\n' })
        );
        execStub.withArgs(['extras']).resolves(fakeExecutionResult());
        await repository.updateStatus('Test: branch command setup' as Reason);

        assert.equal(statusBarCommands()[0].title, '$(git-branch) trunk+');

        this.ctx.sandbox.stub(window, 'showInputBox').resolves(branchName);
        repository.sourceControl.inputBox.value = commitMessage;
        const branchCreation = execStub
            .withArgs(['commit', '--branch', branchName, '-m', commitMessage])
            .resolves(fakeExecutionResult());

        await commands.executeCommand('zit.branch');

        sinon.assert.calledOnceWithExactly(branchCreation, [
            'commit',
            '--branch',
            branchName,
            '-m',
            commitMessage,
        ]);
        assert.equal(
            statusBarCommands()[0].title,
            `$(git-branch) ${branchName}`
        );

        const branchSwitch = execStub
            .withArgs(['update', 'trunk' as ZitBranch])
            .resolves(fakeExecutionResult());

        await getOpenedRepository().update('trunk' as ZitBranch);
        await repository.updateStatus('Test: switched to trunk' as Reason);
        sinon.assert.calledOnceWithExactly(
            branchSwitch,
            ['update', 'trunk' as ZitBranch],
            undefined
        );
        assert.equal(statusBarCommands()[0].title, '$(git-branch) trunk');
        repository.sourceControl.inputBox.value = '';
    }).timeout(20000);
}

export function CleanSuite(this: Suite): void {
    test('Clean previews then force-deletes untracked files', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        const preview = execStub.withArgs(['clean', '--dry-run']).resolves(
            fakeExecutionResult({
                stdout: 'a.txt\nb.txt\n',
            })
        );
        const force = execStub
            .withArgs(['clean', '--force'])
            .resolves(fakeExecutionResult());
        const warning = this.ctx.sandbox.stub(
            window,
            'showWarningMessage'
        ) as sinon.SinonStub;
        warning.resolves('&&Delete Files');

        await commands.executeCommand('zit.clean');

        sinon.assert.calledOnceWithExactly(preview, ['clean', '--dry-run']);
        sinon.assert.calledOnceWithExactly(
            warning,
            'Are you sure you want to DELETE 2 files?\nThis is IRREVERSIBLE!\nThese files will be FOREVER LOST if you proceed.',
            { modal: true },
            '&&Delete Files'
        );
        sinon.assert.calledOnceWithExactly(force, ['clean', '--force']);
    });

    test('Canceling clean leaves untracked files untouched', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        execStub
            .withArgs(['clean', '--dry-run'])
            .resolves(fakeExecutionResult({ stdout: 'a.txt\n' }));
        const force = execStub.withArgs(['clean', '--force']);
        this.ctx.sandbox.stub(window, 'showWarningMessage').resolves(undefined);

        await commands.executeCommand('zit.clean');

        sinon.assert.notCalled(force);
    });

    test('Clean stops when preview fails', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        const preview = execStub.withArgs(['clean', '--dry-run']).resolves(
            fakeExecutionResult({
                exitCode: 1,
                stderr: 'zit clean: preview failed\n',
            })
        );
        const force = execStub.withArgs(['clean', '--force']);
        const warning = this.ctx.sandbox.stub(window, 'showWarningMessage');

        await commands.executeCommand('zit.clean');

        sinon.assert.calledOnce(preview);
        sinon.assert.notCalled(warning);
        sinon.assert.notCalled(force);
    });

    test('Clean does nothing when the preview is empty', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        execStub
            .withArgs(['clean', '--dry-run'])
            .resolves(fakeExecutionResult({ stdout: '' }));
        const force = execStub.withArgs(['clean', '--force']);
        const warning = this.ctx.sandbox.stub(window, 'showWarningMessage');

        await commands.executeCommand('zit.clean');

        sinon.assert.notCalled(warning);
        sinon.assert.notCalled(force);
    });
}

export function FileSystemSuite(this: Suite): void {
    test('Open document', async () => {
        const cat = getRawExecStub(this.ctx.sandbox)
            .withArgs(sinon.match.array.startsWith(['cat']))
            .resolves(fakeRawExecutionResult({ stdout: 'document text\n' }));
        const checkin = 'a'.repeat(64) as ZitCheckin;
        const uri = Uri.joinPath(this.ctx.workspaceUri, 'test.txt');
        const zitUri = toZitUri(uri, checkin);
        const document = await workspace.openTextDocument(zitUri);
        sinon.assert.calledOnceWithExactly(
            cat,
            ['cat', 'test.txt' as RelativePath, checkin],
            { cwd: sinon.match.string }
        );
        assert.equal(document.getText(), 'document text\n');
        const empty = await workspace.openTextDocument(toZitEmptyUri(uri));
        assert.equal(empty.getText(), '');
    });

    test('emits and expires observable historical file changes', async () => {
        const sandbox = this.ctx.sandbox;
        const repositoryChanges = new vscode.EventEmitter<ModelChangeEvent>();
        let focused = true;
        const windowStateChanges =
            new vscode.EventEmitter<vscode.WindowState>();
        const windowState = sandbox
            .stub(window, 'state')
            .get(() => ({ active: true, focused }));
        const onDidChangeWindowState = sandbox
            .stub(window, 'onDidChangeWindowState')
            .value(windowStateChanges.event);
        const originalChanges =
            new vscode.EventEmitter<OriginalResourceChangeEvent>();
        const registration = { dispose: sandbox.stub() };
        sandbox
            .stub(workspace, 'registerFileSystemProvider')
            .returns(registration);

        const root = this.ctx.workspaceUri.fsPath;
        const cat = sandbox.stub();
        const repository = { root, cat };
        const getRepository = sandbox
            .stub()
            .callsFake((uri: Uri) =>
                uri.fsPath.startsWith(root) ? repository : undefined
            );
        const model = {
            isInitialized: Promise.resolve(),
            getRepository,
            onDidChangeRepository: repositoryChanges.event,
            onDidChangeOriginalResource: originalChanges.event,
        } as unknown as Model;
        const provider = new ZitFileSystemProvider(model);
        const events: vscode.FileChangeEvent[] = [];
        const listener = provider.onDidChangeFile(changes =>
            events.push(...changes)
        );
        const source = Uri.joinPath(
            this.ctx.workspaceUri,
            'provider-cache.txt'
        );
        const checkin = 'b'.repeat(64) as ZitCheckin;
        const historical = toZitUri(source, checkin);
        await fs.writeFile(source.fsPath, 'working bytes');
        await workspace.openTextDocument(source);

        cat.onFirstCall().resolves(Buffer.from('historical bytes'));
        assert.deepEqual(
            await provider.readFile(historical),
            new Uint8Array(Buffer.from('historical bytes'))
        );
        assert.equal(
            (await provider.stat(historical)).type,
            vscode.FileType.File
        );
        provider.watch().dispose();
        assert.throws(() => provider.readDirectory());
        assert.throws(() => provider.createDirectory());
        assert.throws(() => provider.writeFile());
        assert.throws(() => provider.delete());
        assert.throws(() => provider.rename());

        originalChanges.fire({
            repository,
            uri: Uri.parse('untitled:ignored'),
        } as unknown as OriginalResourceChangeEvent);
        assert.equal(events.length, 0);
        originalChanges.fire({
            repository,
            uri: source,
        } as unknown as OriginalResourceChangeEvent);
        assert.equal(events.length, 1);
        assert.equal(events[0].uri.scheme, 'zit');
        events.length = 0;

        repositoryChanges.fire({
            repository,
            uri: this.ctx.workspaceUri,
        } as unknown as ModelChangeEvent);
        await delay(1200);
        assert.deepEqual(
            events.map(event => event.uri.toString()),
            [historical.toString()]
        );
        events.length = 0;
        repositoryChanges.fire({
            repository,
            uri: source,
        } as unknown as ModelChangeEvent);
        await delay(1200);
        assert.deepEqual(
            events.map(event => event.uri.toString()),
            [historical.toString()]
        );
        focused = false;
        events.length = 0;
        repositoryChanges.fire({
            repository,
            uri: this.ctx.workspaceUri,
        } as unknown as ModelChangeEvent);
        await delay(1200);
        assert.equal(events.length, 0);
        focused = true;
        windowStateChanges.fire({ active: true, focused: true });
        await delay(0);
        assert.deepEqual(
            events.map(event => event.uri.toString()),
            [historical.toString()]
        );

        const outside = toZitUri(
            Uri.file('/tmp/outside-zit-provider.txt'),
            checkin
        );
        await assert.rejects(provider.stat(outside));
        await assert.rejects(provider.readFile(outside));
        const missing = toZitUri(
            Uri.joinPath(this.ctx.workspaceUri, 'missing-history.txt'),
            checkin
        );
        cat.onSecondCall().resolves(undefined);
        await assert.rejects(provider.readFile(missing));

        const internal = provider as unknown as {
            cache: Map<string, { uri: Uri; timestamp: number }>;
            cleanup(): void;
        };
        const fakeZitUri = (fsPath: string, key: string) =>
            ({
                fsPath,
                path: fsPath,
                scheme: 'zit',
                query: JSON.stringify({ path: fsPath, checkin }),
                toString: () => key,
            }) as unknown as Uri;
        const equal = fakeZitUri('/exact-root', 'equal');
        internal.cache.set('equal', {
            uri: equal,
            timestamp: Date.now(),
        });
        events.length = 0;
        repositoryChanges.fire({
            repository: { root: '/exact-root' },
            uri: Uri.file('/exact-root'),
        } as unknown as ModelChangeEvent);
        await delay(1200);
        assert.equal(
            events.some(event => event.uri === equal),
            true
        );
        internal.cache.delete('equal');

        const windows = fakeZitUri('c:\\repo/file.txt', 'windows');
        internal.cache.set('windows', {
            uri: windows,
            timestamp: Date.now(),
        });
        events.length = 0;
        repositoryChanges.fire({
            repository: { root: 'C:\\REPO/' },
            uri: Uri.file('/'),
        } as unknown as ModelChangeEvent);
        await delay(1200);
        assert.equal(
            events.some(event => event.uri === windows),
            true
        );
        internal.cache.delete('windows');

        const windowsOpen = fakeZitUri('C:\\Repo\\File.txt', 'windows-open');
        internal.cache.set('windows-open', {
            uri: windowsOpen,
            timestamp: 0,
        });
        const textDocuments = sandbox.stub(workspace, 'textDocuments').value([
            {
                uri: {
                    scheme: 'file',
                    fsPath: 'c:\\repo\\file.txt',
                },
            } as vscode.TextDocument,
        ]);
        internal.cleanup();
        assert.equal(internal.cache.has('windows-open'), true);
        textDocuments.restore();
        internal.cache.delete('windows-open');
        internal.cleanup();
        events.length = 0;
        repositoryChanges.fire({
            repository,
            uri: this.ctx.workspaceUri,
        } as unknown as ModelChangeEvent);
        await delay(1200);
        assert.deepEqual(
            new Set(events.map(event => event.uri.toString())),
            new Set([historical.toString(), missing.toString()])
        );

        for (const row of internal.cache.values()) {
            row.timestamp = 0;
        }
        internal.cleanup();
        events.length = 0;
        repositoryChanges.fire({
            repository,
            uri: this.ctx.workspaceUri,
        } as unknown as ModelChangeEvent);
        await delay(1200);
        assert.deepEqual(
            events.map(event => event.uri.toString()),
            [historical.toString()]
        );

        listener.dispose();
        provider.dispose();
        onDidChangeWindowState.restore();
        windowState.restore();
        windowStateChanges.dispose();
        sinon.assert.calledOnce(registration.dispose);
        repositoryChanges.dispose();
        await fs.rm(source.fsPath, { force: true });
        await commands.executeCommand('workbench.action.closeAllEditors');
        originalChanges.dispose();
    }).timeout(15000);
}

export function DiffSuite(this: Suite): void {
    test('Open File From Uri (Nothing)', async () => {
        await commands.executeCommand('zit.openFileFromUri');
    });

    test('Open File From Uri (non existing zit path)', async () => {
        const uri = Uri.from({ scheme: 'zit', path: 'nowhere' });
        await commands.executeCommand('zit.openFileFromUri', uri);
    });

    test('Open File From Uri (existing zit path)', async () => {
        const repository = getRepository();
        const uri = Uri.joinPath(this.ctx.workspaceUri, 'a_path.txt');
        const execStub = getExecStub(this.ctx.sandbox);
        const statusCall = fakeZitStatus(execStub, 'added a_path.txt');
        await repository.updateStatus('Test' as Reason);
        sinon.assert.calledOnce(statusCall);

        const testTd = { isUntitled: false } as vscode.TextDocument;
        const otd = this.ctx.sandbox
            .stub(workspace, 'openTextDocument')
            .resolves(testTd);
        const std = this.ctx.sandbox
            .stub(window, 'showTextDocument')
            .resolves();
        await commands.executeCommand('zit.openFileFromUri', uri);
        sinon.assert.calledOnceWithExactly(
            otd,
            sinon.match({ path: uri.fsPath })
        );
        sinon.assert.calledOnceWithExactly(
            std,
            testTd as any,
            {
                preview: true,
                preserveFocus: true,
                viewColumn: vscode.ViewColumn.Active,
            } as vscode.TextDocumentShowOptions
        );
    });

    test('Open Change From Uri (Nothing)', async () => {
        await commands.executeCommand('zit.openChangeFromUri');
    });

    test('Open Change (Nothing)', async () => {
        const restoreOutput =
            window.activeTextEditor?.document.uri.scheme === 'output';
        await commands.executeCommand('workbench.action.closePanel');
        await commands.executeCommand('workbench.action.closeAllEditors');
        try {
            assert.equal(window.activeTextEditor, undefined);
            await commands.executeCommand('zit.openChange');
        } finally {
            if (restoreOutput) {
                await commands.executeCommand(
                    'workbench.action.output.toggleOutput'
                );
            }
        }
    });
    test('History commands guard absent editors and resources', async () => {
        await commands.executeCommand('workbench.action.closePanel');
        await commands.executeCommand('workbench.action.closeAllEditors');
        assert.equal(window.activeTextEditor, undefined);
        const showQuickPick = this.ctx.sandbox.stub(window, 'showQuickPick');
        const applyEdit = this.ctx.sandbox.stub(workspace, 'applyEdit');
        const registerHoverProvider = this.ctx.sandbox.stub(
            vscode.languages,
            'registerHoverProvider'
        );
        const showTextDocument = this.ctx.sandbox.stub(
            window,
            'showTextDocument'
        );
        try {
            const outside = Uri.file('/tmp/outside-zit-history.txt');
            await commands.executeCommand('zit.fileLog', outside);
            await commands.executeCommand('zit.revertChange', outside, [], 0);
            await commands.executeCommand('zit.annotate');
            await commands.executeCommand('zit.openFileFromUri');
            await commands.executeCommand(
                'zit.openFileFromUri',
                Uri.from({
                    scheme: 'zit',
                    path: '/malformed-history-uri',
                    query: 'not-json',
                })
            );
            await commands.executeCommand('zit.openChangeFromUri');
            await commands.executeCommand('zit.openResource');

            sinon.assert.notCalled(showQuickPick);
            sinon.assert.notCalled(applyEdit);
            sinon.assert.notCalled(registerHoverProvider);
            sinon.assert.notCalled(showTextDocument);
        } finally {
            showQuickPick.restore();
            applyEdit.restore();
            registerHoverProvider.restore();
            showTextDocument.restore();
        }
    });

    test('Deleted file history compares an empty source to its primary parent', async () => {
        const repository = getRepository();
        const uri = Uri.joinPath(this.ctx.workspaceUri, 'deleted-history.txt');
        const checkin = 'd'.repeat(64) as ZitHash;
        const parent = 'e'.repeat(64) as ZitHash;
        const commit: Commit = {
            author: 'user' as ZitUsername,
            branch: 'trunk' as ZitBranch,
            date: new Date('2026-08-15T17:26:35Z'),
            hash: checkin,
            message: 'delete file' as ZitCommitMessage,
        };
        const details: CommitDetails = {
            ...commit,
            files: [
                {
                    klass: 'EDITED' as ZitClass,
                    path: 'deleted-history.txt' as RelativePath,
                    status: ResourceStatus.DELETED,
                },
            ],
        };
        this.ctx.sandbox.stub(repository, 'getLogEntries').resolves([commit]);
        this.ctx.sandbox.stub(repository, 'getCommitDetails').resolves(details);
        const getInfo = this.ctx.sandbox.stub(
            repository,
            'getInfo'
        ) as sinon.SinonStub;
        getInfo.withArgs(checkin, 'hash').resolves(checkin);
        getInfo.withArgs(checkin, 'parent').resolves(parent);
        const showQuickPick = this.ctx.sandbox.stub(window, 'showQuickPick');
        showQuickPick.onFirstCall().callsFake(items => {
            assert.ok(items instanceof Array);
            return Promise.resolve(items[1]);
        });
        showQuickPick.onSecondCall().callsFake(items => {
            assert.ok(items instanceof Array);
            return Promise.resolve(items[0]);
        });
        const diffCommand = this.ctx.sandbox
            .stub(commands, 'executeCommand')
            .callThrough()
            .withArgs('vscode.diff')
            .resolves();

        await commands.executeCommand('zit.fileLog', uri);

        sinon.assert.calledOnceWithExactly(
            diffCommand,
            'vscode.diff',
            toZitEmptyUri(uri),
            toZitUri(uri, parent),
            `deleted-history.txt (empty vs. ${parent.slice(0, 12)})`
        );
    });

    test('Root file history compares the check-in to an empty parent', async () => {
        const repository = getRepository();
        const uri = Uri.joinPath(this.ctx.workspaceUri, 'root-history.txt');
        const checkin = 'f'.repeat(64) as ZitHash;
        const commit: Commit = {
            author: 'root-user' as ZitUsername,
            branch: 'trunk' as ZitBranch,
            date: new Date('2026-08-15T17:26:35Z'),
            hash: checkin,
            message: 'root file' as ZitCommitMessage,
        };
        const details: CommitDetails = {
            ...commit,
            files: [
                {
                    klass: 'EDITED' as ZitClass,
                    path: 'root-history.txt' as RelativePath,
                    status: ResourceStatus.MODIFIED,
                },
            ],
        };
        this.ctx.sandbox.stub(repository, 'getLogEntries').resolves([commit]);
        this.ctx.sandbox.stub(repository, 'getCommitDetails').resolves(details);
        const getInfo = this.ctx.sandbox.stub(
            repository,
            'getInfo'
        ) as sinon.SinonStub;
        getInfo.withArgs(checkin, 'hash').resolves(checkin);
        getInfo.withArgs(checkin, 'parent').resolves(undefined);
        const showQuickPick = this.ctx.sandbox.stub(window, 'showQuickPick');
        showQuickPick.onFirstCall().callsFake(items => {
            assert.ok(items instanceof Array);
            return Promise.resolve(items[1]);
        });
        showQuickPick.onSecondCall().callsFake(items => {
            assert.ok(items instanceof Array);
            return Promise.resolve(items[0]);
        });
        const diffCommand = this.ctx.sandbox
            .stub(commands, 'executeCommand')
            .callThrough()
            .withArgs('vscode.diff')
            .resolves();
        this.ctx.sandbox.stub(window, 'activeTextEditor').value({
            document: { uri },
        } as vscode.TextEditor);

        await commands.executeCommand('zit.fileLog');

        sinon.assert.calledOnceWithExactly(
            diffCommand,
            'vscode.diff',
            toZitUri(uri, checkin),
            toZitEmptyUri(uri),
            `root-history.txt (${checkin.slice(0, 12)} vs. empty)`
        );
    });
}
