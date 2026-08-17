import { commands, Uri, window } from 'vscode';
import * as sinon from 'sinon';
import {
    fakeExecutionResult,
    getExecStub,
    getModel,
    getRepository,
    statusBarCommands,
    stubZitConfig,
} from './common';
import * as assert from 'assert/strict';
import { Suite, suiteTeardown, suiteSetup } from 'mocha';
import { Reason } from '../../zitExecutable';
import { ZitURI } from '../../openedRepository';

interface ConfigurationHandler {
    onDidChangeConfiguration(event: {
        affectsConfiguration(key: string): boolean;
    }): Promise<void> | void;
}

export function StatusBarSuite(this: Suite): void {
    let fakeTimers: sinon.SinonFakeTimers;
    const now = new Date('2024-11-23T16:51:31.000Z');

    suiteSetup(async () => {
        await getRepository().updateStatus('Test: status bar setup' as Reason);
        fakeTimers = sinon.useFakeTimers({
            now,
            shouldClearNativeTimers: true,
        });
    });

    suiteTeardown(() => fakeTimers.restore());

    test('shows Zit branch and sync commands', () => {
        const [branchBar, syncBar] = statusBarCommands();
        assert.equal(branchBar.command, 'zit.branchChange');
        assert.equal(branchBar.title, '$(git-branch) trunk');
        assert.equal(branchBar.tooltip?.split('\n').pop(), 'Change Branch...');
        assert.deepEqual(branchBar.arguments, [getRepository()]);
        assert.equal(syncBar.command, 'zit.sync');
        assert.equal(syncBar.title, '$(sync)');
        assert.match(syncBar.tooltip!, /^Next sync \d\d:\d\d:\d\d\nSync$/);
        assert.deepEqual(syncBar.arguments, [getRepository()]);
    });

    test('runs one Zit sync and reports success', async () => {
        const exec = getExecStub(this.ctx.sandbox);
        exec.withArgs(['remote']).resolves(
            fakeExecutionResult({ stdout: 'https://example.com/repo.zit\n' })
        );
        const sync = exec.withArgs(['sync']).resolves(fakeExecutionResult());
        this.ctx.sandbox.stub(window, 'showInputBox').resolves('');
        await commands.executeCommand('zit.sync');

        sinon.assert.calledOnce(sync);
        assert.deepEqual(sync.firstCall.args[0], ['sync']);
        assert.equal(sync.firstCall.args[1], undefined);
        assert.ok(sync.firstCall.args[2]?.signal instanceof AbortSignal);
        assert.match(
            statusBarCommands()[1].tooltip!,
            /^Next sync \d\d:\d\d:\d\d\nSync$/
        );
    });

    test('spins while Zit sync is running', async () => {
        const exec = getExecStub(this.ctx.sandbox);
        exec.withArgs(['remote']).resolves(
            fakeExecutionResult({ stdout: 'https://example.com/repo.zit\n' })
        );
        const sync = exec.withArgs(['sync']).callsFake(async () => {
            assert.equal(statusBarCommands()[1].title, '$(sync~spin)');
            return fakeExecutionResult();
        });
        this.ctx.sandbox.stub(window, 'showInputBox').resolves('');

        await commands.executeCommand('zit.sync');

        sinon.assert.calledOnce(sync);
    });

    test('shows Zit sync failure text', async () => {
        this.ctx.sandbox.stub(window, 'showErrorMessage').resolves(undefined);
        const exec = getExecStub(this.ctx.sandbox);
        exec.withArgs(['remote']).resolves(
            fakeExecutionResult({ stdout: 'https://example.com/repo.zit\n' })
        );
        const sync = exec.withArgs(['sync']).resolves(
            fakeExecutionResult({
                stderr: 'network unavailable',
                exitCode: 1,
            })
        );
        this.ctx.sandbox.stub(window, 'showInputBox').resolves('');

        await commands.executeCommand('zit.sync');

        sinon.assert.calledOnce(sync);
        assert.match(
            statusBarCommands()[1].tooltip!,
            /^Next sync \d\d:\d\d:\d\d\nSync error: network unavailable\nSync$/
        );
    });

    test('identifies a repository with no remote', async () => {
        this.ctx.sandbox.stub(window, 'showErrorMessage').resolves(undefined);
        const exec = getExecStub(this.ctx.sandbox);
        exec.withArgs(['remote']).resolves(
            fakeExecutionResult({ stdout: 'https://example.com/repo.zit\n' })
        );
        exec.withArgs(['sync']).resolves(
            fakeExecutionResult({
                stderr: 'zit sync: no remote is set',
                exitCode: 1,
            })
        );
        this.ctx.sandbox.stub(window, 'showInputBox').resolves('');

        await commands.executeCommand('zit.sync');

        assert.match(
            statusBarCommands()[1].tooltip!,
            /^Next sync \d\d:\d\d:\d\d\nrepository with no remote\nSync$/
        );
    });

    test('refreshes status and autosync after configuring a remote', async () => {
        const repository = getRepository();
        const exec = getExecStub(this.ctx.sandbox);
        exec.withArgs(['remote']).resolves(
            fakeExecutionResult({ stdout: 'no remote set\n' })
        );
        await repository.periodicSync();
        const before = statusBarCommands()[1].tooltip;
        assert.match(before!, /repository with no remote/);
        const remote = Uri.parse('https://example.test/repository') as ZitURI;
        const setRemote = exec
            .withArgs(['remote', remote.toString()])
            .resolves(fakeExecutionResult());
        const nativeAutoSync = exec
            .withArgs(['settings', 'autosync', 'on'])
            .resolves(fakeExecutionResult());

        await repository.setRemote(remote);

        sinon.assert.calledOnceWithExactly(setRemote, [
            'remote',
            remote.toString(),
        ]);
        const after = statusBarCommands()[1].tooltip;
        assert.doesNotMatch(after!, /repository with no remote/);
        sinon.assert.calledOnce(nativeAutoSync);
    });

    test('marks the status bar as remote-free immediately after clear', async () => {
        const repository = getRepository();
        const exec = getExecStub(this.ctx.sandbox);
        exec.withArgs(['remote']).resolves(
            fakeExecutionResult({
                stdout: 'https://example.test/repository\n',
            })
        );
        exec.withArgs(['sync']).resolves(fakeExecutionResult());
        await repository.periodicSync();
        assert.doesNotMatch(
            statusBarCommands()[1].tooltip!,
            /repository with no remote/
        );
        const unset = exec
            .withArgs(['remote', '--unset'])
            .resolves(fakeExecutionResult());
        const nativeAutoSync = exec
            .withArgs(['settings', 'autosync', 'on'])
            .resolves(fakeExecutionResult());

        await repository.setRemote();

        sinon.assert.calledOnceWithExactly(unset, ['remote', '--unset']);
        sinon.assert.calledOnce(nativeAutoSync);
        assert.match(
            statusBarCommands()[1].tooltip!,
            /repository with no remote/
        );
    });

    test('failed remote changes preserve displayed and persisted state', async () => {
        const repository = getRepository();
        const current = Uri.parse('https://example.test/current') as ZitURI;
        const replacement = Uri.parse(
            'https://example.test/replacement'
        ) as ZitURI;
        const exec = getExecStub(this.ctx.sandbox);
        exec.withArgs(['remote']).resolves(
            fakeExecutionResult({ stdout: `${current.toString()}\n` })
        );
        exec.withArgs(['sync']).resolves(fakeExecutionResult());
        await repository.periodicSync();
        const before = statusBarCommands()[1].tooltip;
        const failed = exec
            .withArgs(['remote', replacement.toString()])
            .resolves(
                fakeExecutionResult({
                    exitCode: 1,
                    stderr: 'zit remote: rejected\n',
                })
            );

        await repository.setRemote(replacement);

        sinon.assert.calledOnce(failed);
        assert.equal(statusBarCommands()[1].tooltip, before);
        assert.equal(
            (await repository.getRemote())?.toString(),
            current.toString()
        );
    });

    async function changeAutoSyncIntervalSeconds(
        sandbox: sinon.SinonSandbox,
        seconds: number
    ): Promise<void> {
        const config = stubZitConfig(sandbox);
        const interval = config.get
            .withArgs('autoSyncInterval')
            .returns(seconds);
        const exec = getExecStub(sandbox);
        exec.withArgs(['sync']).resolves(fakeExecutionResult());
        exec.withArgs(['remote']).resolves(
            fakeExecutionResult({ stdout: 'https://example.com/repo.zit\n' })
        );
        await getRepository().periodicSync();
        interval.resetHistory();
        const nativeSetting = exec
            .withArgs(['settings', 'autosync', seconds ? 'on' : 'off'])
            .resolves(fakeExecutionResult());
        const model = getModel() as unknown as ConfigurationHandler;

        await model.onDidChangeConfiguration({
            affectsConfiguration: key =>
                ['zit.autoSyncInterval', 'zit'].includes(key),
        });

        sinon.assert.calledOnce(interval);
        sinon.assert.calledOnce(nativeSetting);
    }

    test('persists enabled Zit autosync after an explicit setting change', async () => {
        await changeAutoSyncIntervalSeconds(this.ctx.sandbox, 5 * 60);
        const next = new Date(now.getTime() + 5 * 60 * 1000)
            .toTimeString()
            .split(' ')[0];

        assert.equal(statusBarCommands()[1].tooltip, `Next sync ${next}\nSync`);
    });

    test('persists disabled Zit autosync after an explicit setting change', async () => {
        await changeAutoSyncIntervalSeconds(this.ctx.sandbox, 0);

        assert.equal(
            statusBarCommands()[1].tooltip,
            'Auto sync disabled\nSync'
        );
    });

    test('periodic sync runs exact Zit argv without interactive errors', async () => {
        const exec = getExecStub(this.ctx.sandbox);
        exec.withArgs(['remote']).resolves(
            fakeExecutionResult({ stdout: 'https://example.com/repo.zit\n' })
        );
        const sync = exec.withArgs(['sync']).resolves(fakeExecutionResult());

        await getRepository().periodicSync();

        sinon.assert.calledOnceWithExactly(sync, ['sync'], undefined, {
            logErrors: false,
        });
    });

    test('periodic sync skips repositories without a remote and reschedules', async () => {
        const repository = getRepository();
        const internal = repository as unknown as {
            autoSyncTimer?: unknown;
        };
        const previousTimer = internal.autoSyncTimer;
        const exec = getExecStub(this.ctx.sandbox);
        const remote = exec
            .withArgs(['remote'])
            .resolves(fakeExecutionResult({ stdout: 'no remote set\n' }));
        const sync = exec.withArgs(sinon.match.array.startsWith(['sync']));
        const error = this.ctx.sandbox.stub(window, 'showErrorMessage');

        await repository.periodicSync();

        sinon.assert.calledOnceWithExactly(remote, ['remote']);
        sinon.assert.notCalled(sync);
        sinon.assert.notCalled(error);
        assert.ok(internal.autoSyncTimer);
        assert.notEqual(internal.autoSyncTimer, previousTimer);
        assert.match(
            statusBarCommands()[1].tooltip!,
            /^Next sync \d\d:\d\d:\d\d\nrepository with no remote\nSync$/
        );
    });

    test('shows unborn unknown branch state without a check-in', () => {
        const repository = getRepository();
        const internal = repository as unknown as {
            _currentBranch: string | undefined;
            _zitStatus: { checkin?: string };
            statusBar: { update(): void };
        };
        const previousBranch = internal._currentBranch;
        const previousStatus = internal._zitStatus;
        internal._currentBranch = undefined;
        internal._zitStatus = { ...previousStatus, checkin: undefined };

        try {
            internal.statusBar.update();
            const branch = statusBarCommands()[0];
            assert.equal(branch.title, '$(git-branch) unknown');
            assert.equal(branch.tooltip, 'no check-ins yet\nChange Branch...');
        } finally {
            internal._currentBranch = previousBranch;
            internal._zitStatus = previousStatus;
            internal.statusBar.update();
        }
    });
}
