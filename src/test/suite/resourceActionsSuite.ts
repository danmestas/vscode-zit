import {
    Uri,
    workspace,
    window,
    commands,
    ViewColumn,
    TextDocument,
    TextDocumentShowOptions,
    EventEmitter,
} from 'vscode';
import * as sinon from 'sinon';
import { Reason } from '../../zitExecutable';
import typedConfig from '../../config';
import {
    assertGroups,
    cleanupZit,
    fakeExecutionResult,
    fakeZitStatus,
    getExecStub,
    getOpenedRepository,
    getRepository,
} from './common';
import * as assert from 'assert/strict';
import * as fs from 'fs/promises';
import { Suite } from 'mocha';
import {
    MergeAction,
    RelativePath,
    ResourceStatus,
    ZitCheckin,
    ZitClass,
} from '../../openedRepository';
import { Repository, RepositoryState, ZitResource } from '../../repository';
import { toZitUri } from '../../uri';
import * as interaction from '../../interaction';

async function documentWasShown(
    sandbox: sinon.SinonSandbox,
    urlMatch: string | sinon.SinonMatcher,
    showMatch: any[],
    body: () => Thenable<void>
) {
    const openTextDocument = sandbox.stub(
        workspace,
        'openTextDocument'
    ) as sinon.SinonStub;
    openTextDocument.resolves(42);

    const showTextDocument = (
        sandbox.stub(window, 'showTextDocument') as sinon.SinonStub
    ).resolves();

    await body();

    sinon.assert.calledOnceWithExactly(openTextDocument, urlMatch);
    sinon.assert.calledOnceWithExactly(showTextDocument, 42, ...showMatch);

    openTextDocument.restore();
    showTextDocument.restore();
}

export function resourceActionsSuite(this: Suite): void {
    const rootUri = this.ctx.workspaceUri;

    test('zit add nothing', async () => {
        await commands.executeCommand('zit.add');
    });

    test('zit add', async () => {
        const uri = Uri.joinPath(rootUri, 'add.txt');
        await fs.writeFile(uri.fsPath, 'zit_add');

        const repository = getRepository();
        await repository.updateStatus('Test' as Reason);
        const resource = repository.untrackedGroup.getResource(uri);
        assert.ok(resource);

        await commands.executeCommand('zit.add', resource);
        await repository.updateStatus('Test' as Reason);
        assert.ok(!repository.untrackedGroup.includesUri(uri));
        assert.ok(repository.addedGroup.includesUri(uri));
        await cleanupZit(repository);
    }).timeout(5000);

    test('zit add untracked', async () => {
        let execStub = getExecStub(this.ctx.sandbox);
        let statusStub = fakeZitStatus(execStub, 'extra a.txt\nextra b.txt');

        const repository = getRepository();
        await repository.updateStatus('Test' as Reason);
        sinon.assert.calledOnce(statusStub);
        assertGroups(repository, {
            untracked: [
                [Uri.joinPath(rootUri, 'a.txt').fsPath, ResourceStatus.EXTRA],
                [Uri.joinPath(rootUri, 'b.txt').fsPath, ResourceStatus.EXTRA],
            ],
        });
        execStub.restore();
        execStub = getExecStub(this.ctx.sandbox);
        statusStub = fakeZitStatus(execStub, 'added a.txt\nadded b.txt');
        const addStub = execStub
            .withArgs(sinon.match.array.startsWith(['add']))
            .resolves();
        await commands.executeCommand('zit.addAll');
        sinon.assert.calledOnce(statusStub);
        sinon.assert.calledOnceWithExactly(addStub, [
            'add',
            '--',
            'a.txt' as RelativePath,
            'b.txt' as RelativePath,
        ]);
        assertGroups(repository, {
            added: [
                [Uri.joinPath(rootUri, 'a.txt').fsPath, ResourceStatus.ADDED],
                [Uri.joinPath(rootUri, 'b.txt').fsPath, ResourceStatus.ADDED],
            ],
        });
    });

    test('zit add all leaves already-added files unchanged', async () => {
        const repository = getRepository();
        await cleanupZit(repository);
        const execStub = getExecStub(this.ctx.sandbox);
        const statusStub = fakeZitStatus(execStub, 'added a\nadded b');
        await repository.updateStatus('Test' as Reason);
        sinon.assert.calledOnce(statusStub);
        assertGroups(repository, {
            added: [
                [Uri.joinPath(rootUri, 'a').fsPath, ResourceStatus.ADDED],
                [Uri.joinPath(rootUri, 'b').fsPath, ResourceStatus.ADDED],
            ],
        });
        await commands.executeCommand('zit.addAll');
        sinon.assert.calledOnce(statusStub);
        assertGroups(repository, {
            added: [
                [Uri.joinPath(rootUri, 'a').fsPath, ResourceStatus.ADDED],
                [Uri.joinPath(rootUri, 'b').fsPath, ResourceStatus.ADDED],
            ],
        });
    });

    test('zit forget', async () => {
        const repository = getRepository();
        const execStub = getExecStub(this.ctx.sandbox);
        const forgetCallStub = execStub
            .withArgs(sinon.match.array.startsWith(['rm']))
            .resolves();
        fakeZitStatus(execStub, 'added a.txt\nedited b.txt\nextra c.txt');
        await repository.updateStatus('Test' as Reason);
        await commands.executeCommand(
            'zit.forget',
            ...repository.addedGroup.resourceStates,
            ...repository.workingGroup.resourceStates
        );
        sinon.assert.calledOnceWithMatch(forgetCallStub, [
            'rm',
            '--',
            'a.txt',
            'b.txt',
        ]);

        // better branch coverage
        await commands.executeCommand('zit.forget');
        assertGroups(repository, {
            added: [
                [Uri.joinPath(rootUri, 'a.txt').fsPath, ResourceStatus.ADDED],
            ],
            working: [
                [
                    Uri.joinPath(rootUri, 'b.txt').fsPath,
                    ResourceStatus.MODIFIED,
                ],
            ],
            untracked: [
                [Uri.joinPath(rootUri, 'c.txt').fsPath, ResourceStatus.EXTRA],
            ],
        });
        await commands.executeCommand(
            'zit.forget',
            ...repository.untrackedGroup.resourceStates
        );
    }).timeout(5000);

    test('Open files (nothing)', async () => {
        await commands.executeCommand('zit.openFiles');
    });

    test('Open files (group)', async () => {
        const repository = getRepository();
        const execStub = getExecStub(this.ctx.sandbox);
        fakeZitStatus(execStub, `added a\nadded b\n`);
        await repository.updateStatus('Test' as Reason);
        assertGroups(repository, {
            added: [
                [Uri.joinPath(rootUri, 'a').fsPath, ResourceStatus.ADDED],
                [Uri.joinPath(rootUri, 'b').fsPath, ResourceStatus.ADDED],
            ],
        });

        const testTd: TextDocument = { isUntitled: false } as TextDocument;
        const otd = this.ctx.sandbox
            .stub(workspace, 'openTextDocument')
            .resolves(testTd);
        const std = this.ctx.sandbox
            .stub(window, 'showTextDocument')
            .resolves();
        await commands.executeCommand('zit.openFiles', repository.addedGroup);
        sinon.assert.calledTwice(otd);
        sinon.assert.calledTwice(std);
    });

    test('Open files', async () => {
        const uriToOpen = Uri.joinPath(
            this.ctx.workspaceUri,
            'a file to open.txt'
        );
        await fs.writeFile(uriToOpen.fsPath, `text inside\n`);

        const repository = getRepository();
        await repository.updateStatus('Test' as Reason);
        const resource = repository.untrackedGroup.getResource(uriToOpen);
        assert.ok(resource);

        await documentWasShown(
            this.ctx.sandbox,
            sinon.match({ path: uriToOpen.path }),
            [
                {
                    preserveFocus: true,
                    preview: true,
                    viewColumn: ViewColumn.Active,
                },
            ],
            () => commands.executeCommand('zit.openFiles', resource)
        );
        await fs.unlink(uriToOpen.fsPath);
    }).timeout(6000);

    test('Open resource: nothing', async () => {
        await commands.executeCommand('zit.openResource');
    }).timeout(100);

    const createTestResource = async (
        status: string,
        expectedStatus: ResourceStatus,
        diff?: string
    ) => {
        const repository = getRepository();
        const uri = Uri.joinPath(rootUri, 'open_resource.txt');
        const execStub = getExecStub(this.ctx.sandbox);
        const statusStub = fakeZitStatus(
            execStub,
            status ? `${status} open_resource.txt` : '',
            diff
        );
        await repository.updateStatus('Test' as Reason);
        sinon.assert.calledOnce(statusStub);
        const group =
            expectedStatus === ResourceStatus.ADDED
                ? repository.addedGroup
                : repository.workingGroup;
        const resource = group.getResource(uri);
        assert.ok(resource);
        assert.equal(resource.status, expectedStatus);
        return [uri, resource] as [Uri, ZitResource];
    };

    const diffCheck = async (
        status: string,
        expectedStatus: ResourceStatus,
        caption: string,
        diff?: string
    ) => {
        const [uri, resource] = await createTestResource(
            status,
            expectedStatus,
            diff
        );

        const diffCall = this.ctx.sandbox
            .stub(commands, 'executeCommand')
            .callThrough()
            .withArgs('vscode.diff')
            .resolves();

        await commands.executeCommand('zit.openResource', resource);

        sinon.assert.calledOnceWithExactly(
            diffCall,
            'vscode.diff',
            sinon.match({ path: uri.fsPath }),
            sinon.match({ path: uri.fsPath }),
            `open_resource.txt (${caption})`,
            {
                preserveFocus: true,
                preview: undefined,
                viewColumn: -1,
            }
        );
    };

    test('Open resource (Working Directory)', async () => {
        await diffCheck('edited', ResourceStatus.MODIFIED, 'Working Directory');
    });

    test('Open resource (Deleted)', async () => {
        await diffCheck(
            '',
            ResourceStatus.DELETED,
            'Deleted',
            'D open_resource.txt'
        );
    });

    test('Open resource (Missing)', async () => {
        await diffCheck('missing', ResourceStatus.MISSING, 'Missing');
    });

    test('Open resource (Added)', async () => {
        const [uri, resource] = await createTestResource(
            'added',
            ResourceStatus.ADDED
        );
        const testTd: TextDocument = { isUntitled: false } as TextDocument;
        const otd = this.ctx.sandbox
            .stub(workspace, 'openTextDocument')
            .resolves(testTd);
        const std = this.ctx.sandbox
            .stub(window, 'showTextDocument')
            .resolves();
        await commands.executeCommand('zit.openResource', resource);
        void uri.fsPath; // populate fsPath property this way
        sinon.assert.calledOnceWithExactly(otd, uri as any);
        sinon.assert.calledOnceWithExactly(
            std,
            testTd as any,
            {
                preview: undefined,
                preserveFocus: true,
                viewColumn: ViewColumn.Active,
            } as TextDocumentShowOptions
        );
    });
    test('Open file preserves the matching editor selection', async () => {
        const [uri, resource] = await createTestResource(
            'added',
            ResourceStatus.ADDED
        );
        const selection = { anchor: {}, active: {} };
        const document = { uri } as TextDocument;
        this.ctx.sandbox.stub(window, 'activeTextEditor').value({
            document,
            selection,
        });
        this.ctx.sandbox.stub(workspace, 'openTextDocument').resolves(document);
        const show = this.ctx.sandbox
            .stub(window, 'showTextDocument')
            .resolves();

        await commands.executeCommand('zit.openFile', resource);

        assert.equal(show.firstCall.args[1]?.selection, selection);
    });

    test('Open resource (Missing)', async () => {
        const [, resource] = await createTestResource(
            'missing',
            ResourceStatus.MISSING
        );
        const otd = this.ctx.sandbox
            .stub(workspace, 'openTextDocument')
            .resolves();
        const std = this.ctx.sandbox
            .stub(window, 'showTextDocument')
            .resolves();
        await commands.executeCommand('zit.openResource', resource);
        sinon.assert.notCalled(otd);
        sinon.assert.notCalled(std);
    });
    test('Open change uses non-preview diffs for multiple resources', async () => {
        const repository = getRepository();
        const execStub = getExecStub(this.ctx.sandbox);
        fakeZitStatus(execStub, 'edited first.txt\nedited second.txt\n');
        await repository.updateStatus('Open multiple changes' as Reason);
        const resources = repository.workingGroup.resourceStates;
        assert.equal(resources.length, 2);
        const diff = this.ctx.sandbox
            .stub(commands, 'executeCommand')
            .callThrough()
            .withArgs('vscode.diff')
            .resolves();

        try {
            await commands.executeCommand('zit.openChange', resources[0]);
            sinon.assert.calledOnce(diff);
            assert.equal(diff.firstCall.args[4].preview, undefined);
            diff.resetHistory();

            await commands.executeCommand('zit.openChange', ...resources);
            sinon.assert.calledTwice(diff);
            for (const call of diff.getCalls()) {
                assert.equal(call.args[4].preview, false);
            }
        } finally {
            fakeZitStatus(execStub, '');
            await repository.updateStatus('Clear multiple changes' as Reason);
        }
    });

    test('Add current editor uri', async () => {
        const uri = Uri.joinPath(rootUri, 'opened.txt');
        await fs.writeFile(uri.fsPath, 'opened');
        const repository = getRepository();
        // make file available in 'untracked' group
        await repository.updateStatus('Test' as Reason);
        const document = await workspace.openTextDocument(uri);
        await window.showTextDocument(document, { preview: false });

        const addStub = getExecStub(this.ctx.sandbox)
            .withArgs(sinon.match.array.startsWith(['add']))
            .resolves(fakeExecutionResult());
        await commands.executeCommand('zit.add');
        sinon.assert.calledOnceWithExactly(addStub, [
            'add',
            '--',
            'opened.txt' as RelativePath,
        ]);
        await fs.unlink(uri.fsPath);
    });

    test('Zit resources expose core SCM metadata and repository mappings', async () => {
        const repository = getRepository();
        const execStub = getExecStub(this.ctx.sandbox);
        fakeZitStatus(
            execStub,
            [
                'added added.txt',
                'edited modified.txt',
                'missing missing.txt',
                'extra extra.txt',
            ].join('\n'),
            'D deleted.txt'
        );
        await repository.updateStatus('Resource metadata test' as Reason);

        const added = repository.addedGroup.getResource(
            Uri.joinPath(rootUri, 'added.txt')
        );
        const modified = repository.workingGroup.getResource(
            Uri.joinPath(rootUri, 'modified.txt')
        );
        const missing = repository.workingGroup.getResource(
            Uri.joinPath(rootUri, 'missing.txt')
        );
        const deleted = repository.workingGroup.getResource(
            Uri.joinPath(rootUri, 'deleted.txt')
        );
        const extra = repository.untrackedGroup.getResource(
            Uri.joinPath(rootUri, 'extra.txt')
        );
        assert.ok(added && modified && missing && deleted && extra);

        assert.deepEqual(added.command, {
            command: 'zit.openResource',
            title: 'Open',
            arguments: [added],
        });
        assert.equal(added.original, added.resourceUri);
        assert.equal(extra.isDirtyStatus, false);
        assert.equal(modified.isDirtyStatus, true);
        assert.equal(missing.contextValue, 'MISSING');
        assert.equal(added.contextValue, undefined);
        assert.equal(deleted.decorations.strikeThrough, true);

        assert.equal(modified.decorations.strikeThrough, false);
        assert.ok(deleted.decorations.light);
        assert.ok(deleted.decorations.dark);
        assert.equal(
            repository.mapResourceToWorkspaceRelativePath(modified),
            'modified.txt'
        );

        const original = repository.provideOriginalResource(
            modified.resourceUri
        );
        assert.equal(original?.scheme, 'zit');
        assert.equal(
            repository.provideOriginalResource(
                Uri.parse('untitled:resource-metadata')
            ),
            undefined
        );

        const lsStub = execStub.withArgs(['ls']).resolves(
            fakeExecutionResult({
                stdout:
                    `${'a'.repeat(64)} modified.txt\n` +
                    `${'b'.repeat(64)} nested\\sdir/file\\sname.txt\n`,
            })
        );
        assert.deepEqual(await repository.ls(), [
            Uri.joinPath(rootUri, 'modified.txt'),
            Uri.joinPath(rootUri, 'nested dir', 'file name.txt'),
        ]);
        sinon.assert.calledOnceWithExactly(lsStub, ['ls']);
    });
    test('Resolves historical Zit URIs and ignores absent editor URIs', async () => {
        const repository = getRepository();
        const execStub = getExecStub(this.ctx.sandbox);
        fakeZitStatus(execStub, 'edited historical-open.txt\n');
        await repository.updateStatus('Historical resource lookup' as Reason);
        const fileUri = Uri.joinPath(rootUri, 'historical-open.txt');
        await fs.writeFile(fileUri.fsPath, 'working\n');
        const historicalUri = toZitUri(fileUri, 'a'.repeat(64) as ZitCheckin);
        const activeEditor = sinon
            .stub(window, 'activeTextEditor')
            .value(undefined);
        const open = sinon
            .stub(workspace, 'openTextDocument')
            .callsFake(uri => Promise.resolve({ uri } as TextDocument));
        const show = sinon.stub(window, 'showTextDocument').resolves();

        try {
            await commands.executeCommand('zit.openFileFromUri');
            sinon.assert.notCalled(open);
            await commands.executeCommand(
                'zit.openFileFromUri',
                Uri.from({
                    scheme: 'zit',
                    path: fileUri.path,
                    query: '{not-json',
                })
            );
            sinon.assert.notCalled(open);

            await commands.executeCommand('zit.openFileFromUri', fileUri);
            sinon.assert.calledOnce(open);
            await commands.executeCommand('zit.openFileFromUri', historicalUri);
            sinon.assert.calledTwice(open);
            assert.equal(
                (open.getCall(0).args[0] as Uri).fsPath,
                fileUri.fsPath
            );
            assert.equal(
                (open.getCall(1).args[0] as Uri).fsPath,
                fileUri.fsPath
            );
            sinon.assert.calledTwice(show);
        } finally {
            show.restore();
            open.restore();
            activeEditor.restore();
            await fs.unlink(fileUri.fsPath);
            fakeZitStatus(execStub, '');
            await repository.updateStatus(
                'Clear historical resource lookup' as Reason
            );
        }
    });

    test('Rename passes repository-relative picker paths unchanged', async () => {
        const repository = getRepository();
        const execStub = getExecStub(this.ctx.sandbox);
        fakeZitStatus(execStub, 'edited relative-old.txt\n');
        await repository.updateStatus('Relative rename command' as Reason);
        const resource = repository.workingGroup.resourceStates[0];
        assert.ok(resource);
        this.ctx.sandbox
            .stub(interaction, 'selectNewFileLocation')
            .resolves('relative-new.txt' as RelativePath);
        const rename = this.ctx.sandbox.stub(repository, 'rename').resolves();

        try {
            await commands.executeCommand('zit.rename', resource);
            sinon.assert.calledOnceWithExactly(
                rename,
                'relative-old.txt' as RelativePath,
                'relative-new.txt' as RelativePath
            );
        } finally {
            fakeZitStatus(execStub, '');
            await repository.updateStatus('Clear relative rename' as Reason);
        }
    });

    test('Repository default mutations use only matching no-staging groups', async () => {
        const repository = getRepository();
        const execStub = getExecStub(this.ctx.sandbox);
        const addWithoutPaths = execStub
            .withArgs(['add', '--'])
            .resolves(fakeExecutionResult());
        await getOpenedRepository().add();
        sinon.assert.calledOnceWithExactly(addWithoutPaths, ['add', '--']);
        fakeZitStatus(execStub, 'added added.txt\nextra extra.txt\n');
        await repository.updateStatus('Default mutation test' as Reason);
        const add = execStub
            .withArgs(['add', '--', 'extra.txt' as RelativePath])
            .resolves(fakeExecutionResult());
        await repository.add();
        sinon.assert.calledOnceWithExactly(add, [
            'add',
            '--',
            'extra.txt' as RelativePath,
        ]);

        const remove = execStub
            .withArgs(['rm', '--', 'added.txt' as RelativePath])
            .resolves(fakeExecutionResult());
        await repository.forget();
        sinon.assert.calledOnceWithExactly(remove, [
            'rm',
            '--',
            'added.txt' as RelativePath,
        ]);

        const revert = execStub.withArgs(
            sinon.match.array.startsWith(['revert'])
        );
        await repository.revert(Uri.joinPath(rootUri, 'extra.txt'));
        sinon.assert.notCalled(revert);
    });

    test('Rejects mutations while disposed and clears resource state', async () => {
        const repository = new Repository(getOpenedRepository());
        const execStub = getExecStub(this.ctx.sandbox);
        fakeZitStatus(execStub, 'edited disposed.txt\n');
        await repository.updateStatus('Prepare disposal test' as Reason);
        assert.equal(repository.workingGroup.resourceStates.length, 1);

        const states: RepositoryState[] = [];
        const stateListener = repository.onDidChangeState(state =>
            states.push(state)
        );
        try {
            repository.state = RepositoryState.Disposed;
            assertGroups(repository, {});
            await assert.rejects(
                repository.rename(
                    'old.txt' as RelativePath,
                    'new.txt' as RelativePath
                ),
                /Repository not initialized/
            );
        } finally {
            stateListener.dispose();
            repository.dispose();
        }
        assert.deepEqual(states, [RepositoryState.Disposed]);
    });

    test('Waits for repository operations and window focus', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        fakeZitStatus(execStub, '');
        let focused = false;
        const focusChanges = new EventEmitter<{ focused: boolean }>();
        const windowState = sinon
            .stub(window, 'state')
            .get(() => ({ focused }));
        const windowStateEvent = sinon
            .stub(window, 'onDidChangeWindowState')
            .value(focusChanges.event);
        const repository = new Repository(getOpenedRepository());
        const internals = repository as unknown as {
            _operations: Map<symbol, object>;
            _onDidRunOperation: EventEmitter<void>;
        };
        internals._operations.set(Symbol('busy'), {});

        try {
            let completed = false;
            const waiting = repository.whenIdleAndFocused().then(() => {
                completed = true;
            });
            await Promise.resolve();
            assert.equal(completed, false);

            internals._operations.clear();
            internals._onDidRunOperation.fire();
            await Promise.resolve();
            await Promise.resolve();
            assert.equal(completed, false);

            focused = true;
            focusChanges.fire({ focused: true });
            await waiting;
            assert.equal(completed, true);
        } finally {
            repository.dispose();
            windowStateEvent.restore();
            windowState.restore();
            focusChanges.dispose();
        }
    });

    test('Refreshes idle repositories for Zit checkout changes', async () => {
        const changed = new EventEmitter<Uri>();
        const created = new EventEmitter<Uri>();
        const deleted = new EventEmitter<Uri>();
        const watcher = {
            onDidChange: changed.event,
            onDidCreate: created.event,
            onDidDelete: deleted.event,
            ignoreCreateEvents: false,
            ignoreChangeEvents: false,
            ignoreDeleteEvents: false,
            dispose: sinon.stub(),
        };
        const createWatcher = sinon
            .stub(workspace, 'createFileSystemWatcher')
            .returns(watcher);
        let autoRefresh = false;
        const autoRefreshSetting = sinon
            .stub(typedConfig, 'autoRefresh')
            .get(() => autoRefresh);
        const windowState = sinon
            .stub(window, 'state')
            .get(() => ({ focused: true }));
        const clock = sinon.useFakeTimers();
        const execStub = getExecStub(this.ctx.sandbox);
        fakeZitStatus(execStub, '');
        const repository = new Repository(getOpenedRepository());
        const checkoutChanges: Uri[] = [];
        const checkoutListener = repository.onDidChangeRepository(uri =>
            checkoutChanges.push(uri)
        );
        const modelUpdate = sinon
            .stub(repository, 'updateModelState')
            .resolves();
        const repositoryInternals = repository as unknown as {
            _operations: Map<symbol, object>;
        };
        const operations = repositoryInternals._operations;

        try {
            const checkoutMarker = Uri.joinPath(rootUri, '.zit');
            changed.fire(checkoutMarker);
            assert.deepEqual(checkoutChanges, [checkoutMarker]);
            sinon.assert.notCalled(modelUpdate);

            autoRefresh = true;
            operations.set(Symbol('busy'), {});
            changed.fire(Uri.joinPath(rootUri, 'busy.txt'));
            sinon.assert.notCalled(modelUpdate);

            operations.clear();
            changed.fire(Uri.joinPath(rootUri, 'idle.txt'));
            await clock.tickAsync(1001);
            sinon.assert.calledOnce(modelUpdate);
            await clock.tickAsync(5000);
        } finally {
            checkoutListener.dispose();
            repository.dispose();
            clock.restore();
            windowState.restore();
            autoRefreshSetting.restore();
            createWatcher.restore();
            changed.dispose();
            created.dispose();
            deleted.dispose();
        }
    });

    test('Warns and opens every path reported by a failed Zit merge', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        fakeZitStatus(execStub, '');
        const mergeResult = fakeExecutionResult({
            exitCode: 1,
            stderr:
                'zit merge: conflict in one.txt\n' +
                'zit merge: conflict in nested/two.txt\n',
        });
        const merge = this.ctx.sandbox
            .stub(getOpenedRepository(), 'merge')
            .resolves(mergeResult);
        const repository = new Repository(getOpenedRepository());
        const warning = sinon.stub(window, 'showWarningMessage').resolves();
        const open = sinon
            .stub(workspace, 'openTextDocument')
            .callsFake(uri => Promise.resolve({ uri } as TextDocument));
        const show = sinon.stub(window, 'showTextDocument').resolves();

        try {
            const result = await repository.merge(
                'target' as ZitCheckin,
                MergeAction.Merge
            );

            assert.equal(result.exitCode, 1);
            sinon.assert.calledOnceWithExactly(
                merge,
                'target' as ZitCheckin,
                MergeAction.Merge,
                sinon.match({
                    signal: sinon.match.instanceOf(AbortSignal),
                })
            );
            sinon.assert.calledOnce(warning);
            sinon.assert.calledTwice(open);
            sinon.assert.calledTwice(show);
            assert.deepEqual(
                open.getCalls().map(call => call.args[0]),
                [
                    Uri.joinPath(rootUri, 'one.txt'),
                    Uri.joinPath(rootUri, 'nested/two.txt'),
                ]
            );
        } finally {
            show.restore();
            open.restore();
            warning.restore();
            repository.dispose();
        }
    });

    test('Rename cancels cleanly and ignores resources outside a repository', async () => {
        const repository = getRepository();
        const execStub = getExecStub(this.ctx.sandbox);
        fakeZitStatus(execStub, 'missing rename-cancel.txt');
        await repository.updateStatus('Rename cancellation test' as Reason);
        const resource = repository.workingGroup.getResource(
            Uri.joinPath(rootUri, 'rename-cancel.txt')
        );
        assert.ok(resource);
        const quickPick = this.ctx.sandbox
            .stub(window, 'showQuickPick')
            .resolves(undefined);
        const rename = execStub.withArgs(sinon.match.array.startsWith(['mv']));

        await commands.executeCommand('zit.rename', resource);

        sinon.assert.calledOnce(quickPick);
        sinon.assert.notCalled(rename);

        const outside = new ZitResource(
            repository.untrackedGroup,
            Uri.file('/tmp/outside-zit-repository.txt'),
            ResourceStatus.EXTRA,
            'EXTRA' as ZitClass
        );
        await commands.executeCommand('zit.rename', outside);
        sinon.assert.calledOnce(quickPick);
        sinon.assert.notCalled(rename);
    });

    test('Open change accepts a resource-group proxy and missing URI', async () => {
        const repository = getRepository();
        const execStub = getExecStub(this.ctx.sandbox);
        fakeZitStatus(execStub, 'edited first.txt\nmissing second.txt');
        await repository.updateStatus('Open group test' as Reason);
        const diff = this.ctx.sandbox
            .stub(commands, 'executeCommand')
            .callThrough()
            .withArgs('vscode.diff')
            .resolves();

        await commands.executeCommand(
            'zit.openChange',
            repository.workingGroup
        );

        sinon.assert.calledTwice(diff);
        assert.equal(diff.firstCall.args[4].preview, false);
        await commands.executeCommand(
            'zit.openFileFromUri',
            Uri.file('/tmp/not-in-zit-repository.txt')
        );
    });
}
