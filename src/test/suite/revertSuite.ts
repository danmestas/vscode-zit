import { Uri, window, commands } from 'vscode';
import * as sinon from 'sinon';
import { add, fakeZitStatus, getExecStub, getRepository } from './common';
import * as assert from 'assert/strict';
import * as fs from 'fs/promises';
import type { Suite } from 'mocha';
import type { ZitResourceGroup } from '../../resourceGroups';
import type { ZitResource } from '../../repository';
import { Reason } from '../../zitExecutable';
import { RelativePath } from '../../openedRepository';

export function RevertSuite(this: Suite): void {
    test('Single source', async () => {
        const url = await add(
            'revert_me.txt',
            'Some original text\n',
            'add revert_me.txt'
        );
        await fs.writeFile(url.fsPath, 'something new');

        const repository = getRepository();
        await repository.updateStatus('Test' as Reason);
        const resource = repository.workingGroup.getResource(url);
        assert.ok(resource);

        const showWarningMessage: sinon.SinonStub = this.ctx.sandbox.stub(
            window,
            'showWarningMessage'
        );
        showWarningMessage.onFirstCall().resolves('&&Discard Changes');

        await commands.executeCommand('zit.revert', resource);
        const newContext = await fs.readFile(url.fsPath);
        assert.equal(newContext.toString('utf-8'), 'Some original text\n');
    });

    suite('Dialog has no typos', () => {
        let swmResources: ZitResource[];
        const prepareResources = async () => {
            if (swmResources) {
                return swmResources;
            }
            const repository = getRepository();
            const fake_status = [];
            const execStub = getExecStub(this.ctx.sandbox);
            const fileUris: Uri[] = [];
            for (const filename of 'abcdefghijklmn') {
                // 14 files
                const fileUri = Uri.joinPath(
                    this.ctx.workspaceUri,
                    'added',
                    filename
                );
                const action = ['k', 'l', 'm', 'n'].includes(filename)
                    ? 'added'
                    : 'edited';
                fake_status.push(`${action} added/${filename}`);
                fileUris.push(fileUri);
            }
            const statusCall = fakeZitStatus(execStub, fake_status.join('\n'));
            await repository.updateStatus('Test' as Reason);
            sinon.assert.calledOnce(statusCall);
            const resources = fileUris.map(uri => {
                const resource =
                    repository.workingGroup.getResource(uri) ??
                    repository.addedGroup.getResource(uri);
                assert.ok(resource);
                return resource;
            });
            swmResources = resources;
            return swmResources;
        };

        test('10 + 4 files', async () => {
            const resources = await prepareResources();
            const swm = this.ctx.sandbox.stub(window, 'showWarningMessage');
            await commands.executeCommand('zit.revert', ...resources);
            sinon.assert.calledOnceWithMatch(
                swm,
                'Are you sure you want to discard changes to 10 files?\n' +
                    '\n • a\n • b\n • c\n • d\n • e\n • f\n • g\n • h\n' +
                    'and 2 others\n\n(and forget 4 other added files)',
                { modal: true }
            );
        });

        test('10  files', async () => {
            const resources = await prepareResources();
            const swm = this.ctx.sandbox.stub(window, 'showWarningMessage');
            await commands.executeCommand(
                'zit.revert',
                ...resources.slice(0, 10)
            );
            sinon.assert.calledOnceWithMatch(
                swm,
                'Are you sure you want to discard changes to 10 files?\n' +
                    '\n • a\n • b\n • c\n • d\n • e\n • f\n • g\n • h\n' +
                    'and 2 others',
                { modal: true }
            );
        });

        test('3 files', async () => {
            const resources = await prepareResources();
            const swm = this.ctx.sandbox.stub(window, 'showWarningMessage');
            await commands.executeCommand(
                'zit.revert',
                ...resources.slice(0, 3)
            );
            sinon.assert.calledOnceWithMatch(
                swm,
                'Are you sure you want to discard changes to 3 files?\n' +
                    '\n • a\n • b\n • c',
                { modal: true }
            );
        });

        test('2 added files', async () => {
            const resources = await prepareResources();
            const execStub = getExecStub(this.ctx.sandbox);
            fakeZitStatus(execStub, '');
            const forget = execStub
                .withArgs(['rm', '--', 'added/k', 'added/l'])
                .resolves();
            const swm = this.ctx.sandbox.stub(window, 'showWarningMessage');
            await commands.executeCommand(
                'zit.revert',
                ...resources.slice(10, 12)
            );
            sinon.assert.notCalled(swm);
            sinon.assert.calledOnce(forget);
        });
    });

    test('Revert (Nothing)', async () => {
        await commands.executeCommand('zit.revert');
    });

    // for testing `zit.revertAll` only
    async function revertAllTest(
        sandbox: sinon.SinonSandbox,
        groups: ZitResourceGroup[],
        message: string,
        files: { revert?: string[]; forget?: string[] }
    ): Promise<void> {
        const swm: sinon.SinonStub = sandbox.stub(window, 'showWarningMessage');
        swm.onFirstCall().resolves('&&Discard Changes');

        const repository = getRepository();
        const execStub = getExecStub(sandbox);
        const statusStub = fakeZitStatus(
            execStub,
            'edited a.txt\nedited b.txt\nadded c.txt\nadded d.txt'
        );
        const revertStub = execStub
            .withArgs(sinon.match.array.startsWith(['revert']))
            .resolves();
        const forgetStub = execStub
            .withArgs(sinon.match.array.startsWith(['rm']))
            .resolves();
        await repository.updateStatus('Test' as Reason);
        sinon.assert.calledOnce(statusStub);
        await commands.executeCommand('zit.revertAll', ...groups);
        sinon.assert.calledOnceWithExactly(
            swm,
            message,
            { modal: true },
            '&&Discard Changes'
        );
        if (files.revert) {
            sinon.assert.calledOnceWithExactly(revertStub, [
                'revert',
                '--',
                ...(files.revert as RelativePath[]),
            ]);
        } else {
            sinon.assert.notCalled(revertStub);
        }
        if (files.forget) {
            sinon.assert.calledOnceWithExactly(forgetStub, [
                'rm',
                '--',
                ...(files.forget as RelativePath[]),
            ]);
        } else {
            sinon.assert.notCalled(forgetStub);
        }
    }

    test('Revert all (no groups)', async () => {
        await revertAllTest(
            this.ctx.sandbox,
            [],
            'Are you sure you want to discard changes in ' +
                '"Added Files" and "Changes" groups?',
            { revert: ['a.txt', 'b.txt'], forget: ['c.txt', 'd.txt'] }
        );
    });

    test('Revert all (changes group)', async () => {
        const repository = getRepository();
        await revertAllTest(
            this.ctx.sandbox,
            [repository.workingGroup],
            'Are you sure you want to discard changes in "Changes" group?',
            { revert: ['a.txt', 'b.txt'] }
        );
    });

    test('Revert all (added group)', async () => {
        const repository = getRepository();
        await revertAllTest(
            this.ctx.sandbox,
            [repository.addedGroup],
            'Are you sure you want to discard changes in "Added Files" group?',
            { forget: ['c.txt', 'd.txt'] }
        );
    });
}
