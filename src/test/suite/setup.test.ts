import * as assert from 'assert/strict';
import * as cp from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import * as sinon from 'sinon';
import {
    commands,
    ExtensionContext,
    LogOutputChannel,
    Uri,
    window,
} from 'vscode';
import {
    OpenedRepository,
    ZitCheckin,
    ZitRoot,
    ZitURI,
} from '../../openedRepository';
import {
    ExecResult,
    ZitCWD,
    ZitExecutable,
    ZitExecutablePath,
} from '../../zitExecutable';
import {
    findZit,
    parseZitVersion,
    UnvalidatedZitExecutablePath,
    VersionSpawn,
} from '../../zitFinder';
import { activate } from '../../main';
import * as extensionCommands from '../../commands';
import * as interaction from '../../interaction';
import * as fileSystemProvider from '../../fileSystemProvider';
import * as zitFinder from '../../zitFinder';

function outputChannel(): LogOutputChannel {
    return {
        info: sinon.stub(),
        warn: sinon.stub(),
        error: sinon.stub(),
        show: sinon.stub(),
    } as unknown as LogOutputChannel;
}

function versionProcess({
    stdout = '',
    exitCode = 0,
    error,
}: {
    stdout?: string;
    exitCode?: number;
    error?: NodeJS.ErrnoException;
} = {}): cp.ChildProcessWithoutNullStreams {
    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
        stdout: stdoutStream,
        stderr: stderrStream,
        stdin: new PassThrough(),
    }) as unknown as cp.ChildProcessWithoutNullStreams;
    process.nextTick(() => {
        stdoutStream.end(stdout);
        stderrStream.end();
        if (error) {
            child.emit('error', error);
        }
        child.emit('close', error ? -2 : exitCode);
    });
    return child;
}

function successResult(cwd: ZitCWD, args: readonly string[]): ExecResult {
    return {
        zitPath: 'zit' as ZitExecutablePath,
        exitCode: 0,
        stdout: '' as ExecResult['stdout'],
        stderr: '' as ExecResult['stderr'],
        args,
        cwd,
        command: `zit ${args.join(' ')}`,
        durationMs: 1,
    } as ExecResult;
}

suite('Zit setup', function () {
    const sandbox = sinon.createSandbox();
    const temporaryPaths: string[] = [];

    teardown(async () => {
        sandbox.restore();
        await Promise.all(
            temporaryPaths
                .splice(0)
                .map(temp => fs.rm(temp, { recursive: true, force: true }))
        );
    });

    test('activates with the Zit output and context identity', async () => {
        const output = outputChannel();
        const createOutputChannel = sandbox
            .stub(window, 'createOutputChannel')
            .returns(output);
        sandbox.stub(zitFinder, 'findZit').resolves();
        const showWarningMessage = sandbox.stub(
            window,
            'showWarningMessage'
        ) as unknown as sinon.SinonStub<
            [message: string, ...items: string[]],
            Thenable<string | undefined>
        >;
        showWarningMessage.resolves('Download Zit');
        sandbox
            .stub(extensionCommands, 'CommandCenter')
            .returns({ dispose: sinon.stub() });
        sandbox
            .stub(fileSystemProvider, 'ZitFileSystemProvider')
            .returns({ dispose: sinon.stub() });
        const executeCommand = sandbox
            .stub(commands, 'executeCommand')
            .resolves();
        const context = {
            subscriptions: { push: sinon.stub() },
        } as unknown as ExtensionContext;

        await activate(context);

        sinon.assert.calledOnceWithExactly(createOutputChannel, 'Zit', {
            log: true,
        });
        sinon.assert.calledOnceWithExactly(
            showWarningMessage,
            'Zit was not found. Install it or configure it using the ' +
                "'zit.path' setting.",
            'Download Zit',
            'Edit "zit.path"',
            "Don't Show Again"
        );
        sinon.assert.calledWithExactly(
            executeCommand,
            'vscode.open',
            Uri.parse('https://fossil.craftdesign.group/zit/uv/download.html')
        );
        sinon.assert.calledWithExactly(
            executeCommand,
            'setContext',
            'zit.found',
            false
        );
        sinon.assert.calledWithExactly(
            executeCommand,
            'setContext',
            'zitOpenRepositoryCount',
            0
        );
    });

    test('parses the documented Zit version output', () => {
        assert.deepEqual(
            parseZitVersion('zit 0.1.3 (targets Fossil RFC rev 00)\n'),
            [0, 1, 3]
        );
        assert.equal(parseZitVersion('zit 0.1\n'), undefined);
        assert.equal(parseZitVersion('prefix zit 0.1.3\n'), undefined);
    });

    test('uses configured zit.path before PATH', async () => {
        const spawn = sandbox.stub(cp, 'spawn').callThrough();
        const versionSpawn = spawn
            .withArgs('/opt/zit', ['version'], {})
            .callsFake(() =>
                versionProcess({
                    stdout: 'zit 0.1.3 (targets Fossil RFC rev 00)\n',
                })
            );
        const output = outputChannel();
        const spawnVersion = spawn as unknown as VersionSpawn;

        const info = await findZit(
            '/opt/zit' as UnvalidatedZitExecutablePath,
            output,
            spawnVersion
        );

        assert.deepEqual(info, {
            path: '/opt/zit',
            version: [0, 1, 3],
        });
        sinon.assert.calledOnceWithExactly(
            versionSpawn,
            '/opt/zit',
            ['version'],
            {}
        );
        sinon.assert.calledWithExactly(
            output.info as sinon.SinonStub,
            'Using zit 0.1.3 from /opt/zit'
        );
    });

    test('falls back to zit on PATH when configured path is unavailable', async () => {
        const unavailable = Object.assign(new Error('not found'), {
            code: 'ENOENT',
        });
        const spawn = sandbox.stub(cp, 'spawn').callThrough();
        const configuredProbe = spawn
            .withArgs('/missing/zit', ['version'], {})
            .callsFake(() => {
                throw unavailable;
            });
        const pathProbe = spawn.withArgs('zit', ['version'], {}).callsFake(() =>
            versionProcess({
                stdout: 'zit 0.1.3 (targets Fossil RFC rev 00)\n',
            })
        );
        const output = outputChannel();
        const spawnVersion = spawn as unknown as VersionSpawn;

        const info = await findZit(
            '/missing/zit' as UnvalidatedZitExecutablePath,
            output,
            spawnVersion
        );

        assert.equal(info?.path, 'zit');
        sinon.assert.calledWithExactly(
            output.warn as sinon.SinonStub,
            "`zit.path` '/missing/zit' is unavailable (Error: not found). Will try 'zit' on PATH"
        );
        sinon.assert.calledOnceWithExactly(
            configuredProbe,
            '/missing/zit',
            ['version'],
            {}
        );
        sinon.assert.calledOnceWithExactly(pathProbe, 'zit', ['version'], {});
    });

    test('reports failed and malformed version probes', async () => {
        const unavailable = Object.assign(new Error('permission denied'), {
            code: 'EACCES',
        });
        const spawn = sandbox.stub(cp, 'spawn').callThrough();
        const configuredProbe = spawn
            .withArgs('/blocked/zit', ['version'], {})
            .callsFake(() => versionProcess({ error: unavailable }));
        const pathProbe = spawn
            .withArgs('zit', ['version'], {})
            .callsFake(() => versionProcess({ exitCode: 2 }));
        const spawnVersion = spawn as unknown as VersionSpawn;
        const failedOutput = outputChannel();

        assert.equal(
            await findZit(
                '/blocked/zit' as UnvalidatedZitExecutablePath,
                failedOutput,
                spawnVersion
            ),
            undefined
        );
        sinon.assert.calledOnceWithExactly(
            configuredProbe,
            '/blocked/zit',
            ['version'],
            {}
        );
        sinon.assert.calledWithExactly(
            failedOutput.warn as sinon.SinonStub,
            "`zit.path` '/blocked/zit' is unavailable (Error: permission denied). Will try 'zit' on PATH"
        );
        sinon.assert.calledWithExactly(
            failedOutput.error as sinon.SinonStub,
            "'zit' is unavailable (Error: 'zit version' exited with code 2). Zit extension commands will be disabled"
        );

        pathProbe.resetBehavior();
        pathProbe.resetHistory();
        pathProbe.callsFake(() => {
            throw new Error('not found');
        });
        const defaultOutput = outputChannel();
        assert.equal(
            await findZit(
                'zit' as UnvalidatedZitExecutablePath,
                defaultOutput,
                spawnVersion
            ),
            undefined
        );
        sinon.assert.calledOnceWithExactly(
            defaultOutput.error as sinon.SinonStub,
            "'zit' is unavailable (Error: not found). Zit extension commands will be disabled"
        );

        pathProbe.resetBehavior();
        pathProbe.resetHistory();
        pathProbe.callsFake(() =>
            versionProcess({ stdout: 'not a Zit version\n' })
        );
        const malformedOutput = outputChannel();
        assert.equal(
            await findZit(
                'zit' as UnvalidatedZitExecutablePath,
                malformedOutput,
                spawnVersion
            ),
            undefined
        );
        sinon.assert.calledOnceWithExactly(
            malformedOutput.error as sinon.SinonStub,
            "Failed to parse zit version from output: 'not a Zit version\n'"
        );

        pathProbe.resetBehavior();
        pathProbe.resetHistory();
        pathProbe.callsFake(() => versionProcess({ stdout: 'zit 0.1.3\n' }));
        assert.equal(
            (
                await findZit(
                    '' as UnvalidatedZitExecutablePath,
                    outputChannel(),
                    spawnVersion
                )
            )?.path,
            'zit'
        );
        sinon.assert.calledOnceWithExactly(pathProbe, 'zit', ['version'], {});
    });

    test('does not retain passwords embedded in clone URLs', async () => {
        const input = sandbox.stub(window, 'showInputBox');
        input.onFirstCall().resolves('https://user:secret@example.test/repo');
        input.onSecondCall().resolves(undefined);

        const uri = await interaction.inputRepoUrl();
        await interaction.inputRepoUrl();

        assert.equal(uri?.toString(), 'https://user:secret@example.test/repo');
        assert.equal(
            input.secondCall.args[0]?.value,
            'https://user@example.test/repo'
        );
    });

    test('findRoot discovers directory and file .zit markers from nested paths', async () => {
        const temp = await fs.mkdtemp(
            path.join(os.tmpdir(), 'vscode-zit-root-')
        );
        temporaryPaths.push(temp);
        const directoryCheckout = path.join(temp, 'directory-checkout');
        const nested = path.join(directoryCheckout, 'a', 'b');
        await fs.mkdir(path.join(directoryCheckout, '.zit'), {
            recursive: true,
        });
        await fs.mkdir(nested, { recursive: true });
        const nestedFile = path.join(nested, 'file.txt');
        await fs.writeFile(nestedFile, 'fixture');

        const executable = new ZitExecutable(outputChannel());
        assert.equal(await executable.findRoot(nested), directoryCheckout);
        assert.equal(await executable.findRoot(nestedFile), directoryCheckout);
        assert.equal(
            (await OpenedRepository.tryOpen(executable, nestedFile))?.root,
            directoryCheckout
        );

        const fileCheckout = path.join(temp, 'file-checkout');
        await fs.mkdir(fileCheckout);
        await fs.writeFile(path.join(fileCheckout, '.zit'), 'store');
        assert.equal(await executable.findRoot(fileCheckout), fileCheckout);
        assert.equal(await executable.findRoot(temp), undefined);
        assert.equal(
            await executable.findRoot(path.parse(temp).root),
            undefined
        );
        assert.equal(
            await OpenedRepository.tryOpen(executable, temp),
            undefined
        );
        await assert.rejects(
            executable.findRoot('\0'),
            (error: NodeJS.ErrnoException) =>
                error.code === 'ERR_INVALID_ARG_VALUE'
        );
        assert.equal(await executable.findRoot('/dev/null'), undefined);
        const unsupportedMarker = path.join(temp, 'unsupported-marker');
        await fs.mkdir(unsupportedMarker);
        await fs.symlink('/dev/null', path.join(unsupportedMarker, '.zit'));
        assert.equal(await executable.findRoot(unsupportedMarker), undefined);
        assert.equal(
            await executable.findRoot(path.join(temp, 'missing-input')),
            undefined
        );
        const loopCheckout = path.join(temp, 'loop-checkout');
        await fs.mkdir(loopCheckout);
        await fs.symlink('.zit', path.join(loopCheckout, '.zit'));
        await assert.rejects(
            executable.findRoot(loopCheckout),
            (error: NodeJS.ErrnoException) => error.code === 'ELOOP'
        );
    });

    test('init, clone, and open own exact Zit argv', async () => {
        const executable = new ZitExecutable(outputChannel());
        const exec = sandbox
            .stub(executable, 'exec')
            .callsFake(async (cwd, args) => successResult(cwd, args));
        const root = path.join(os.tmpdir(), 'checkout') as ZitRoot;

        await OpenedRepository.init(executable, root);
        assert.deepEqual(exec.firstCall.args, [
            path.dirname(root),
            ['init', root],
        ]);

        const uri = Uri.parse('https://example.test/repository') as ZitURI;
        await OpenedRepository.clone(executable, uri, root);
        assert.deepEqual(exec.secondCall.args, [
            path.dirname(root),
            ['clone', uri.toString(), root],
        ]);

        await OpenedRepository.open(executable, root);
        assert.deepEqual(exec.thirdCall.args, [root, ['open']]);

        await OpenedRepository.open(executable, root, 'trunk' as ZitCheckin);
        assert.deepEqual(exec.getCall(3).args, [root, ['open', 'trunk']]);
    });

    test('open distinguishes materialized and unborn Zit checkouts', async () => {
        const temp = await fs.mkdtemp(
            path.join(os.tmpdir(), 'vscode-zit-open-')
        );
        temporaryPaths.push(temp);
        const materialized = path.join(temp, 'materialized') as ZitRoot;
        const unborn = path.join(temp, 'unborn') as ZitRoot;
        const bare = path.join(temp, 'bare') as ZitRoot;
        const fileMaterialized = path.join(
            temp,
            'file-materialized'
        ) as ZitRoot;
        for (const root of [materialized, unborn]) {
            await fs.mkdir(path.join(root, '.zit'), { recursive: true });
            await fs.writeFile(path.join(root, '.zit-checkout'), 'checkout');
        }
        await fs.mkdir(bare);
        await fs.mkdir(fileMaterialized);
        await fs.writeFile(path.join(fileMaterialized, '.zit'), 'store');
        await fs.writeFile(
            path.join(fileMaterialized, '.zit-checkout'),
            'checkout'
        );
        const invalidCheckout = path.join(temp, 'invalid-checkout') as ZitRoot;
        await fs.mkdir(path.join(invalidCheckout, '.zit'), {
            recursive: true,
        });
        await fs.mkdir(path.join(invalidCheckout, '.zit-checkout'));
        const notDirectory = path.join(temp, 'not-directory') as ZitRoot;
        await fs.writeFile(notDirectory, 'file');
        const loop = path.join(temp, 'loop') as ZitRoot;
        await fs.mkdir(loop);
        await fs.symlink('.zit', path.join(loop, '.zit'));
        await fs.writeFile(path.join(loop, '.zit-checkout'), 'checkout');

        const executable = new ZitExecutable(outputChannel());
        const exec = sandbox
            .stub(executable, 'exec')
            .callsFake(async (cwd, args) => {
                const result = successResult(cwd, args);
                if (args[0] !== 'status') {
                    return result;
                }
                return {
                    ...result,
                    stdout: (cwd === unborn
                        ? 'On branch trunk (no check-ins yet)\n'
                        : 'On branch trunk (check-in abc123)\n') as ExecResult['stdout'],
                };
            });
        const tryOpenRepository = sandbox.stub().resolves(true);
        const commandCenter = Object.assign(
            Object.create(extensionCommands.CommandCenter.prototype),
            {
                executable,
                model: { tryOpenRepository },
            }
        ) as extensionCommands.CommandCenter;
        const checkin = 'trunk' as ZitCheckin;

        assert.equal(
            await OpenedRepository.isMaterialized(executable, materialized),
            true
        );
        assert.equal(
            await OpenedRepository.isMaterialized(executable, fileMaterialized),
            true
        );
        assert.equal(
            await OpenedRepository.isMaterialized(executable, unborn),
            false
        );
        assert.equal(
            await OpenedRepository.isMaterialized(executable, invalidCheckout),
            false
        );
        assert.equal(
            await OpenedRepository.isMaterialized(executable, notDirectory),
            false
        );
        await assert.rejects(
            OpenedRepository.isMaterialized(executable, loop),
            (error: NodeJS.ErrnoException) => error.code === 'ELOOP'
        );
        assert.equal(
            await OpenedRepository.isMaterialized(executable, bare),
            false
        );
        assert.equal(
            await OpenedRepository.isMaterialized(
                executable,
                path.join(temp, 'missing') as ZitRoot
            ),
            false
        );

        exec.resetHistory();
        await commandCenter.openRepository(materialized, checkin);
        sinon.assert.calledOnceWithExactly(
            exec,
            materialized,
            ['status'],
            undefined,
            { logErrors: false }
        );
        sinon.assert.calledOnceWithExactly(tryOpenRepository, materialized);

        exec.resetHistory();
        tryOpenRepository.resetHistory();
        await commandCenter.openRepository(unborn, checkin);
        assert.deepEqual(
            exec.getCalls().map(call => call.args),
            [
                [unborn, ['status'], undefined, { logErrors: false }],
                [unborn, ['open', checkin]],
            ]
        );
        sinon.assert.calledOnceWithExactly(tryOpenRepository, unborn);

        exec.resetHistory();
        tryOpenRepository.resetHistory();
        await commandCenter.openRepository(bare, checkin);
        sinon.assert.calledOnceWithExactly(exec, bare, ['open', checkin]);
        sinon.assert.calledOnceWithExactly(tryOpenRepository, bare);

        exec.resetHistory();
        exec.resetBehavior();
        tryOpenRepository.resetHistory();
        exec.resolves({
            ...successResult(bare, ['open', checkin]),
            exitCode: 1,
        } as ExecResult);
        await commandCenter.openRepository(bare, checkin);
        sinon.assert.notCalled(tryOpenRepository);

        const cancellation = Object.assign(new Error('Canceled'), {
            name: 'AbortError',
        });
        exec.resetHistory();
        exec.resetBehavior();
        exec.rejects(cancellation);
        await assert.rejects(
            commandCenter.openRepository(bare, checkin),
            error => error === cancellation
        );
    });

    test('clone materializes accepted unborn checkout without masking exits', async () => {
        const executable = new ZitExecutable(outputChannel());
        const temp = await fs.mkdtemp(
            path.join(os.tmpdir(), 'vscode-zit-clone-')
        );
        temporaryPaths.push(temp);
        const root = path.join(temp, 'checkout') as ZitRoot;
        const checkout = path.join(root, '.zit-checkout');
        const uri = Uri.parse('https://example.test/repository') as ZitURI;
        let cloneCalls = 0;
        const exec = sandbox
            .stub(executable, 'exec')
            .callsFake(async (cwd, args) => {
                if (args[0] === 'clone') {
                    cloneCalls++;
                    if (cloneCalls === 3) {
                        return {
                            ...successResult(cwd, args),
                            exitCode: 1,
                        } as ExecResult;
                    }
                    await fs.mkdir(path.join(root, '.zit'), {
                        recursive: true,
                    });
                    // Clone writes five empty length-prefixed fields: the
                    // checkout record exists, but its current version is unborn.
                    await fs.writeFile(checkout, '\x00'.repeat(10));
                } else if (args[0] === 'open') {
                    await fs.writeFile(
                        checkout,
                        `\x40\x00${'a'.repeat(64)}\x05\x00trunk${'\x00'.repeat(6)}`
                    );
                }
                return successResult(cwd, args);
            });
        const inputRepoUrl = sandbox.stub(interaction, 'inputRepoUrl');
        inputRepoUrl.resolves(uri);
        inputRepoUrl.onFirstCall().resolves(undefined);
        const selectCheckoutDirectory = sandbox.stub(
            interaction,
            'selectCheckoutDirectory'
        );
        selectCheckoutDirectory.resolves(root);
        selectCheckoutDirectory.onFirstCall().resolves(undefined);
        const cloneSignal = new AbortController().signal;
        const runCloneWithProgress = sandbox
            .stub(interaction, 'runCloneWithProgress')
            .callsFake(async operation => operation(cloneSignal));
        const promptOpenClonedRepo = sandbox.stub(
            interaction,
            'promptOpenClonedRepo'
        );
        promptOpenClonedRepo.onFirstCall().resolves(false);
        promptOpenClonedRepo.onSecondCall().resolves(true);
        const tryOpenRepository = sandbox.stub().resolves(true);
        const commandCenter = Object.assign(
            Object.create(extensionCommands.CommandCenter.prototype),
            {
                executable,
                model: { tryOpenRepository },
                outputChannel: outputChannel(),
            }
        ) as extensionCommands.CommandCenter;

        await commandCenter.clone();
        await commandCenter.clone();
        await commandCenter.clone();
        await commandCenter.clone();
        await commandCenter.clone();

        sinon.assert.callCount(exec, 4);
        assert.deepEqual(
            exec.getCalls().map(call => call.args),
            [
                [
                    path.dirname(root),
                    ['clone', uri.toString(), root],
                    undefined,
                    { signal: cloneSignal },
                ],
                [
                    path.dirname(root),
                    ['clone', uri.toString(), root],
                    undefined,
                    { signal: cloneSignal },
                ],
                [root, ['open']],
                [
                    path.dirname(root),
                    ['clone', uri.toString(), root],
                    undefined,
                    { signal: cloneSignal },
                ],
            ]
        );
        sinon.assert.callCount(runCloneWithProgress, 3);
        sinon.assert.callCount(promptOpenClonedRepo, 2);
        sinon.assert.calledOnceWithExactly(tryOpenRepository, root);
        const materialized = await fs.readFile(checkout);
        assert.equal(materialized.readUInt16LE(0), 64);
    });

    test('init and open handle canceled, successful, and failed lifecycles', async () => {
        const executable = new ZitExecutable(outputChannel());
        const root = path.join(os.tmpdir(), 'command-lifecycle') as ZitRoot;
        const exec = sandbox
            .stub(executable, 'exec')
            .callsFake(async (cwd, args) => successResult(cwd, args));
        exec.onSecondCall().resolves({
            ...successResult(path.dirname(root) as ZitCWD, ['init', root]),
            exitCode: 1,
        } as ExecResult);
        const selectCheckoutDirectory = sandbox.stub(
            interaction,
            'selectCheckoutDirectory'
        );
        selectCheckoutDirectory.resolves(root);
        selectCheckoutDirectory.onFirstCall().resolves(undefined);
        selectCheckoutDirectory.onCall(3).resolves(undefined);
        const tryOpenRepository = sandbox.stub().resolves(true);
        const commandCenter = Object.assign(
            Object.create(extensionCommands.CommandCenter.prototype),
            {
                executable,
                model: { tryOpenRepository },
                outputChannel: outputChannel(),
            }
        ) as extensionCommands.CommandCenter;
        const openRepository = sandbox
            .stub(commandCenter, 'openRepository')
            .resolves();

        await commandCenter.init();
        await commandCenter.init();
        await commandCenter.init();
        await commandCenter.open();
        await commandCenter.open();

        sinon.assert.callCount(exec, 2);
        sinon.assert.calledOnceWithExactly(tryOpenRepository, root);
        sinon.assert.calledOnceWithExactly(openRepository, root);
    });

    test('discovers exactly the supported Zit commands', async () => {
        const expected = [
            'zit.add',
            'zit.addAll',
            'zit.annotate',
            'zit.branch',
            'zit.branchChange',
            'zit.cherrypick',
            'zit.clean',
            'zit.clone',
            'zit.closeBranch',
            'zit.commit',
            'zit.commitAll',
            'zit.commitBranch',
            'zit.commitWithInput',
            'zit.fileLog',
            'zit.forget',
            'zit.gitExport',
            'zit.ignore',
            'zit.init',
            'zit.log',
            'zit.merge',
            'zit.open',
            'zit.openChange',
            'zit.openChangeFromUri',
            'zit.openFile',
            'zit.openFileFromUri',
            'zit.openFiles',
            'zit.openResource',
            'zit.pull',
            'zit.push',
            'zit.pushTo',
            'zit.redo',
            'zit.refresh',
            'zit.rename',
            'zit.revert',
            'zit.revertAll',
            'zit.revertChange',
            'zit.showOutput',
            'zit.stashApply',
            'zit.stashDrop',
            'zit.stashPop',
            'zit.stashSave',
            'zit.stashShow',
            'zit.sync',
            'zit.tagAdd',
            'zit.undo',
            'zit.update',
        ];
        const removed = [
            'zit.close',
            'zit.commitStaged',
            'zit.openUI',
            'zit.patchApply',
            'zit.patchCreate',
            'zit.render',
            'zit.renderSave',
            'zit.stage',
            'zit.stageAll',
            'zit.tagCancel',
            'zit.unstage',
            'zit.unstageAll',
            'zit.wikiCreate',
        ];
        const allCommands = await commands.getCommands(true);
        const discovered = allCommands
            .filter(command => command.startsWith('zit.'))
            .sort();

        assert.deepEqual(discovered, expected);
        for (const command of removed) {
            assert.ok(
                !allCommands.includes(command),
                `${command} must not be registered`
            );
        }
    });
});
