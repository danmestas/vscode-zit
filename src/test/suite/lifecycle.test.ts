import * as assert from 'assert/strict';
import * as sinon from 'sinon';
import * as path from 'path';
import {
    commands,
    ConfigurationChangeEvent,
    ExtensionContext,
    EventEmitter,
    FileSystemWatcher,
    LogOutputChannel,
    QuickPickItem,
    SourceControl,
    Uri,
    window,
    workspace,
    WorkspaceConfiguration,
    WorkspaceFoldersChangeEvent,
} from 'vscode';
import typedConfig from '../../config';
import { activate } from '../../main';
import { Model } from '../../model';
import { Repository, RepositoryState } from '../../repository';
import {
    RawExecResult,
    ZitCWD,
    ZitExecutable,
    ZitExecutablePath,
    ZitVersion,
} from '../../zitExecutable';
import { UnvalidatedZitExecutablePath } from '../../zitFinder';
import { OpenedRepository, ZitRoot } from '../../openedRepository';
import * as extensionCommands from '../../commands';
import * as fileSystemProvider from '../../fileSystemProvider';
import * as zitFinder from '../../zitFinder';

interface ModelLifecycleInternals {
    openRepositories: Array<{
        repository: Repository;
        dispose(): void;
    }>;
    state: number;
    onDidChangeWorkspaceFolders(
        event: WorkspaceFoldersChangeEvent
    ): Promise<void>;
    open(repository: Repository): void;
    doInitialScan(): Promise<void>;
}
function outputChannel(): LogOutputChannel {
    return {
        appendLine: sinon.stub(),
        debug: sinon.stub(),
        error: sinon.stub(),
        info: sinon.stub(),
        trace: sinon.stub(),
        warn: sinon.stub(),
        dispose: sinon.stub(),
    } as unknown as LogOutputChannel;
}

suite('Zit lifecycle', function () {
    const sandbox = sinon.createSandbox();

    teardown(() => sandbox.restore());

    async function activateWithoutZit(
        choice: string
    ): Promise<sinon.SinonStub> {
        sandbox.stub(window, 'createOutputChannel').returns(outputChannel());
        sandbox.stub(zitFinder, 'findZit').resolves(undefined);
        sandbox
            .stub(extensionCommands, 'CommandCenter')
            .returns({ dispose: sinon.stub() });
        sandbox
            .stub(fileSystemProvider, 'ZitFileSystemProvider')
            .returns({ dispose: sinon.stub() });
        const showWarningMessage = sandbox.stub(
            window,
            'showWarningMessage'
        ) as unknown as sinon.SinonStub<
            [message: string, ...items: string[]],
            Thenable<string | undefined>
        >;
        showWarningMessage.resolves(choice);
        const executeCommand = sandbox
            .stub(commands, 'executeCommand')
            .resolves(undefined);
        const context = {
            subscriptions: { push: sinon.stub() },
        } as unknown as ExtensionContext;

        await activate(context);
        return executeCommand;
    }

    test('missing Zit guidance opens the executable setting', async () => {
        const executeCommand = await activateWithoutZit('Edit "zit.path"');

        sinon.assert.calledWithExactly(
            executeCommand,
            'workbench.action.openSettings',
            'zit.path'
        );
    });

    test('missing Zit guidance can be disabled', async () => {
        const disable = sandbox
            .stub(typedConfig, 'disableMissingZitWarning')
            .resolves(undefined);

        await activateWithoutZit("Don't Show Again");

        sinon.assert.calledOnce(disable);
    });

    test('configuration exposes values without mutating argument arrays', async () => {
        const values: Record<string, unknown> = {
            path: '  /opt/zit  ',
            autoRefresh: true,
            autoSyncInterval: 12,
            enableRenaming: true,
            ignoreMissingZitWarning: false,
            username: 'alice',
            defaultUsername: 'default-author',
            confirmGitExport: 'Ask',
            globalArgs: ['--quiet'],
            commitArgs: ['--no-sync'],
        };
        const update = sandbox.stub().resolves(undefined);
        sandbox
            .stub(workspace, 'getConfiguration')
            .withArgs('zit')
            .returns({
                get: (name: string) => values[name],
                update,
            } as unknown as WorkspaceConfiguration);

        assert.equal(typedConfig.path, '/opt/zit');
        assert.equal(typedConfig.autoRefresh, true);
        assert.equal(typedConfig.autoSyncIntervalMs, 12000);
        assert.equal(typedConfig.enableRenaming, true);
        assert.equal(typedConfig.ignoreMissingZitWarning, false);
        assert.equal(typedConfig.username, 'alice');
        assert.equal(typedConfig.defaultUsername, 'default-author');
        assert.deepEqual(typedConfig.globalArgs, ['--quiet']);
        assert.deepEqual(values.globalArgs, ['--quiet']);
        assert.deepEqual(typedConfig.commitArgs, ['--no-sync']);

        await typedConfig.disableMissingZitWarning();
        await typedConfig.disableRenaming();
        await typedConfig.setGitExport('Never');
        sinon.assert.calledWithExactly(
            update,
            'ignoreMissingZitWarning',
            true,
            false
        );
        sinon.assert.calledWithExactly(update, 'enableRenaming', false, false);
        sinon.assert.calledWithExactly(
            update,
            'confirmGitExport',
            'Never',
            false
        );
    });

    function createModel(): Model {
        sandbox.stub(zitFinder, 'findZit').resolves(undefined);
        return new Model(
            new ZitExecutable(outputChannel()),
            '' as UnvalidatedZitExecutablePath
        );
    }

    test('model exposes its initial lifecycle state', () => {
        const model = createModel();
        const lifecycle = model as unknown as ModelLifecycleInternals;

        assert.equal(lifecycle.state, 1);
        model.dispose();
    });

    test('model selection, lookup, initialization, and disposal are observable', async () => {
        const model = createModel();
        await assert.rejects(
            model.pickRepository(),
            /no available repositor(?:y|ies)/i
        );

        const disposeOne = sandbox.stub();
        const disposeTwo = sandbox.stub();
        const sourceControl = {} as SourceControl;
        const one = Object.create(Repository.prototype) as Repository;
        Object.defineProperties(one, {
            root: { value: '/tmp/zit-one' },
            sourceControl: { value: sourceControl },
        });
        const two = {
            root: '/tmp/zit-two',
        } as unknown as Repository;
        const internals = model as unknown as ModelLifecycleInternals;
        internals.openRepositories.push(
            { repository: one, dispose: disposeOne },
            { repository: two, dispose: disposeTwo }
        );

        const showQuickPick = sandbox
            .stub(window, 'showQuickPick')
            .callsFake(async items => {
                const picks = await items;
                return picks[1] as QuickPickItem;
            });
        assert.equal(await model.pickRepository(), two);
        const picks = await showQuickPick.firstCall.args[0];
        assert.deepEqual(
            picks.map((pick: QuickPickItem) => [pick.label, pick.description]),
            [
                ['zit-one', ''],
                ['zit-two', ''],
            ]
        );
        assert.deepEqual(model.getOpenRepositories(), [one, two]);
        assert.equal(
            model.getRepository(Uri.file('/tmp/zit-one/file.txt')),
            one
        );
        assert.equal(model.getRepository(one), one);
        assert.equal(model.getRepository(sourceControl), one);

        await internals.onDidChangeWorkspaceFolders({
            added: [],
            removed: [
                {
                    uri: Uri.file(one.root),
                    name: 'zit-one',
                    index: 0,
                },
            ],
        });
        sinon.assert.calledOnce(disposeOne);
        internals.openRepositories = internals.openRepositories.filter(
            item => item.repository !== one
        );

        internals.state = 2;
        await model.isInitialized;

        model.dispose();
        sinon.assert.calledOnce(disposeOne);
        sinon.assert.calledOnce(disposeTwo);
    });

    test('model chooses the deepest repository containing a resource', () => {
        const model = createModel();
        const internals = model as unknown as ModelLifecycleInternals;
        const parentRoot = path.join(
            path.parse(process.cwd()).root,
            'tmp',
            'zit-parent'
        );
        const nestedRoot = path.join(parentRoot, 'nested') + path.sep;
        const parent = {
            root: parentRoot,
        } as unknown as Repository;
        const nested = {
            root: nestedRoot,
        } as unknown as Repository;

        internals.openRepositories.push(
            { repository: parent, dispose: sandbox.stub() },
            { repository: nested, dispose: sandbox.stub() }
        );

        const nestedResource = Uri.file(
            path.join(parentRoot, 'nested', 'file.txt')
        );
        assert.equal(model.getRepository(nestedResource), nested);

        internals.openRepositories.reverse();
        assert.equal(model.getRepository(nestedResource), nested);
        assert.equal(model.getRepository(Uri.file(nestedRoot)), nested);
        assert.equal(
            model.getRepository(
                Uri.file(path.join(parentRoot, '..cache', 'file.txt'))
            ),
            parent
        );
        assert.equal(
            model.getRepository(Uri.file(`${parentRoot}-sibling/file.txt`)),
            undefined
        );
        assert.equal(
            model.getRepository(
                Uri.file(path.join(path.dirname(parentRoot), 'outside.txt'))
            ),
            undefined
        );

        model.dispose();
    });

    test('model rejects absolute path.relative results', () => {
        const model = createModel();
        const internals = model as unknown as ModelLifecycleInternals;
        const repository = {
            root: path.join(path.parse(process.cwd()).root, 'tmp', 'zit-root'),
        } as unknown as Repository;
        internals.openRepositories.push({
            repository,
            dispose: sandbox.stub(),
        });
        const differentDriveRelativePath = String.raw`D:\outside\file.txt`;
        sandbox.stub(path, 'relative').returns(differentDriveRelativePath);

        assert.equal(
            model.getRepository(
                Uri.file(path.join(repository.root, 'file.txt'))
            ),
            undefined
        );

        model.dispose();
    });

    test('model reacts to executable configuration and checkout markers', async () => {
        let configuredPath = '';
        const values: Record<string, unknown> = {
            autoSyncInterval: 3,
            enableRenaming: false,
        };
        sandbox
            .stub(workspace, 'getConfiguration')
            .withArgs('zit')
            .returns({
                get: (name: string) =>
                    name === 'path' ? configuredPath : values[name],
                update: sandbox.stub().resolves(undefined),
            } as unknown as WorkspaceConfiguration);
        const find = sandbox.stub(zitFinder, 'findZit').resolves(undefined);
        const marker = new EventEmitter<Uri>();
        const watcher = {
            onDidChange: marker.event,
            onDidCreate: marker.event,
            onDidDelete: marker.event,
            ignoreCreateEvents: false,
            ignoreChangeEvents: false,
            ignoreDeleteEvents: false,
            dispose: sandbox.stub(),
        } as unknown as FileSystemWatcher;
        const createWatcher = sandbox
            .stub(workspace, 'createFileSystemWatcher')
            .returns(watcher);
        const output = outputChannel();
        const model = new Model(
            new ZitExecutable(output),
            '' as UnvalidatedZitExecutablePath
        );
        const lifecycle = model as unknown as ModelLifecycleInternals;
        const initialized = model.isInitialized;
        lifecycle.state = 2;
        await initialized;
        const tryOpen = sandbox
            .stub(model, 'tryOpenRepository')
            .resolves(false);

        await model.foundExecutable({
            path: '/opt/zit' as ZitExecutablePath,
            version: [0, 16, 0] as ZitVersion,
        });
        sinon.assert.calledWithExactly(createWatcher, '**/.zit');
        tryOpen.resetHistory();

        const root = workspace.workspaceFolders![0].uri;
        const clock = sandbox.useFakeTimers();
        marker.fire(Uri.joinPath(root, '.zit'));
        await clock.tickAsync(501);
        sinon.assert.calledWith(tryOpen, root.fsPath);

        find.resetHistory();
        await model['onDidChangeConfiguration']({
            affectsConfiguration: () => false,
        } as ConfigurationChangeEvent);
        sinon.assert.notCalled(find);

        configuredPath = '/new/zit';
        await model['onDidChangeConfiguration']({
            affectsConfiguration: () => true,
        } as ConfigurationChangeEvent);
        sinon.assert.calledWith(find, '/new/zit', sinon.match.same(output));

        model.dispose();
        sinon.assert.calledOnce(watcher.dispose as sinon.SinonStub);
        marker.dispose();
    });

    test('model skips workspace scans when no folders are open', async () => {
        sandbox.stub(workspace, 'workspaceFolders').get(() => undefined);
        sandbox.stub(window, 'visibleTextEditors').get(() => []);
        const model = createModel();
        const tryOpen = sandbox
            .stub(model, 'tryOpenRepository')
            .resolves(false);
        const lifecycle = model as unknown as ModelLifecycleInternals;
        tryOpen.resetHistory();

        const repository = {
            root: Uri.file('/tmp/zit-without-workspace').fsPath,
        } as unknown as Repository;
        const disposeRepository = sandbox.stub();
        lifecycle.openRepositories.push({
            repository,
            dispose: disposeRepository,
        });
        await lifecycle.onDidChangeWorkspaceFolders({
            added: [],
            removed: [
                {
                    uri: Uri.file(repository.root),
                    name: 'zit-without-workspace',
                    index: 0,
                },
            ],
        });
        sinon.assert.calledOnce(disposeRepository);
        lifecycle.openRepositories = [];
        await lifecycle.doInitialScan();

        sinon.assert.notCalled(tryOpen);
        model.dispose();
    });
    test('failed initial status commands are diagnosed once and never registered', async () => {
        const disposeRepository = sandbox.spy(Repository.prototype, 'dispose');
        const showErrorMessage = sandbox
            .stub(window, 'showErrorMessage')
            .resolves(undefined);

        const failedCommands = ['status', 'extras', 'diff --brief'];
        for (const failedCommand of failedCommands) {
            const root = Uri.file(`/tmp/zit-initial-${failedCommand}-failure`)
                .fsPath as ZitRoot;
            const output = outputChannel();
            const executable = new ZitExecutable(output);
            sandbox.stub(executable, 'findRoot').resolves(root);
            const rawExec = sandbox
                .stub(executable, 'rawExec')
                .callsFake(async args => {
                    const command = args.join(' ');
                    const failed = command === failedCommand;
                    return {
                        zitPath: '/bin/zit' as ZitExecutablePath,
                        exitCode: failed ? 1 : 0,
                        stdout: Buffer.from(
                            args[0] === 'status' && !failed
                                ? 'On branch trunk (no check-ins yet)\n'
                                : ''
                        ),
                        stderr: Buffer.from(
                            failed ? `${failedCommand} failed\n` : ''
                        ),
                        args,
                        cwd: root as ZitCWD,
                        command: `/bin/zit ${args.join(' ')}`,
                        durationMs: 1,
                    } as RawExecResult;
                });
            const model = new Model(executable, typedConfig.path);
            const opened: Repository[] = [];
            model.onDidOpenRepository(repository => opened.push(repository));

            assert.equal(await model.tryOpenRepository(root), false);
            assert.deepEqual(model.getOpenRepositories(), []);
            assert.deepEqual(opened, []);
            sinon.assert.callCount(rawExec, 3);
            sinon.assert.calledOnce(output.error as sinon.SinonStub);
            sinon.assert.calledWithExactly(
                output.error as sinon.SinonStub,
                `(/bin/zit ${failedCommand}): ${failedCommand} failed\n`
            );
            sinon.assert.calledOnce(showErrorMessage);
            sinon.assert.calledWithExactly(
                showErrorMessage as sinon.SinonStub,
                `Zit: ${failedCommand} failed`,
                'Open Zit Log'
            );

            showErrorMessage.resetHistory();
            model.dispose();
        }

        sinon.assert.callCount(disposeRepository, 3);
    });

    test('successful initialization sets up autosync before registration', async () => {
        const order: string[] = [];
        sandbox
            .stub(Repository.prototype, 'updateModelState')
            .callsFake(async () => {
                order.push('status');
            });
        sandbox
            .stub(Repository.prototype, 'updateAutoSyncInterval')
            .callsFake(async () => {
                order.push('autosync');
            });
        const root = Uri.file('/tmp/zit-successful-initialization')
            .fsPath as ZitRoot;
        sandbox
            .stub(OpenedRepository, 'tryOpen')
            .resolves({ root } as OpenedRepository);
        const model = createModel();
        model.onDidOpenRepository(() => order.push('open'));

        assert.equal(await model.tryOpenRepository(root), true);
        assert.deepEqual(order, ['status', 'autosync', 'open']);
        assert.equal(model.getOpenRepositories().length, 1);

        model.dispose();
    });

    test('model forwards repository events and avoids duplicate opens', async () => {
        const model = createModel();
        const state = new EventEmitter<RepositoryState>();
        const changed = new EventEmitter<Uri>();
        const originalChanged = new EventEmitter<Uri>();
        const disposeRepository = sandbox.stub();
        const sourceControl = {} as SourceControl;
        const root = Uri.file('/tmp/zit-lifecycle').fsPath;
        const repository = Object.create(Repository.prototype) as Repository;
        Object.defineProperties(repository, {
            root: { value: root },
            sourceControl: { value: sourceControl },
            onDidChangeState: { value: state.event },
            onDidChangeRepository: { value: changed.event },
            onDidChangeOriginalResource: { value: originalChanged.event },
            dispose: { value: disposeRepository },
        });
        const internals = model as unknown as ModelLifecycleInternals;
        const repositoryChanges: Uri[] = [];
        const originalChanges: Uri[] = [];
        const closed: Repository[] = [];
        model.onDidChangeRepository(event => repositoryChanges.push(event.uri));
        model.onDidChangeOriginalResource(event =>
            originalChanges.push(event.uri)
        );
        model.onDidCloseRepository(value => closed.push(value));
        internals.open(repository);

        assert.equal(model.getRepository(repository), repository);
        assert.equal(model.getRepository(sourceControl), repository);
        assert.equal(await model.tryOpenRepository(`${root}/file.txt`), true);

        sandbox.stub(Repository.prototype, 'updateModelState').resolves();
        const tryOpen = sandbox
            .stub(OpenedRepository, 'tryOpen')
            .resolves({ root } as OpenedRepository);
        assert.equal(await model.tryOpenRepository('/tmp/another-zit'), true);
        sinon.assert.calledOnce(tryOpen);

        const changedUri = Uri.file(`${root}/changed.txt`);
        const originalUri = Uri.file(`${root}/original.txt`);
        changed.fire(changedUri);
        originalChanged.fire(originalUri);
        assert.deepEqual(repositoryChanges, [changedUri]);
        assert.deepEqual(originalChanges, [originalUri]);

        state.fire(RepositoryState.Disposed);
        sinon.assert.calledOnce(disposeRepository);
        assert.deepEqual(closed, [repository]);
        assert.deepEqual(model.getOpenRepositories(), []);

        model.dispose();
        state.dispose();
        changed.dispose();
        originalChanged.dispose();
    });
});
