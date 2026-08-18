import { Uri, window, commands } from 'vscode';
import * as sinon from 'sinon';
import {
    assertGroups,
    cleanupZit,
    fakeExecutionResult,
    fakeStatusResult,
    fakeZitStatus,
    fakeUpdateResult,
    getExecStub,
    getRepository,
} from './common';
import * as assert from 'assert/strict';
import * as fs from 'fs/promises';
import {
    ZitCheckin,
    ZitCommitMessage,
    OpenedRepository,
    ResourceStatus,
    StashID,
} from '../../openedRepository';
import { Suite, suiteTeardown, suiteSetup } from 'mocha';
import { Reason } from '../../zitExecutable';

function getOpenedRepository(): OpenedRepository {
    const opened = Reflect.get(getRepository(), 'repository') as unknown;
    assert.ok(opened instanceof OpenedRepository);
    return opened;
}

function PullAndPushSuite(this: Suite): void {
    const noRemote = async (command: 'zit.pull' | 'zit.push') => {
        const exec = getExecStub(this.ctx.sandbox);
        const remote = exec
            .withArgs(['remote'])
            .resolves(fakeExecutionResult({ stdout: 'no remote set\n' }));
        const error = this.ctx.sandbox.stub(
            window,
            'showErrorMessage'
        ) as sinon.SinonStub;
        error.resolves(undefined);

        await commands.executeCommand(command);

        sinon.assert.calledOnceWithExactly(remote, ['remote']);
        sinon.assert.calledOnceWithExactly(
            error,
            'Your repository has no remotes configured.'
        );
    };

    test('Pull with no saved remote', async () => {
        await noRemote('zit.pull');
    });

    test('Push with no saved remote', async () => {
        await noRemote('zit.push');
    });

    test('Pull from the saved Zit remote', async () => {
        const exec = getExecStub(this.ctx.sandbox);
        const remote = exec.withArgs(['remote']).resolves(
            fakeExecutionResult({
                stdout: 'https://example.com/repo.zit\n',
            })
        );
        const pull = exec.withArgs(['pull']).resolves(fakeExecutionResult());

        await commands.executeCommand('zit.pull');

        const signal = pull.firstCall.args[2]?.signal;
        assert.ok(signal instanceof AbortSignal);
        sinon.assert.calledOnceWithExactly(remote, ['remote']);
        sinon.assert.calledOnceWithExactly(pull, ['pull'], undefined, {
            signal,
        });
    });

    test('Push anonymously to the saved Zit remote', async () => {
        const exec = getExecStub(this.ctx.sandbox);
        const remote = exec.withArgs(['remote']).resolves(
            fakeExecutionResult({
                stdout: 'https://example.com/repo.zit\n',
            })
        );
        const push = exec.withArgs(['push']).resolves(fakeExecutionResult());
        this.ctx.sandbox.stub(window, 'showInputBox').resolves('');

        await commands.executeCommand('zit.push');

        const signal = push.firstCall.args[2]?.signal;
        assert.ok(signal instanceof AbortSignal);
        sinon.assert.calledOnceWithExactly(remote, ['remote']);
        sinon.assert.calledOnceWithExactly(push, ['push'], undefined, {
            signal,
        });
    });

    test('PushTo prompts for a URL and does not persist credentials', async () => {
        const exec = getExecStub(this.ctx.sandbox);
        exec.withArgs(['remote']).resolves(
            fakeExecutionResult({
                stdout: 'https://example.com/old.zit\n',
            })
        );
        const push = exec
            .withArgs(['push', 'https://example.com/new.zit'])
            .resolves(fakeExecutionResult());
        const input = this.ctx.sandbox.stub(window, 'showInputBox');
        input.onFirstCall().resolves('https://example.com/new.zit');
        input.onSecondCall().resolves('');

        await commands.executeCommand('zit.pushTo');

        const signal = push.firstCall.args[2]?.signal;
        assert.ok(signal instanceof AbortSignal);
        sinon.assert.calledTwice(input);
        sinon.assert.calledOnceWithExactly(
            push,
            ['push', 'https://example.com/new.zit'],
            undefined,
            { signal }
        );
    });
}

export function UpdateSuite(this: Suite): void {
    PullAndPushSuite.call(this);

    test('Change branch to trunk', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        const updateCall = execStub
            .withArgs(['update', 'trunk' as ZitCheckin])
            .resolves(fakeUpdateResult());

        const sqp = this.ctx.sandbox.stub(window, 'showQuickPick');
        sqp.onFirstCall().callsFake(items => {
            assert.ok(items instanceof Array);
            assert.equal(items[2].label, '$(git-branch) trunk');
            assert.equal(items[2].description, 'current');
            assert.equal(items[2].detail, undefined);
            return Promise.resolve(items[2]);
        });

        await commands.executeCommand('zit.branchChange');
        sinon.assert.calledOnce(sqp);
        sinon.assert.calledOnce(updateCall);
    });

    test('Update command switches to the selected ref', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        execStub
            .withArgs(['branch'])
            .resolves(fakeExecutionResult({ stdout: '* trunk\n  feature\n' }));
        execStub
            .withArgs(['tag', 'list'])
            .resolves(fakeExecutionResult({ stdout: '' }));
        const update = execStub
            .withArgs(['update', 'feature' as ZitCheckin])
            .resolves(fakeUpdateResult());
        this.ctx.sandbox.stub(window, 'showQuickPick').callsFake(items => {
            assert.ok(items instanceof Array);
            const feature = items.find(
                item => item.label === '$(git-branch) feature'
            );
            assert.ok(feature);
            return Promise.resolve(feature);
        });

        await commands.executeCommand('zit.update');

        sinon.assert.calledOnce(update);
    });

    test('Canceling the update picker does not switch refs', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        execStub
            .withArgs(['branch'])
            .resolves(fakeExecutionResult({ stdout: '* trunk\n' }));
        execStub
            .withArgs(['tag', 'list'])
            .resolves(fakeExecutionResult({ stdout: '' }));
        const update = execStub.withArgs(
            sinon.match.array.startsWith(['update'])
        );
        this.ctx.sandbox.stub(window, 'showQuickPick').resolves(undefined);

        await commands.executeCommand('zit.update');

        sinon.assert.notCalled(update);
    });

    const selectTrunk = async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        fakeZitStatus(
            execStub,
            'added fake.txt\npending merge with ' + 'a'.repeat(64)
        );
        const repository = getRepository();
        await repository.updateStatus('Test' as Reason);
        assert.ok(repository.zitStatus?.isMerge);

        const updateCall = execStub
            .withArgs(['update', 'trunk' as ZitCheckin])
            .resolves(fakeUpdateResult());

        const showQuickPick = this.ctx.sandbox.stub(window, 'showQuickPick');
        showQuickPick.onFirstCall().callsFake(items => {
            assert.ok(items instanceof Array);
            assert.equal(items[2].label, '$(git-branch) trunk');
            return Promise.resolve(items[2]);
        });

        const swm: sinon.SinonStub = this.ctx.sandbox.stub(
            window,
            'showWarningMessage'
        );
        return [swm, updateCall];
    };

    test('Change branch to trunk when merge is active', async () => {
        const [swm, updateCall] = await selectTrunk();
        swm.resolves('Continue' as any);
        await commands.executeCommand('zit.branchChange');
        sinon.assert.calledOnce(swm);
        sinon.assert.calledOnce(updateCall);
    });

    test('Change branch to trunk when merge is active (cancel)', async () => {
        const [swm, updateCall] = await selectTrunk();
        swm.resolves();
        await commands.executeCommand('zit.branchChange');
        sinon.assert.calledOnce(swm);
        sinon.assert.notCalled(updateCall);
    });

    test('Change branch to hash', async () => {
        await cleanupZit(getRepository());
        const execStub = getExecStub(this.ctx.sandbox);
        const updateCall = execStub
            .withArgs(['update', '1234567890' as ZitCheckin])
            .resolves(fakeUpdateResult());

        const showQuickPick = this.ctx.sandbox.stub(window, 'showQuickPick');
        showQuickPick.onFirstCall().callsFake(items => {
            assert.ok(items instanceof Array);
            assert.equal(items[0].label, '$(pencil) Checkout by hash');
            assert.equal(items[0].description, undefined);
            assert.equal(items[0].detail, undefined);
            return Promise.resolve(items[0]);
        });
        const showInputBox = this.ctx.sandbox.stub(window, 'showInputBox');
        showInputBox.onFirstCall().resolves('1234567890');
        await commands.executeCommand('zit.branchChange');

        sinon.assert.calledOnce(showInputBox);
        sinon.assert.calledOnce(updateCall);
    });

    test('Change branch to hash (cancel)', async () => {
        const showQuickPick = this.ctx.sandbox.stub(window, 'showQuickPick');
        showQuickPick.onFirstCall().callsFake(items => {
            assert.ok(items instanceof Array);
            assert.equal(items[0].label, '$(pencil) Checkout by hash');
            return Promise.resolve(items[0]);
        });
        const showInputBox = this.ctx.sandbox.stub(window, 'showInputBox');
        showInputBox.onFirstCall().resolves();
        await commands.executeCommand('zit.branchChange');
        sinon.assert.calledOnce(showInputBox);
    });

    test('Change branch to tag', async () => {
        const showQuickPick = this.ctx.sandbox.stub(window, 'showQuickPick');

        const execStub = getExecStub(this.ctx.sandbox);
        const tagsStub = execStub
            .withArgs(['tag', 'list'])
            .resolves(fakeExecutionResult({ stdout: 'a\nb $(plus)\nc c c' }));
        const branchesStub = execStub
            .withArgs(['branch'])
            .resolves(
                fakeExecutionResult({ stdout: '  d\n  e $(plus)\n  f f f\n' })
            );

        showQuickPick.onFirstCall().callsFake(items => {
            assert.ok(items instanceof Array);
            assert.equal(items[0].label, '$(pencil) Checkout by hash');
            assert.equal(items[1].label, '');
            assert.equal(items[2].label, '$(git-branch) d');
            assert.equal(items[3].label, '$(git-branch) e $(plus)');
            assert.equal(items[4].label, '$(git-branch) f f f');
            assert.equal(items[5].label, '$(tag) a');
            assert.equal(items[6].label, '$(tag) b $(plus)');
            assert.equal(items[7].label, '$(tag) c c c');
            return Promise.resolve(items[5]);
        });
        const updateCall = execStub
            .withArgs(['update', 'a' as ZitCheckin])
            .resolves(fakeUpdateResult());
        await commands.executeCommand('zit.branchChange');
        sinon.assert.calledOnce(tagsStub);
        sinon.assert.calledOnce(branchesStub);
        sinon.assert.calledOnce(showQuickPick);
        sinon.assert.calledOnce(updateCall);
    });

    test('Dirty update refusal preserves working state', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        fakeZitStatus(execStub, 'edited dirty.txt');
        const repository = getRepository();
        await repository.updateStatus('Test' as Reason);
        const updateCall = execStub
            .withArgs(['update', 'trunk' as ZitCheckin])
            .resolves(
                fakeExecutionResult({
                    exitCode: 1,
                    stderr: 'zit update: local changes would be overwritten',
                })
            );

        const result = await repository.update('trunk' as ZitCheckin);

        assert.equal(result.exitCode, 1);
        sinon.assert.calledOnce(updateCall);
        assertGroups(repository, {
            working: [
                [
                    Uri.joinPath(this.ctx.workspaceUri, 'dirty.txt').fsPath,
                    ResourceStatus.MODIFIED,
                ],
            ],
        });
    });

    test('Undo and redo refresh working state', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        const status = fakeZitStatus(execStub, 'edited restored.txt');
        const undo = execStub
            .withArgs(['undo'])
            .resolves(fakeExecutionResult());
        const redo = execStub
            .withArgs(['redo'])
            .resolves(fakeExecutionResult());
        const repository = getRepository();

        await repository.undoOrRedo('undo');
        sinon.assert.calledOnceWithExactly(undo, ['undo']);
        assertGroups(repository, {
            working: [
                [
                    Uri.joinPath(this.ctx.workspaceUri, 'restored.txt').fsPath,
                    ResourceStatus.MODIFIED,
                ],
            ],
        });

        status.resolves(fakeStatusResult(''));
        execStub
            .withArgs(['diff', '--brief'])
            .resolves(fakeExecutionResult({ stdout: '' }));
        await repository.undoOrRedo('redo');
        sinon.assert.calledOnceWithExactly(redo, ['redo']);
        assertGroups(repository, {});
    });
}

export function StashSuite(this: Suite): void {
    let uri: Uri;
    /**
     * Create a file and stash it
     */
    suiteSetup(() => {
        uri = Uri.joinPath(this.ctx.workspaceUri, 'stash.txt');
    });

    test('Save', async () => {
        const repository = getRepository();
        await fs.writeFile(uri.fsPath, 'stash me');

        const sib = this.ctx.sandbox.stub(window, 'showInputBox');
        sib.onFirstCall().resolves('stashSave commit message');

        const stashSave = getExecStub(this.ctx.sandbox).withArgs([
            'stash',
            'save',
            '-m',
            'stashSave commit message',
        ]);
        await repository.updateStatus('Test' as Reason);
        const resource = repository.untrackedGroup.getResource(uri);
        assert.ok(resource);
        await commands.executeCommand('zit.add', resource);
        await commands.executeCommand('zit.stashSave');
        sinon.assert.calledOnce(stashSave);
        assertGroups(repository, {});
    }).timeout(6000);

    /**
     * Apply previously stashed item, while keeping it in the list
     */
    test('Apply', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        const stashApply = execStub.withArgs([
            'stash',
            'apply',
            `${1 as StashID}`,
        ]);
        const sqp = this.ctx.sandbox.stub(window, 'showQuickPick');
        sqp.onFirstCall().callsFake(items => {
            assert.ok(items instanceof Array);
            assert.equal(items.length, 1);
            assert.match(
                items[0].label,
                /\$\(circle-outline\) 1 • [a-f0-9]{12}/
            );
            return Promise.resolve(items[0]);
        });
        await commands.executeCommand('zit.stashApply');
        sinon.assert.calledOnce(stashApply);
        const repository = getRepository();
        assertGroups(repository, {
            added: [[uri.fsPath, ResourceStatus.ADDED]],
        });
    }).timeout(6000);

    /**
     * Remove previously created stash from the list
     */
    test('Drop', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        const stashDrop = execStub.withArgs([
            'stash',
            'drop',
            `${1 as StashID}`,
        ]);
        const sqp = this.ctx.sandbox.stub(window, 'showQuickPick');
        sqp.onFirstCall().callsFake(items => {
            assert.ok(items instanceof Array);
            assert.equal(items.length, 1);
            assert.match(
                items[0].label,
                /\$\(circle-outline\) 1 • [a-f0-9]{12}/
            );
            assert.equal(items[0].description, '1 file(s)');
            assert.equal(items[0].detail, 'stashSave commit message');
            return Promise.resolve(items[0]);
        });
        await commands.executeCommand('zit.stashDrop');
        sinon.assert.calledOnce(stashDrop);
        sinon.assert.calledOnce(sqp);

        const repository = getRepository();
        assertGroups(repository, {
            added: [[uri.fsPath, ResourceStatus.ADDED]],
        });
    }).timeout(6000);

    /**
     * Stash a file and then pop this stash
     */
    test('Pop', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        const repository = getRepository();
        const openedRepository = getOpenedRepository();
        await openedRepository.exec([
            'stash',
            'save',
            '-m',
            'in test' as ZitCommitMessage,
        ]);
        const stashPop = execStub.withArgs(['stash', 'pop', '1']);
        this.ctx.sandbox.stub(window, 'showQuickPick').callsFake(items => {
            assert.ok(items instanceof Array);
            return Promise.resolve(items[0]);
        });
        await commands.executeCommand('zit.stashPop');
        sinon.assert.calledOnce(stashPop);
        assertGroups(repository, {
            added: [[uri.fsPath, ResourceStatus.ADDED]],
        });
    }).timeout(15000);

    test('Show', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        const openedRepository = getOpenedRepository();
        await openedRepository.exec([
            'stash',
            'save',
            '-m',
            'stashShow commit message' as ZitCommitMessage,
        ]);
        await getRepository().updateStatus('Test: stash show setup' as Reason);
        const stashShow = execStub.withArgs(['stash', 'show', '1']).resolves(
            fakeExecutionResult({
                stdout: 'M stash.txt\n',
            })
        );
        this.ctx.sandbox.stub(window, 'showQuickPick').callsFake(items => {
            assert.ok(items instanceof Array);
            return Promise.resolve(items[0]);
        });

        await commands.executeCommand('zit.stashShow');

        sinon.assert.calledOnce(stashShow);
    }).timeout(15000);

    suiteTeardown(async () => {
        await cleanupZit(getRepository());
    });
}
