import {
    CancellationError,
    CancellationTokenSource,
    commands,
    ProgressLocation,
    window,
} from 'vscode';
import * as sinon from 'sinon';
import {
    assertGroups,
    cleanupZit,
    fakeExecutionResult,
    fakeZitStatus,
    fakeRawExecutionResult,
    getExecStub,
    getRawExecStub,
    getRepository,
} from './common';
import * as assert from 'assert/strict';
import {
    MergeAction,
    ZitCheckin,
    ZitCommitMessage,
    ZitHash,
} from '../../openedRepository';
import { Suite, suiteSetup } from 'mocha';
import { Reason } from '../../zitExecutable';

export function MergeSuite(this: Suite): void {
    suiteSetup(function () {
        const repository = getRepository();
        assertGroups(repository, {});
    });

    test('Merge error is shown', async () => {
        const mergeExec = getRawExecStub(this.ctx.sandbox)
            .withArgs(sinon.match.array.startsWith(['merge']))
            .resolves(
                fakeRawExecutionResult({
                    stderr:
                        'cannot find a common ancestor between ' +
                        'the current check-out and trunk',
                    exitCode: 1,
                })
            );
        const sqp = this.ctx.sandbox
            .stub(window, 'showQuickPick')
            .onFirstCall()
            .callsFake(items => {
                assert.ok(items instanceof Array);
                const item = items.find(
                    item => item.label === '$(git-branch) trunk'
                );
                assert.ok(item);
                return Promise.resolve(item);
            });
        const swm: sinon.SinonStub = this.ctx.sandbox
            .stub(window, 'showWarningMessage')
            .onFirstCall()
            .resolves();

        const sem: sinon.SinonStub = this.ctx.sandbox
            .stub(window, 'showErrorMessage')
            .onFirstCall()
            .resolves();
        const sib = this.ctx.sandbox
            .stub(window, 'showInputBox')
            .resolves('trunk merge message');

        await commands.executeCommand('zit.merge');
        sinon.assert.calledOnceWithExactly(
            mergeExec,
            ['merge', 'trunk' as ZitCheckin],
            {
                cwd: sinon.match.string,
                signal: sinon.match.instanceOf(AbortSignal),
            }
        );
        sinon.assert.calledOnce(sqp);
        sinon.assert.notCalled(sib);
        sinon.assert.notCalled(swm);
        sinon.assert.calledOnceWithExactly(
            sem,
            'Zit: cannot find a common ancestor between ' +
                'the current check-out and trunk',
            'Open Zit Log'
        );
    });

    test('Canceling merge aborts Zit and preserves cancellation', async () => {
        const repository = getRepository();
        const cancellation = new CancellationTokenSource();
        let operationSignal: AbortSignal | undefined;
        let started!: () => void;
        const operationStarted = new Promise<void>(resolve => {
            started = resolve;
        });
        const mergeExec = getExecStub(this.ctx.sandbox)
            .withArgs(['merge', 'trunk' as ZitCheckin])
            .callsFake(async (_args, _reason, options) => {
                operationSignal = options?.signal;
                started();
                if (!operationSignal) {
                    throw new Error('Merge did not receive an AbortSignal');
                }
                return new Promise((_resolve, reject) => {
                    operationSignal?.addEventListener('abort', () =>
                        reject(
                            Object.assign(new Error('aborted'), {
                                name: 'AbortError',
                                code: 'ABORT_ERR',
                            })
                        )
                    );
                });
            });
        const withProgress = this.ctx.sandbox.stub(
            window,
            'withProgress'
        ) as sinon.SinonStub;
        withProgress.callsFake(async (options, task) => {
            assert.deepEqual(options, {
                title: 'Merging Zit check-in…',
                location: ProgressLocation.Notification,
                cancellable: true,
            });
            const operation = task(
                { report: this.ctx.sandbox.stub() },
                cancellation.token
            );
            await operationStarted;
            cancellation.cancel();
            return operation;
        });

        await assert.rejects(
            repository.merge('trunk' as ZitCheckin, MergeAction.Merge),
            (error: unknown) => error instanceof CancellationError
        );

        assert.equal(operationSignal?.aborted, true);
        sinon.assert.calledOnce(mergeExec);
    });

    test('Merge', async () => {
        const repository = getRepository();
        await cleanupZit(repository);
        const execStub = getExecStub(this.ctx.sandbox);
        execStub
            .withArgs(['branch'])
            .resolves(
                fakeExecutionResult({ stdout: '* trunk\n  zit-merge\n' })
            );
        fakeZitStatus(execStub, 'edited foo-merge.txt');
        const mergeStub = execStub
            .withArgs(['merge', 'zit-merge' as ZitCheckin])
            .resolves(fakeExecutionResult());
        const commitStub = execStub
            .withArgs([
                'commit',
                '-m',
                'test merge message' as ZitCommitMessage,
            ])
            .resolves(fakeExecutionResult());
        const sqp = this.ctx.sandbox
            .stub(window, 'showQuickPick')
            .callsFake(items => {
                assert.ok(items instanceof Array);
                assert.equal(items[1].label, '$(git-branch) zit-merge');
                return Promise.resolve(items[1]);
            });
        const sib = this.ctx.sandbox
            .stub(window, 'showInputBox')
            .resolves('test merge message');

        await commands.executeCommand('zit.merge');

        const signal = mergeStub.firstCall.args[2]?.signal;
        assert.ok(signal instanceof AbortSignal);
        sinon.assert.calledOnce(sqp);
        sinon.assert.calledOnce(sib);
        sinon.assert.calledOnceWithExactly(
            mergeStub,
            ['merge', 'zit-merge' as ZitCheckin],
            undefined,
            { signal }
        );
        sinon.assert.calledOnceWithExactly(commitStub, [
            'commit',
            '-m',
            'test merge message' as ZitCommitMessage,
        ]);
    }).timeout(5000);

    test('Cancel merge when a merge is in progress', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        fakeZitStatus(execStub, `pending merge with ${'a'.repeat(64)}`);
        await getRepository().updateStatus('Test' as Reason);
        const sqp = this.ctx.sandbox.stub(window, 'showQuickPick');
        const swm: sinon.SinonStub = this.ctx.sandbox
            .stub(window, 'showWarningMessage')
            .onFirstCall()
            .resolves();

        await commands.executeCommand('zit.merge');
        sinon.assert.notCalled(sqp);
        sinon.assert.calledOnceWithExactly(
            swm,
            'Merge is in progress',
            { modal: true },
            'Continue'
        );
    });

    test('Cherrypick', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        fakeZitStatus(execStub, '');
        const repository = getRepository();
        await repository.updateStatus('Test' as Reason);
        let hash = '' as ZitHash;
        const mergeCallStub = execStub
            .withArgs(sinon.match.array.startsWith(['merge']))
            .resolves(fakeExecutionResult());

        this.ctx.sandbox
            .stub(window, 'showQuickPick')
            .onFirstCall()
            .callsFake(items => {
                assert.ok(items instanceof Array);
                assert.ok(typeof items[0].description == 'string');
                assert.match(
                    items[0].description,
                    /^\$\(person\).+ \$\(calendar\) .+$/
                );
                assert.ok(items[0].detail);
                assert.match(
                    items[0].label,
                    /\$\(circle-outline\) [0-9a-f]{12} • trunk$/
                );
                hash = (items[0] as unknown as { commit: { hash: string } })
                    .commit.hash as ZitHash;
                assert.ok(hash);
                return Promise.resolve(items[0]);
            });
        const sim = this.ctx.sandbox
            .stub(window, 'showInformationMessage')
            .withArgs('There are no changes to commit.')
            .resolves();

        await commands.executeCommand('zit.cherrypick');
        sinon.assert.calledOnceWithMatch(mergeCallStub, [
            'merge',
            '--cherrypick',
            hash,
        ]);
        sinon.assert.calledOnce(sim);
    });
}
