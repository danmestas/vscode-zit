import * as assert from 'assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { commands, Uri, window } from 'vscode';
import * as sinon from 'sinon';
import { Suite } from 'mocha';
import { CommandCenter } from '../../commands';
import * as interaction from '../../interaction';
import {
    ZitBranch,
    ZitCheckin,
    ZitRoot,
    ZitWorktree,
} from '../../openedRepository';
import {
    fakeExecutionResult,
    getExecutable,
    getExecStub,
    getOpenedRepository,
    getRepository,
} from './common';

export function WorktreeSuite(this: Suite): void {
    test('Lists registered worktrees with paths, state, and the current marker', async () => {
        const exec = getExecStub(this.ctx.sandbox);
        exec.withArgs(['worktrees']).resolves(
            fakeExecutionResult({
                stdout: [
                    '* /tmp/main tree  (trunk at 0123456789)',
                    '  /tmp/feature tree  (feature/one at abcdef0123)',
                    '  /tmp/unborn tree  (new-branch, unborn)',
                    '  /tmp/unknown tree',
                    '',
                ].join('\n'),
            })
        );

        const worktrees = await getOpenedRepository().getWorktrees();

        assert.deepEqual(worktrees, [
            {
                path: '/tmp/main tree' as ZitRoot,
                branch: 'trunk' as ZitBranch,
                checkin: '0123456789' as ZitCheckin,
                isCurrent: true,
            },
            {
                path: '/tmp/feature tree' as ZitRoot,
                branch: 'feature/one' as ZitBranch,
                checkin: 'abcdef0123' as ZitCheckin,
                isCurrent: false,
            },
            {
                path: '/tmp/unborn tree' as ZitRoot,
                branch: 'new-branch' as ZitBranch,
                isCurrent: false,
            },
            {
                path: '/tmp/unknown tree' as ZitRoot,
                isCurrent: false,
            },
        ] satisfies ZitWorktree[]);
    });

    test('Lists no worktrees when Zit emits no registrations', async () => {
        const exec = getExecStub(this.ctx.sandbox);
        exec.withArgs(['worktrees']).resolves(
            fakeExecutionResult({ stdout: '' })
        );

        assert.deepEqual(await getOpenedRepository().getWorktrees(), []);
    });

    test('Creates a detached worktree against the current checkout store', async () => {
        const repository = getOpenedRepository();
        const destination = '/tmp/new worktree' as ZitRoot;
        const exec = this.ctx.sandbox
            .stub(getExecutable(), 'exec')
            .resolves(fakeExecutionResult());

        await repository.createWorktree(destination);

        sinon.assert.calledOnceWithExactly(exec, destination, [
            'open',
            `--store=${repository.root}`,
        ]);
    });

    test('Worktree picker shows path, branch, check-in, and current state', async () => {
        const worktrees: ZitWorktree[] = [
            {
                path: '/tmp/main tree' as ZitRoot,
                branch: 'trunk' as ZitBranch,
                checkin: '0123456789' as ZitCheckin,
                isCurrent: true,
            },
            {
                path: '/tmp/unborn tree' as ZitRoot,
                branch: 'feature' as ZitBranch,
                isCurrent: false,
            },
        ];
        const picker = this.ctx.sandbox.stub(window, 'showQuickPick');
        picker.callsFake(async items => {
            const entries = await Promise.resolve(items);
            assert.deepEqual(
                entries.map(item => ({
                    label: item.label,
                    description: item.description,
                    detail: item.detail,
                })),
                [
                    {
                        label: '$(folder) main tree',
                        description: 'Current worktree',
                        detail: '/tmp/main tree • trunk • 0123456789',
                    },
                    {
                        label: '$(folder) unborn tree',
                        description: undefined,
                        detail: '/tmp/unborn tree • feature • Unborn checkout',
                    },
                ]
            );
            return entries[1];
        });

        assert.equal(await interaction.pickWorktree(worktrees), worktrees[1]);
    });

    test('Open Worktree commands select the current or a new VS Code window', async () => {
        const repository = getRepository();
        const selected: ZitWorktree = {
            path: '/tmp/selected tree' as ZitRoot,
            branch: 'trunk' as ZitBranch,
            checkin: '0123456789' as ZitCheckin,
            isCurrent: false,
        };
        this.ctx.sandbox.stub(repository, 'getWorktrees').resolves([selected]);
        this.ctx.sandbox
            .stub(interaction, 'pickWorktree')
            .onFirstCall()
            .resolves(selected)
            .onSecondCall()
            .resolves(selected);
        const openFolder = this.ctx.sandbox
            .stub(commands, 'executeCommand')
            .withArgs('vscode.openFolder')
            .resolves();
        const center = Object.create(CommandCenter.prototype) as CommandCenter;

        await center.worktreeOpen(repository);
        await center.worktreeOpenNewWindow(repository);

        sinon.assert.calledTwice(openFolder);
        sinon.assert.calledWithExactly(
            openFolder.firstCall,
            'vscode.openFolder',
            Uri.file(selected.path),
            { forceReuseWindow: true }
        );
        sinon.assert.calledWithExactly(
            openFolder.secondCall,
            'vscode.openFolder',
            Uri.file(selected.path),
            { forceNewWindow: true }
        );
    });

    test('Create Detached Worktree opens a successful destination in a new window', async () => {
        const repository = getRepository();
        const destination = '/tmp/created tree' as ZitRoot;
        this.ctx.sandbox
            .stub(interaction, 'selectEmptyWorktreeDirectory')
            .resolves(destination);
        const create = this.ctx.sandbox
            .stub(repository, 'createWorktree')
            .resolves(fakeExecutionResult());
        const openFolder = this.ctx.sandbox
            .stub(commands, 'executeCommand')
            .withArgs('vscode.openFolder')
            .resolves();
        const center = Object.create(CommandCenter.prototype) as CommandCenter;

        await center.worktreeCreate(repository);

        sinon.assert.calledOnceWithExactly(create, destination);
        sinon.assert.calledOnceWithExactly(
            openFolder,
            'vscode.openFolder',
            Uri.file(destination),
            { forceNewWindow: true }
        );
    });

    test('Create Detached Worktree leaves failed destinations unopened', async () => {
        const repository = getRepository();
        const destination = '/tmp/failed tree' as ZitRoot;
        this.ctx.sandbox
            .stub(interaction, 'selectEmptyWorktreeDirectory')
            .resolves(destination);
        this.ctx.sandbox.stub(repository, 'createWorktree').resolves(
            fakeExecutionResult({
                exitCode: 1,
                stderr: 'destination is not empty',
            })
        );
        const openFolder = this.ctx.sandbox.stub(commands, 'executeCommand');
        const center = Object.create(CommandCenter.prototype) as CommandCenter;

        await center.worktreeCreate(repository);

        sinon.assert.notCalled(openFolder);
    });

    test('Create Detached Worktree rejects a non-empty selected directory', async () => {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), 'vscode-zit-worktree-')
        );
        await fs.writeFile(path.join(directory, 'existing.txt'), 'occupied');
        this.ctx.sandbox
            .stub(window, 'showOpenDialog')
            .resolves([Uri.file(directory)]);
        const error = this.ctx.sandbox
            .stub(window, 'showErrorMessage')
            .resolves(undefined);

        try {
            assert.equal(
                await interaction.selectEmptyWorktreeDirectory(),
                undefined
            );
            sinon.assert.calledOnce(error);
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });
}
