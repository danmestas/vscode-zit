import * as vscode from 'vscode';
import { Uri, window, workspace, commands } from 'vscode';
import * as sinon from 'sinon';
import {
    add,
    assertGroups,
    cleanupZit,
    fakeExecutionResult,
    fakeZitStatus,
    getExecStub,
    getModel,
    getOpenedRepository,
    getRepository,
} from './common';
import * as assert from 'assert/strict';
import * as fs from 'fs/promises';
import {
    ZitCommitMessage,
    RelativePath,
    ResourceStatus,
    UserPath,
} from '../../openedRepository';
import { delay } from '../../util';
import { Suite, suiteSetup } from 'mocha';
import { Reason } from '../../zitExecutable';
import * as interaction from '../../interaction';

export function RenameSuite(this: Suite): void {
    const rootUri = this.ctx.workspaceUri;
    const config = () => workspace.getConfiguration('zit');

    suiteSetup(async () => {
        await config().update('enableRenaming', true);
        await cleanupZit(getRepository());
    });

    test('Rename a file', async () => {
        const oldFilename = 'not_renamed.txt';
        const newFilename = 'renamed.txt';
        await add(oldFilename, 'foo content\n', `add: ${oldFilename}`);

        const repository = getRepository();
        const newFilePath = Uri.joinPath(rootUri, newFilename);

        await repository.rename(
            oldFilename as RelativePath,
            newFilename as RelativePath
        );

        assertGroups(repository, {
            added: [[newFilePath.fsPath, ResourceStatus.ADDED]],
            working: [
                [
                    Uri.joinPath(rootUri, oldFilename).fsPath,
                    ResourceStatus.DELETED,
                ],
            ],
        });
        await repository.rename(
            newFilename as RelativePath,
            oldFilename as RelativePath
        );
        assertGroups(repository, {});
    }).timeout(6000);

    test('Restores a filesystem move when Zit rejects rename', async () => {
        const oldFilename = 'rename_rejected.txt';
        const newFilename = 'rename_restored.txt';
        const oldUri = await add(
            oldFilename,
            'restore this content\n',
            `add: ${oldFilename}`
        );
        const newUri = Uri.joinPath(rootUri, newFilename);
        await fs.rename(oldUri.fsPath, newUri.fsPath);

        const execStub = getExecStub(this.ctx.sandbox);
        const move = execStub
            .withArgs([
                'mv',
                '--',
                oldFilename as RelativePath,
                newFilename as RelativePath,
            ])
            .resolves(
                fakeExecutionResult({
                    exitCode: 1,
                    stderr: '',
                })
            );

        await assert.rejects(
            getOpenedRepository().rename(
                oldFilename as RelativePath,
                newFilename as RelativePath
            ),
            /zit mv failed/
        );
        sinon.assert.calledOnceWithExactly(move, [
            'mv',
            '--',
            oldFilename as RelativePath,
            newFilename as RelativePath,
        ]);
        await assert.rejects(fs.stat(oldUri.fsPath), { code: 'ENOENT' });
        assert.equal(
            await fs.readFile(newUri.fsPath, 'utf8'),
            'restore this content\n'
        );

        execStub.restore();
        await cleanupZit(getRepository());
    }).timeout(6000);
    test('Protects leading-hyphen paths when invoking Zit rename', async () => {
        const oldUri = Uri.joinPath(rootUri, '-absolute-old.txt');
        const newUri = Uri.joinPath(rootUri, '-absolute-new.txt');
        await fs.writeFile(oldUri.fsPath, 'absolute rename\n');
        const move = getExecStub(this.ctx.sandbox)
            .withArgs([
                'mv',
                '--',
                '-absolute-old.txt' as RelativePath,
                '-absolute-new.txt' as RelativePath,
            ])
            .resolves(fakeExecutionResult());

        try {
            await getOpenedRepository().rename(
                oldUri.fsPath as UserPath,
                newUri.fsPath as UserPath
            );
            sinon.assert.calledOnceWithExactly(move, [
                'mv',
                '--',
                '-absolute-old.txt' as RelativePath,
                '-absolute-new.txt' as RelativePath,
            ]);
        } finally {
            await fs.unlink(oldUri.fsPath);
        }
    });

    test('Surfaces a direct Zit rename rejection without moving files', async () => {
        const oldFilename = 'direct-rejected-old.txt';
        const oldUri = Uri.joinPath(rootUri, oldFilename);
        await fs.writeFile(oldUri.fsPath, 'keep me\n');
        getExecStub(this.ctx.sandbox)
            .withArgs([
                'mv',
                '--',
                oldFilename as RelativePath,
                'direct-rejected-new.txt' as RelativePath,
            ])
            .resolves(
                fakeExecutionResult({
                    exitCode: 1,
                    stderr: '',
                })
            );

        try {
            await assert.rejects(
                getOpenedRepository().rename(
                    oldFilename as RelativePath,
                    'direct-rejected-new.txt' as RelativePath
                ),
                /zit mv failed/
            );
            assert.equal(await fs.readFile(oldUri.fsPath, 'utf8'), 'keep me\n');
        } finally {
            await fs.unlink(oldUri.fsPath);
        }
    });

    test('Restores an external move when spawning Zit rename throws', async () => {
        const oldFilename = 'spawn-throw-old.txt';
        const newFilename = 'spawn-throw-new.txt';
        const oldUri = Uri.joinPath(rootUri, oldFilename);
        const newUri = Uri.joinPath(rootUri, newFilename);
        await fs.writeFile(newUri.fsPath, 'external move\n');
        getExecStub(this.ctx.sandbox)
            .withArgs([
                'mv',
                '--',
                oldFilename as RelativePath,
                newFilename as RelativePath,
            ])
            .rejects(new Error('spawn failed'));

        try {
            await assert.rejects(
                getOpenedRepository().rename(
                    oldFilename as RelativePath,
                    newFilename as RelativePath
                ),
                /spawn failed/
            );
            await assert.rejects(fs.stat(oldUri.fsPath), { code: 'ENOENT' });
            assert.equal(
                await fs.readFile(newUri.fsPath, 'utf8'),
                'external move\n'
            );
        } finally {
            await fs.unlink(newUri.fsPath);
        }
    });

    test('Propagates unexpected source and destination stat failures', async () => {
        const parentUri = Uri.joinPath(rootUri, 'rename-parent-file');
        await fs.writeFile(parentUri.fsPath, 'not a directory\n');

        try {
            await assert.rejects(
                getOpenedRepository().rename(
                    'rename-parent-file/child.txt' as RelativePath,
                    'unused-destination.txt' as RelativePath
                ),
                (error: NodeJS.ErrnoException) => error.code === 'ENOTDIR'
            );
            await assert.rejects(
                getOpenedRepository().rename(
                    'missing-source.txt' as RelativePath,
                    'rename-parent-file/child.txt' as RelativePath
                ),
                (error: NodeJS.ErrnoException) => error.code === 'ENOTDIR'
            );
        } finally {
            await fs.unlink(parentUri.fsPath);
        }
    });

    test('Delegates directory destinations directly to Zit', async () => {
        const destination = Uri.joinPath(rootUri, 'rename-destination');
        await fs.mkdir(destination.fsPath);
        const move = getExecStub(this.ctx.sandbox)
            .withArgs([
                'mv',
                '--',
                'missing-source.txt' as RelativePath,
                'rename-destination' as RelativePath,
            ])
            .resolves(fakeExecutionResult());

        try {
            await getOpenedRepository().rename(
                'missing-source.txt' as RelativePath,
                'rename-destination' as RelativePath
            );
            sinon.assert.calledOnce(move);
        } finally {
            await fs.rmdir(destination.fsPath);
        }
    });

    test("Don't show again", async () => {
        const repository = getRepository();
        assertGroups(repository, {}, "Previous test didn't cleanup or failed");

        assert.equal(config().get('enableRenaming'), true, 'contract');
        const execStub = getExecStub(this.ctx.sandbox);
        const oldFilename = 'do_not_show.txt';
        const oldUri = Uri.joinPath(rootUri, oldFilename);
        await fs.writeFile(oldUri.fsPath, '123');
        const newFilename = 'test_failed.txt';

        const edit = new vscode.WorkspaceEdit();
        const newFilePath = Uri.joinPath(rootUri, newFilename);
        edit.renameFile(oldUri, newFilePath);

        const sim = (
            this.ctx.sandbox.stub(
                window,
                'showInformationMessage'
            ) as sinon.SinonStub
        ).resolves("Don't show again");

        const status = fakeZitStatus(execStub, `edited ${oldFilename}\n`);
        const success = await workspace.applyEdit(edit);
        assert.ok(success);
        sinon.assert.calledOnceWithExactly(
            status,
            ['status'],
            'file rename event' as Reason
        );

        // renaming triggers an async event, that is not awaited. await it.
        for (let i = 0; i < 200; ++i) {
            if (sim.callCount != 0) {
                break;
            }
            /* c8 ignore next 2 */
            await delay(5);
        }
        sinon.assert.calledOnceWithExactly(
            sim,
            '"do_not_show.txt" was renamed to "test_failed.txt" on ' +
                'filesystem. Rename in Zit repository too?',
            {
                modal: false,
            },
            'Yes',
            'Cancel',
            "Don't show again"
        );

        for (let i = 1; i < 200; ++i) {
            if (config().get('enableRenaming') === false) {
                break;
            }
            await delay(5);
        }
        assert.equal(config().get('enableRenaming'), false, 'no update');
        await config().update('enableRenaming', true);
        assertGroups(repository, {
            working: [[oldUri.fsPath, ResourceStatus.MODIFIED]],
        });
        execStub.restore();
        await cleanupZit(repository);
    }).timeout(3000);

    test('Directory move remains missing and untracked', async () => {
        const repository = getRepository();
        assertGroups(repository, {}, "Previous test didn't cleanup or failed");

        const oldDirname = 'not_renamed';
        const newDirname = 'renamed';
        const oldDirUrl = Uri.joinPath(rootUri, oldDirname);
        const newDirUrl = Uri.joinPath(rootUri, newDirname);
        await fs.mkdir(oldDirUrl.fsPath);
        const filenames = ['mud', 'cabbage', 'brick'];
        const oldUris = filenames.map(filename =>
            Uri.joinPath(oldDirUrl, filename)
        );
        const newUris = filenames.map(filename =>
            Uri.joinPath(newDirUrl, filename)
        );

        await Promise.all(
            oldUris.map(uri => fs.writeFile(uri.fsPath, `foo ${uri}\n`))
        );
        const openedRepository = getOpenedRepository();
        await openedRepository.exec(['add', '--', oldDirname as RelativePath]);
        await openedRepository.exec([
            'commit',
            '-m',
            `add directory: ${oldDirname}` as ZitCommitMessage,
        ]);

        this.ctx.sandbox
            .stub(window, 'showInformationMessage')
            .resolves(undefined);

        const edit = new vscode.WorkspaceEdit();
        edit.renameFile(oldDirUrl, newDirUrl);

        const success = await workspace.applyEdit(edit);
        assert.ok(success);
        await delay(50);
        await repository.updateStatus('Test' as Reason);

        assertGroups(repository, {
            working: oldUris.map((url: Uri) => [
                url.fsPath,
                ResourceStatus.MISSING,
            ]),
            untracked: newUris.map((url: Uri) => [
                url.fsPath,
                ResourceStatus.EXTRA,
            ]),
        });
        await cleanupZit(repository);
    }).timeout(10000);

    test('Rename', async () => {
        const repository = getRepository();
        assertGroups(repository, {}, "Previous test didn't cleanup or failed");
        const oldFilename = 'not_relocated.txt';
        const newFilename = 'relocated.txt';
        const newUri = Uri.joinPath(rootUri, newFilename);
        const oldUri = await add(
            oldFilename,
            'foo content\n',
            `add: ${oldFilename}`
        );
        await fs.rename(oldUri.fsPath, newUri.fsPath);
        await repository.updateStatus('Test' as Reason);
        assertGroups(repository, {
            working: [[oldUri.fsPath, ResourceStatus.MISSING]],
            untracked: [[newUri.fsPath, ResourceStatus.EXTRA]],
        });
        this.ctx.sandbox
            .stub(window, 'showQuickPick')
            .onFirstCall()
            .callsFake(items => {
                assert.ok(items instanceof Array);
                assert.equal(items.length, 3);
                assert.equal(items[0].label, '$(folder-opened) Open Dialog');
                assert.equal(items[1].label, 'Untracked Files');
                assert.equal(items[2].label, '$(symbol-file) relocated.txt');
                return Promise.resolve(items[0]);
            });

        const sod = this.ctx.sandbox
            .stub(window, 'showOpenDialog')
            .resolves([newUri]);
        await commands.executeCommand(
            'zit.rename',
            repository.workingGroup.resourceStates[0]
        );
        sinon.assert.calledOnce(sod);
        assertGroups(repository, {
            added: [[newUri.fsPath, ResourceStatus.ADDED]],
            working: [[oldUri.fsPath, ResourceStatus.DELETED]],
        });
        await getOpenedRepository().rename(
            newFilename as RelativePath,
            oldFilename as RelativePath
        );
        await repository.updateStatus('Test cleanup' as Reason);
        assertGroups(repository, {});
    }).timeout(10000);

    test('Confirms and tracks external file rename events', async () => {
        const repository = getRepository();
        const execStub = getExecStub(this.ctx.sandbox);
        const oldUri = Uri.joinPath(rootUri, 'event-old.txt');
        const newUri = Uri.joinPath(rootUri, 'event-new.txt');
        fakeZitStatus(execStub, 'missing event-old.txt\n');
        await repository.updateStatus('External rename event' as Reason);
        const confirm = this.ctx.sandbox
            .stub(interaction, 'confirmRename')
            .resolves(true);
        const rename = this.ctx.sandbox.stub(repository, 'rename').resolves();

        try {
            await getModel().onDidRenameFiles({
                files: [{ oldUri, newUri }],
            });

            sinon.assert.calledOnceWithExactly(
                confirm,
                'event-old.txt' as RelativePath,
                'event-new.txt' as RelativePath
            );
            sinon.assert.calledOnceWithExactly(
                rename,
                'event-old.txt' as RelativePath,
                'event-new.txt' as RelativePath
            );
        } finally {
            fakeZitStatus(execStub, '');
            await repository.updateStatus(
                'Clear external rename event' as Reason
            );
        }
    });

    test('Rename nothing', async () => {
        await commands.executeCommand('zit.rename');
    });
}
