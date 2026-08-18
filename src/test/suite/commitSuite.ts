import * as assert from 'assert/strict';
import { commands, Uri, window, workspace, TextDocument } from 'vscode';
import * as sinon from 'sinon';
import { Suite, setup } from 'mocha';
import {
    ExecStub,
    assertGroups,
    fakeExecutionResult,
    fakeZitStatus,
    getExecStub,
    getOpenedRepository,
    getRepository,
} from './common';
import typedConfig from '../../config';
import { Reason } from '../../zitExecutable';
import {
    ZitCommitMessage,
    ResourceStatus,
    ZitUsername,
} from '../../openedRepository';

export const commitTest = async (
    sandbox: sinon.SinonSandbox,
    execStub?: ExecStub
): Promise<void> => {
    const repository = getRepository();
    execStub ??= getExecStub(sandbox);
    const statusStub = fakeZitStatus(execStub, 'added a\nadded b\n');
    const commitStub = execStub
        .withArgs(sinon.match.array.startsWith(['commit']))
        .resolves(fakeExecutionResult());

    await repository.updateStatus('Commit test' as Reason);
    sinon.assert.calledOnce(statusStub);
    const input = sandbox.stub(window, 'showInputBox').resolves('test message');
    await commands.executeCommand('zit.commit');

    sinon.assert.calledOnceWithExactly(input, {
        value: undefined,
        placeHolder: 'Commit message',
        prompt: 'Please provide a commit message',
        ignoreFocusOut: true,
    });
    sinon.assert.calledOnceWithExactly(commitStub, [
        'commit',
        '-m',
        'test message' as ZitCommitMessage,
    ]);
};

export function CommitSuite(this: Suite): void {
    const rootUri = this.ctx.workspaceUri;

    setup(() => {
        getRepository().sourceControl.inputBox.value = '';
    });

    test('Commit tracked changes using a dialog', async () => {
        await commitTest(this.ctx.sandbox);
    });

    test('Commit directly from the Source Control input box', async () => {
        const repository = getRepository();
        const execStub = getExecStub(this.ctx.sandbox);
        const statusStub = fakeZitStatus(execStub, 'edited tracked.txt\n');
        const commitStub = execStub
            .withArgs(['commit', '-m', 'working tree commit'])
            .resolves(fakeExecutionResult());

        await repository.updateStatus('Commit input test' as Reason);
        sinon.assert.calledOnce(statusStub);
        assertGroups(repository, {
            working: [
                [
                    Uri.joinPath(rootUri, 'tracked.txt').fsPath,
                    ResourceStatus.MODIFIED,
                ],
            ],
        });

        repository.sourceControl.inputBox.value = 'working tree commit';
        await commands.executeCommand('zit.commitWithInput');

        sinon.assert.calledOnce(commitStub);
        assert.equal(repository.sourceControl.inputBox.value, '');
    });

    test('Commit all tracked changes without staging', async () => {
        const repository = getRepository();
        const execStub = getExecStub(this.ctx.sandbox);
        fakeZitStatus(execStub, 'added a\nedited b\n');
        const commitStub = execStub
            .withArgs(['commit', '-m', 'all changes'])
            .resolves(fakeExecutionResult());
        this.ctx.sandbox.stub(window, 'showInputBox').resolves('all changes');

        await repository.updateStatus('Commit all test' as Reason);
        await commands.executeCommand('zit.commitAll');

        sinon.assert.calledOnce(commitStub);
    });

    test('Nothing to commit does not execute commit', async () => {
        const repository = getRepository();
        const execStub = getExecStub(this.ctx.sandbox);
        fakeZitStatus(execStub, '');
        const commitStub = execStub.withArgs(
            sinon.match.array.startsWith(['commit'])
        );
        const info = this.ctx.sandbox.stub(window, 'showInformationMessage');

        await repository.updateStatus('Nothing to commit test' as Reason);
        await commands.executeCommand('zit.commit');

        sinon.assert.notCalled(commitStub);
        sinon.assert.calledOnce(info);
    });

    test('Canceling the commit message does not execute commit', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        fakeZitStatus(execStub, 'edited tracked.txt\n');
        const commitStub = execStub.withArgs(
            sinon.match.array.startsWith(['commit'])
        );
        this.ctx.sandbox.stub(window, 'showInputBox').resolves(undefined);
        await getRepository().updateStatus(
            'Commit message cancellation' as Reason
        );

        await commands.executeCommand('zit.commit');

        sinon.assert.notCalled(commitStub);
    });

    test('Canceling branch creation does not execute commit', async () => {
        const repository = getRepository();
        const execStub = getExecStub(this.ctx.sandbox);
        fakeZitStatus(execStub, 'edited tracked.txt\n');
        await repository.updateStatus('Branch commit cancellation' as Reason);
        const commitStub = execStub.withArgs(
            sinon.match.array.startsWith(['commit'])
        );
        this.ctx.sandbox.stub(window, 'showInputBox').resolves(undefined);

        await commands.executeCommand('zit.branch');

        sinon.assert.notCalled(commitStub);
    });

    test('Commits a new branch with Zit branch argv', async () => {
        const repository = getRepository();
        const execStub = getExecStub(this.ctx.sandbox);
        fakeZitStatus(execStub, 'edited tracked.txt\n');
        await repository.updateStatus('Commit branch test' as Reason);
        const commitStub = execStub
            .withArgs(['commit', '--branch', 'feature', '-m', 'branch message'])
            .resolves(fakeExecutionResult());
        const input = this.ctx.sandbox.stub(window, 'showInputBox');
        input.onFirstCall().resolves('feature');
        input.onSecondCall().resolves('branch message');

        await commands.executeCommand('zit.commitBranch');

        sinon.assert.calledOnce(commitStub);
    });

    test('Closes the current branch with Zit close argv', async () => {
        const repository = getRepository();
        const execStub = getExecStub(this.ctx.sandbox);
        fakeZitStatus(execStub, 'edited tracked.txt\n');
        await repository.updateStatus('Close branch test' as Reason);
        const commitStub = execStub
            .withArgs(['commit', '--close', '-m', 'close message'])
            .resolves(fakeExecutionResult());
        this.ctx.sandbox.stub(window, 'showInputBox').resolves('close message');

        await commands.executeCommand('zit.closeBranch');

        sinon.assert.calledOnce(commitStub);
    });

    test('Commit refusal preserves the Source Control message', async () => {
        const repository = getRepository();
        const execStub = getExecStub(this.ctx.sandbox);
        fakeZitStatus(execStub, 'edited tracked.txt\n');
        await repository.updateStatus('Commit refusal' as Reason);
        const commitStub = execStub
            .withArgs(['commit', '-m', 'keep this message'])
            .resolves(
                fakeExecutionResult({
                    exitCode: 1,
                    stderr: 'zit commit: refused\n',
                })
            );
        repository.sourceControl.inputBox.value = 'keep this message';

        await commands.executeCommand('zit.commitWithInput');

        sinon.assert.calledOnce(commitStub);
        assert.equal(
            repository.sourceControl.inputBox.value,
            'keep this message'
        );
    });

    const prepareDirtyTrackedDocument = async () => {
        const repository = getRepository();
        const execStub = getExecStub(this.ctx.sandbox);
        const uri = Uri.joinPath(rootUri, 'dirty-open.txt');
        fakeZitStatus(execStub, '');
        const lsStub = execStub.withArgs(['ls']).resolves(
            fakeExecutionResult({
                stdout: `${'a'.repeat(64)} dirty-open.txt\n`,
            })
        );
        await repository.updateStatus('Dirty editor commit' as Reason);
        const save = this.ctx.sandbox.stub().resolves(true);
        const document = {
            uri,
            isUntitled: false,
            isDirty: true,
            save,
        } as unknown as TextDocument;
        this.ctx.sandbox.stub(workspace, 'textDocuments').value([document]);
        const clearStatus = async () => {
            fakeZitStatus(execStub, '');
            await repository.updateStatus(
                'Clear dirty editor status' as Reason
            );
        };
        return { execStub, lsStub, save, clearStatus };
    };

    test('Saves a dirty tracked editor before committing', async () => {
        const { execStub, lsStub, save, clearStatus } =
            await prepareDirtyTrackedDocument();
        const commitStub = execStub
            .withArgs(['commit', '-m', 'saved editor'])
            .resolves(fakeExecutionResult());
        const warning = this.ctx.sandbox.stub(
            window,
            'showWarningMessage'
        ) as sinon.SinonStub;
        warning.resolves('Save All & Commit');
        this.ctx.sandbox.stub(window, 'showInputBox').resolves('saved editor');

        try {
            await commands.executeCommand('zit.commit');

            sinon.assert.calledOnce(save);
            sinon.assert.calledOnceWithExactly(lsStub, ['ls']);
            sinon.assert.calledOnce(commitStub);
        } finally {
            await clearStatus();
        }
    });

    test('Canceling a dirty-editor prompt does not commit', async () => {
        const { execStub, lsStub, save, clearStatus } =
            await prepareDirtyTrackedDocument();
        const commitStub = execStub.withArgs(
            sinon.match.array.startsWith(['commit'])
        );
        const warning = this.ctx.sandbox.stub(
            window,
            'showWarningMessage'
        ) as sinon.SinonStub;
        warning.resolves(undefined);
        try {
            await commands.executeCommand('zit.commit');

            sinon.assert.notCalled(save);
            sinon.assert.calledOnceWithExactly(lsStub, ['ls']);
            sinon.assert.notCalled(commitStub);
        } finally {
            await clearStatus();
        }
    });
    test('Does not commit when tracked-file discovery fails', async () => {
        const repository = getRepository();
        const execStub = getExecStub(this.ctx.sandbox);
        fakeZitStatus(execStub, 'edited other.txt\n');
        await repository.updateStatus(
            'Failed tracked-file discovery' as Reason
        );
        const document = {
            uri: Uri.joinPath(rootUri, 'dirty-open.txt'),
            isUntitled: false,
            isDirty: true,
            save: this.ctx.sandbox.stub().resolves(true),
        } as unknown as TextDocument;
        this.ctx.sandbox.stub(workspace, 'textDocuments').value([document]);
        const lsStub = execStub.withArgs(['ls']).resolves(
            fakeExecutionResult({
                exitCode: 1,
                stderr: 'zit ls: repository unavailable\n',
            })
        );
        repository.sourceControl.inputBox.value = 'must not commit';
        const commitStub = execStub
            .withArgs(['commit', '-m', 'must not commit'])
            .resolves(fakeExecutionResult());

        try {
            await assert.rejects(
                Promise.resolve(commands.executeCommand('zit.commitWithInput')),
                /repository unavailable/
            );
            sinon.assert.calledOnceWithExactly(lsStub, ['ls']);
            sinon.assert.notCalled(commitStub);
        } finally {
            repository.sourceControl.inputBox.value = '';
            fakeZitStatus(execStub, '');
            await repository.updateStatus(
                'Clear failed tracked-file discovery status' as Reason
            );
        }
    });
    test('Warns about multiple dirty tracked editors before commit', async () => {
        const repository = getRepository();
        const execStub = getExecStub(this.ctx.sandbox);
        fakeZitStatus(execStub, 'edited other.txt\n');
        await repository.updateStatus('Dirty editor plural warning' as Reason);
        const documents = ['dirty-one.txt', 'dirty-two.txt'].map(name => ({
            uri: Uri.joinPath(rootUri, name),
            isUntitled: false,
            isDirty: true,
            save: this.ctx.sandbox.stub().resolves(true),
        })) as unknown as TextDocument[];
        this.ctx.sandbox.stub(workspace, 'textDocuments').value(documents);
        const lsStub = execStub.withArgs(['ls']).resolves(
            fakeExecutionResult({
                stdout:
                    `${'a'.repeat(64)} dirty-one.txt\n` +
                    `${'b'.repeat(64)} dirty-two.txt\n`,
            })
        );
        const warning = this.ctx.sandbox.stub(
            window,
            'showWarningMessage'
        ) as sinon.SinonStub;
        warning.callsFake(
            (
                _message: string,
                _options: unknown,
                _saveAndCommit: string,
                commitWithoutSaving: string
            ) => Promise.resolve(commitWithoutSaving)
        );
        this.ctx.sandbox.stub(window, 'showInputBox').resolves('plural dirty');
        const commitStub = execStub
            .withArgs(['commit', '-m', 'plural dirty'])
            .resolves(fakeExecutionResult());

        try {
            await commands.executeCommand('zit.commit');

            assert.match(
                warning.firstCall.args[0],
                /There are 2 unsaved files/
            );
            sinon.assert.calledOnceWithExactly(lsStub, ['ls']);
            sinon.assert.calledOnce(commitStub);
            for (const document of documents) {
                sinon.assert.notCalled(document.save as sinon.SinonStub);
            }
        } finally {
            fakeZitStatus(execStub, '');
            await repository.updateStatus(
                'Clear plural dirty status' as Reason
            );
        }
    });
    test('Uses the default username only as a commit fallback', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        this.ctx.sandbox
            .stub(typedConfig, 'defaultUsername')
            .get(() => 'default-author' as ZitUsername);
        const commitStub = execStub
            .withArgs([
                'commit',
                '--user',
                'default-author',
                '-m',
                'fallback author',
            ])
            .resolves(fakeExecutionResult());

        await getOpenedRepository().commit(
            'fallback author' as ZitCommitMessage,
            '' as ZitUsername,
            undefined
        );

        sinon.assert.calledOnceWithExactly(commitStub, [
            'commit',
            '--user',
            'default-author',
            '-m',
            'fallback author',
        ]);
    });

    test('An explicit commit username overrides the default', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        this.ctx.sandbox
            .stub(typedConfig, 'defaultUsername')
            .get(() => 'default-author' as ZitUsername);
        const commitStub = execStub
            .withArgs([
                'commit',
                '--user',
                'explicit-author',
                '-m',
                'explicit author',
            ])
            .resolves(fakeExecutionResult());

        await getOpenedRepository().commit(
            'explicit author' as ZitCommitMessage,
            'explicit-author' as ZitUsername,
            undefined
        );

        sinon.assert.calledOnceWithExactly(commitStub, [
            'commit',
            '--user',
            'explicit-author',
            '-m',
            'explicit author',
        ]);
    });

    test('Commit args with an explicit user suppress the default', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        this.ctx.sandbox
            .stub(typedConfig, 'defaultUsername')
            .get(() => 'default-author' as ZitUsername);
        this.ctx.sandbox
            .stub(typedConfig, 'commitArgs')
            .get(() => ['--user', 'commit-args-author']);
        const commitStub = execStub
            .withArgs([
                'commit',
                '--user',
                'commit-args-author',
                '-m',
                'configured author',
            ])
            .resolves(fakeExecutionResult());

        await getOpenedRepository().commit(
            'configured author' as ZitCommitMessage,
            '' as ZitUsername,
            undefined
        );

        sinon.assert.calledOnceWithExactly(commitStub, [
            'commit',
            '--user',
            'commit-args-author',
            '-m',
            'configured author',
        ]);
    });
}
