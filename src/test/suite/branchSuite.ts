import { commands, TextDocument, Uri, window, workspace } from 'vscode';
import * as assert from 'assert/strict';
import * as sinon from 'sinon';
import { Suite } from 'mocha';
import * as interaction from '../../interaction';
import {
    OpenedRepository,
    MergeAction,
    StashID,
    ZitBranch,
    ZitCheckin,
    ZitCommitMessage,
    ZitPassword,
    ZitTag,
    ZitURI,
    ZitUsername,
} from '../../openedRepository';
import {
    fakeExecutionResult,
    fakeZitStatus,
    getExecStub,
    getRepository,
} from './common';
import { Reason } from '../../zitExecutable';
import { CommandCenter } from '../../commands';

function getOpenedRepository(): OpenedRepository {
    const opened = Reflect.get(getRepository(), 'repository') as unknown;
    assert.ok(opened instanceof OpenedRepository);
    return opened;
}

export function BranchSuite(this: Suite): void {
    test('parses current and closed Zit branches', async () => {
        const branch = getExecStub(this.ctx.sandbox)
            .withArgs(['branch'])
            .resolves(
                fakeExecutionResult({
                    stdout: '* feature (closed)\n  trunk\n',
                })
            );

        const branches = await getOpenedRepository().getBranches({
            includeClosed: true,
        });

        sinon.assert.calledOnceWithExactly(branch, ['branch']);
        assert.deepEqual(branches, [
            {
                name: 'feature' as ZitBranch,
                isCurrent: true,
                isClosed: true,
            },
            {
                name: 'trunk' as ZitBranch,
                isCurrent: false,
                isClosed: false,
            },
        ]);
    });

    test('filters closed Zit branches unless requested', async () => {
        getExecStub(this.ctx.sandbox)
            .withArgs(['branch'])
            .resolves(
                fakeExecutionResult({
                    stdout: '  archived (closed)\n* trunk\n',
                })
            );

        const branches = await getOpenedRepository().getBranches();

        assert.deepEqual(branches, [
            {
                name: 'trunk' as ZitBranch,
                isCurrent: true,
                isClosed: false,
            },
        ]);
    });

    test('creates a branch only through Zit commit --branch', async () => {
        const commit = getExecStub(this.ctx.sandbox)
            .withArgs([
                'commit',
                '--user',
                'tester',
                '--branch',
                'feature',
                '-m',
                'start feature',
            ])
            .resolves(fakeExecutionResult());

        await getOpenedRepository().commit(
            'start feature' as ZitCommitMessage,
            'tester' as ZitUsername,
            { branch: 'feature' as ZitBranch }
        );

        sinon.assert.calledOnceWithExactly(commit, [
            'commit',
            '--user',
            'tester',
            '--branch',
            'feature',
            '-m',
            'start feature',
        ]);
    });

    test('closes a branch only through Zit commit --close', async () => {
        const commit = getExecStub(this.ctx.sandbox)
            .withArgs(['commit', '--user', 'tester', '--close', '-m', 'close'])
            .resolves(fakeExecutionResult());

        await getOpenedRepository().commit(
            'close' as ZitCommitMessage,
            'tester' as ZitUsername,
            undefined,
            true
        );

        sinon.assert.calledOnceWithExactly(commit, [
            'commit',
            '--user',
            'tester',
            '--close',
            '-m',
            'close',
        ]);
    });

    test('prompts for only a Zit branch name', async () => {
        this.ctx.sandbox
            .stub(window, 'showInputBox')
            .resolves('feature/portable');

        const options = await interaction.inputNewBranchOptions();

        assert.deepEqual(options, {
            branch: 'feature/portable' as ZitBranch,
        });
    });

    test('uses exact Zit tag list and add argv', async () => {
        const exec = getExecStub(this.ctx.sandbox);
        const list = exec.withArgs(['tag', 'list', 'abc123']).resolves(
            fakeExecutionResult({
                stdout: 'branch trunk\ntrunk\nv1\n',
            })
        );
        const add = exec
            .withArgs(['tag', 'add', 'release', 'abc123'])
            .resolves(fakeExecutionResult());
        const repository = getOpenedRepository();

        const tags = await repository.getTags('abc123' as ZitCheckin);
        await repository.addTag('abc123' as ZitCheckin, 'release' as ZitTag);

        assert.deepEqual(tags, ['trunk', 'v1']);
        sinon.assert.calledOnceWithExactly(list, ['tag', 'list', 'abc123']);
        sinon.assert.calledOnceWithExactly(add, [
            'tag',
            'add',
            'release',
            'abc123',
        ]);
    });

    test('adds a tag through the Zit command surface', async () => {
        const add = getExecStub(this.ctx.sandbox)
            .withArgs(['tag', 'add', 'release', 'abc123'])
            .resolves(fakeExecutionResult());
        this.ctx.sandbox.stub(window, 'showInputBox').resolves('release');

        await commands.executeCommand('zit.tagAdd', 'abc123' as ZitCheckin);

        sinon.assert.calledOnceWithExactly(add, [
            'tag',
            'add',
            'release',
            'abc123',
        ]);
    });

    test('parses the Zit stash list hyphen format', async () => {
        getExecStub(this.ctx.sandbox)
            .withArgs(['stash', 'list'])
            .resolves(
                fakeExecutionResult({
                    stdout: '7: [a1b2c3] 2 file(s) - unfinished work\n',
                })
            );

        const items = await getOpenedRepository().stashList();

        assert.deepEqual(items, [
            {
                stashId: 7 as StashID,
                hash: 'a1b2c3',
                fileCount: 2,
                comment: 'unfinished work' as ZitCommitMessage,
            },
        ]);
    });

    test('uses exact Zit stash save/show/apply/pop/drop argv', async () => {
        const exec = getExecStub(this.ctx.sandbox);
        const save = exec
            .withArgs(['stash', 'save', '-m', 'work'])
            .resolves(fakeExecutionResult());
        const show = exec
            .withArgs(['stash', 'show', '7'])
            .resolves(fakeExecutionResult({ stdout: 'M file.txt\n' }));
        const apply = exec
            .withArgs(['stash', 'apply', '7'])
            .resolves(fakeExecutionResult());
        const pop = exec
            .withArgs(['stash', 'pop', '7'])
            .resolves(fakeExecutionResult());
        const drop = exec
            .withArgs(['stash', 'drop', '7'])
            .resolves(fakeExecutionResult());
        const repository = getOpenedRepository();

        await repository.stash('work' as ZitCommitMessage);
        assert.equal(await repository.stashShow(7 as StashID), 'M file.txt\n');
        await repository.stashApplyOrDrop('apply', 7 as StashID);
        await repository.stashPop(7 as StashID);
        await repository.stashApplyOrDrop('drop', 7 as StashID);

        sinon.assert.calledOnce(save);
        sinon.assert.calledOnce(show);
        sinon.assert.calledOnce(apply);
        sinon.assert.calledOnce(pop);
        sinon.assert.calledOnce(drop);
    });

    test('uses Zit remote, pull, push, sync, and autosync argv', async () => {
        const exec = getExecStub(this.ctx.sandbox);
        const remote = Uri.parse('https://example.test/repo.zit') as ZitURI;
        const remoteString = remote.toString();
        const getRemote = exec
            .withArgs(['remote'])
            .resolves(fakeExecutionResult({ stdout: `${remoteString}\n` }));
        const setRemote = exec
            .withArgs(['remote', remoteString])
            .resolves(fakeExecutionResult());
        const pull = exec
            .withArgs(['pull', remoteString])
            .resolves(fakeExecutionResult());
        const push = exec
            .withArgs([
                'push',
                remoteString,
                '--user',
                'alice',
                '--password',
                'secret',
            ])
            .resolves(fakeExecutionResult());
        const sync = exec
            .withArgs([
                'sync',
                remoteString,
                '--user',
                'alice',
                '--password',
                'secret',
            ])
            .resolves(fakeExecutionResult());
        const autosync = exec
            .withArgs(['settings', 'autosync', 'off'])
            .resolves(fakeExecutionResult());
        const repository = getOpenedRepository();
        const credentials = {
            username: 'alice' as ZitUsername,
            password: 'secret' as ZitPassword,
        };

        assert.equal((await repository.getRemote())?.toString(), remoteString);
        await repository.setRemote(remote);
        await repository.pull(remote);
        await repository.push(remote, credentials);
        await repository.sync(remote, credentials);
        await repository.setAutoSync(false);

        sinon.assert.calledOnce(getRemote);
        sinon.assert.calledOnce(setRemote);
        sinon.assert.calledOnce(pull);
        sinon.assert.calledOnce(push);
        sinon.assert.calledOnce(sync);
        sinon.assert.calledOnce(autosync);
    });

    test('unsets a Zit remote with --unset', async () => {
        const unset = getExecStub(this.ctx.sandbox)
            .withArgs(['remote', '--unset'])
            .resolves(fakeExecutionResult());

        await getOpenedRepository().setRemote();

        sinon.assert.calledOnceWithExactly(unset, ['remote', '--unset']);
    });

    test('handles absent current branches and malformed branch rows', async () => {
        const branch = getExecStub(this.ctx.sandbox)
            .withArgs(['branch'])
            .resolves(
                fakeExecutionResult({
                    stdout: 'not a branch row\n  archived (closed)\n',
                })
            );

        const current = await getOpenedRepository().getCurrentBranch();

        assert.equal(current, undefined);
        sinon.assert.calledOnceWithExactly(branch, ['branch']);
    });

    test('returns the current Zit branch name', async () => {
        const branch = getExecStub(this.ctx.sandbox)
            .withArgs(['branch'])
            .resolves(
                fakeExecutionResult({
                    stdout: '  archived (closed)\n* feature\n',
                })
            );

        const current = await getOpenedRepository().getCurrentBranch();

        assert.equal(current, 'feature');
        sinon.assert.calledOnceWithExactly(branch, ['branch']);
    });

    test('uses anonymous defaults and optional stash identifiers', async () => {
        const exec = getExecStub(this.ctx.sandbox);
        const remote = exec.withArgs(['remote']);
        remote
            .onFirstCall()
            .resolves(fakeExecutionResult({ stdout: 'no remote set\n' }));
        remote.onSecondCall().resolves(fakeExecutionResult({ stdout: '\n' }));
        const tags = exec
            .withArgs(['tag', 'list'])
            .resolves(fakeExecutionResult({ stdout: '\n release \n\n' }));
        const pull = exec.withArgs(['pull']).resolves(fakeExecutionResult());
        const push = exec.withArgs(['push']).resolves(fakeExecutionResult());
        const sync = exec.withArgs(['sync']).resolves(fakeExecutionResult());
        const autosync = exec
            .withArgs(['settings', 'autosync', 'on'])
            .resolves(fakeExecutionResult());
        const stashShow = exec
            .withArgs(['stash', 'show'])
            .resolves(fakeExecutionResult({ stdout: 'M optional.txt\n' }));
        const stashPop = exec
            .withArgs(['stash', 'pop'])
            .resolves(fakeExecutionResult());
        const repository = getOpenedRepository();

        assert.equal(await repository.getRemote(), undefined);
        assert.equal(await repository.getRemote(), undefined);
        assert.deepEqual(await repository.getTags(), ['release']);
        await repository.pull();
        await repository.push();
        await repository.sync();
        await repository.setAutoSync(true);
        assert.equal(await repository.stashShow(), 'M optional.txt\n');
        await repository.stashPop();

        sinon.assert.calledTwice(remote);
        sinon.assert.calledOnceWithExactly(tags, ['tag', 'list']);
        sinon.assert.calledOnceWithExactly(pull, ['pull']);
        sinon.assert.calledOnceWithExactly(push, ['push']);
        sinon.assert.calledOnceWithExactly(sync, ['sync']);
        sinon.assert.calledOnceWithExactly(autosync, [
            'settings',
            'autosync',
            'on',
        ]);
        sinon.assert.calledOnceWithExactly(stashShow, ['stash', 'show']);
        sinon.assert.calledOnceWithExactly(stashPop, ['stash', 'pop']);
    });

    test('accepts em-dash and message-less stash rows and rejects malformed rows', async () => {
        getExecStub(this.ctx.sandbox)
            .withArgs(['stash', 'list'])
            .resolves(
                fakeExecutionResult({
                    stdout:
                        'malformed row\n' +
                        '8: [def456] 1 file(s) — portable work\n' +
                        '9: [abc789] 3 file(s)\n',
                })
            );

        assert.deepEqual(await getOpenedRepository().stashList(), [
            {
                stashId: 8 as StashID,
                hash: 'def456',
                fileCount: 1,
                comment: 'portable work' as ZitCommitMessage,
            },
            {
                stashId: 9 as StashID,
                hash: 'abc789',
                fileCount: 3,
                comment: '' as ZitCommitMessage,
            },
        ]);
    });

    test('uses exact merge argv and parses unique conflict paths', async () => {
        const exec = getExecStub(this.ctx.sandbox);
        const merge = exec
            .withArgs(['merge', 'feature'])
            .resolves(fakeExecutionResult());
        const cherrypick = exec
            .withArgs(['merge', '--cherrypick', 'abc123'])
            .resolves(fakeExecutionResult());
        const repository = getOpenedRepository();

        await repository.merge('feature' as ZitCheckin, MergeAction.Merge);
        await repository.merge('abc123' as ZitCheckin, MergeAction.Cherrypick);

        assert.deepEqual(
            repository.parseMergeConflictPaths(
                'unrelated diagnostic\n' +
                    'zit merge: conflict in src/file.ts\n' +
                    'zit merge: conflict in src/file.ts\n' +
                    'zit merge: conflict in nested\\path.ts\n'
            ),
            ['src/file.ts', 'nested/path.ts']
        );
        sinon.assert.calledOnceWithExactly(merge, ['merge', 'feature']);
        sinon.assert.calledOnceWithExactly(cherrypick, [
            'merge',
            '--cherrypick',
            'abc123',
        ]);
    });

    test('preserves cancellation across branch, tag, remote, and credentials prompts', async () => {
        const input = this.ctx.sandbox.stub(window, 'showInputBox');
        input.onCall(0).callsFake(options => {
            assert.equal(
                options?.validateInput?.('   '),
                'Branch name is required'
            );
            assert.equal(options?.validateInput?.('feature'), undefined);
            return Promise.resolve(undefined);
        });
        input.onCall(1).callsFake(options => {
            assert.equal(options?.validateInput?.(''), 'Tag name is required');
            assert.equal(options?.validateInput?.('release'), undefined);
            return Promise.resolve(undefined);
        });
        input.onCall(2).callsFake(options => {
            assert.equal(options?.value, 'https://example.test/original.zit');
            assert.equal(
                options?.validateInput?.('not a URL'),
                'Remote URL must use HTTP or HTTPS'
            );
            assert.equal(
                options?.validateInput?.('ssh://example.test/repo.zit'),
                'Remote URL must use HTTP or HTTPS'
            );
            assert.equal(
                options?.validateInput?.(
                    'https://user:pass@example.com/repo.zit'
                ),
                'Do not put credentials in the remote URL'
            );
            assert.equal(
                options?.validateInput?.('https://example.test/repo.zit'),
                undefined
            );
            return Promise.resolve(undefined);
        });
        input.onCall(3).resolves(undefined);
        input.onCall(4).resolves('');
        input.onCall(5).resolves('alice');
        input.onCall(6).resolves(undefined);
        input.onCall(7).resolves('alice');
        input.onCall(8).resolves('secret');

        assert.equal(await interaction.inputNewBranchOptions(), undefined);
        assert.equal(await interaction.inputTagName(), undefined);
        assert.equal(
            await interaction.inputRemoteUrl(
                Uri.parse('https://example.test/original.zit') as ZitURI
            ),
            undefined
        );
        assert.equal(await interaction.inputSyncCredentials(), undefined);
        assert.equal(await interaction.inputSyncCredentials(), null);
        assert.equal(await interaction.inputSyncCredentials(), undefined);
        assert.deepEqual(await interaction.inputSyncCredentials(), {
            username: 'alice' as ZitUsername,
            password: 'secret' as ZitPassword,
        });
    });

    test('uses the remembered remote URL when no default is supplied', async () => {
        const input = this.ctx.sandbox
            .stub(window, 'showInputBox')
            .callsFake(options => {
                assert.equal(typeof options?.value, 'string');
                return Promise.resolve(undefined);
            });

        assert.equal(await interaction.inputRemoteUrl(), undefined);
        sinon.assert.calledOnce(input);
    });

    test('renders optional stash dates and preserves picker cancellation', async () => {
        const quickPick = this.ctx.sandbox
            .stub(window, 'showQuickPick')
            .callsFake(items => {
                assert.ok(items instanceof Array);
                assert.equal(items[0].description, '1 file(s)');
                assert.match(
                    items[1].description!,
                    /^2 file\(s\) • \$\(calendar\) /
                );
                return Promise.resolve(undefined);
            });

        const result = await interaction.pickStashItem(
            [
                {
                    stashId: 1 as StashID,
                    hash: 'a'.repeat(64),
                    fileCount: 1,
                    comment: 'without date' as ZitCommitMessage,
                },
                {
                    stashId: 2 as StashID,
                    hash: 'b'.repeat(64),
                    fileCount: 2,
                    comment: 'with date' as ZitCommitMessage,
                    date: new Date(),
                },
            ],
            'show'
        );

        assert.equal(result, undefined);
        sinon.assert.calledOnce(quickPick);
    });

    test('does not add a tag when the tag prompt is cancelled', async () => {
        const add = getExecStub(this.ctx.sandbox).withArgs(
            sinon.match.array.startsWith(['tag', 'add'])
        );
        this.ctx.sandbox.stub(window, 'showInputBox').resolves(undefined);

        await commands.executeCommand('zit.tagAdd', 'abc123' as ZitCheckin);

        sinon.assert.notCalled(add);
    });

    test('does not mutate a stash when its picker is cancelled', async () => {
        const exec = getExecStub(this.ctx.sandbox);
        const list = exec.withArgs(['stash', 'list']).resolves(
            fakeExecutionResult({
                stdout: '7: [abc123] 1 file(s) - work\n',
            })
        );
        const show = exec.withArgs(
            sinon.match.array.startsWith(['stash', 'show'])
        );
        const apply = exec.withArgs(
            sinon.match.array.startsWith(['stash', 'apply'])
        );
        const pop = exec.withArgs(
            sinon.match.array.startsWith(['stash', 'pop'])
        );
        const drop = exec.withArgs(
            sinon.match.array.startsWith(['stash', 'drop'])
        );
        this.ctx.sandbox.stub(window, 'showQuickPick').resolves(undefined);

        await commands.executeCommand('zit.stashShow');
        await commands.executeCommand('zit.stashApply');
        await commands.executeCommand('zit.stashPop');
        await commands.executeCommand('zit.stashDrop');

        sinon.assert.callCount(list, 4);
        sinon.assert.notCalled(show);
        sinon.assert.notCalled(apply);
        sinon.assert.notCalled(pop);
        sinon.assert.notCalled(drop);
    });

    test('does not save a stash when its message is cancelled', async () => {
        const save = getExecStub(this.ctx.sandbox).withArgs(
            sinon.match.array.startsWith(['stash', 'save'])
        );
        this.ctx.sandbox.stub(window, 'showInputBox').resolves(undefined);

        await commands.executeCommand('zit.stashSave');

        sinon.assert.notCalled(save);
    });

    test('does not push when the credential prompt is cancelled', async () => {
        const exec = getExecStub(this.ctx.sandbox);
        exec.withArgs(['remote']).resolves(
            fakeExecutionResult({
                stdout: 'https://example.test/repo.zit\n',
            })
        );
        const push = exec.withArgs(sinon.match.array.startsWith(['push']));
        this.ctx.sandbox.stub(window, 'showInputBox').resolves(undefined);

        await commands.executeCommand('zit.push');

        sinon.assert.notCalled(push);
    });

    test('does not push when the target URL prompt is cancelled', async () => {
        const exec = getExecStub(this.ctx.sandbox);
        exec.withArgs(['remote']).resolves(
            fakeExecutionResult({
                stdout: 'https://example.test/repo.zit\n',
            })
        );
        const push = exec.withArgs(sinon.match.array.startsWith(['push']));
        this.ctx.sandbox.stub(window, 'showInputBox').resolves(undefined);

        await commands.executeCommand('zit.pushTo');

        sinon.assert.notCalled(push);
    });

    test('does not sync when the password prompt is cancelled', async () => {
        const exec = getExecStub(this.ctx.sandbox);
        exec.withArgs(['remote']).resolves(
            fakeExecutionResult({
                stdout: 'https://example.test/repo.zit\n',
            })
        );
        const sync = exec.withArgs(sinon.match.array.startsWith(['sync']));
        const input = this.ctx.sandbox.stub(window, 'showInputBox');
        input.onFirstCall().resolves('alice');
        input.onSecondCall().resolves(undefined);

        await commands.executeCommand('zit.sync');

        sinon.assert.notCalled(sync);
    });

    test('pushes and syncs with prompted credentials', async () => {
        const exec = getExecStub(this.ctx.sandbox);
        exec.withArgs(['remote']).resolves(
            fakeExecutionResult({
                stdout: 'https://example.test/repo.zit\n',
            })
        );
        const push = exec
            .withArgs(['push', '--user', 'alice', '--password', 'secret'])
            .resolves(fakeExecutionResult());
        const sync = exec
            .withArgs(['sync', '--user', 'alice', '--password', 'secret'])
            .resolves(fakeExecutionResult());
        const input = this.ctx.sandbox.stub(window, 'showInputBox');
        input.onCall(0).resolves('alice');
        input.onCall(1).resolves('secret');
        input.onCall(2).resolves('alice');
        input.onCall(3).resolves('secret');

        await commands.executeCommand('zit.push');
        await commands.executeCommand('zit.sync');

        const pushSignal = push.firstCall.args[2]?.signal;
        const syncSignal = sync.firstCall.args[2]?.signal;
        assert.ok(pushSignal instanceof AbortSignal);
        assert.ok(syncSignal instanceof AbortSignal);
        sinon.assert.calledOnceWithExactly(
            push,
            ['push', '--user', 'alice', '--password', 'secret'],
            undefined,
            { signal: pushSignal }
        );
        sinon.assert.calledOnceWithExactly(
            sync,
            ['sync', '--user', 'alice', '--password', 'secret'],
            undefined,
            { signal: syncSignal }
        );
    });

    test('does not sync without a configured remote', async () => {
        const exec = getExecStub(this.ctx.sandbox);
        const remote = exec
            .withArgs(['remote'])
            .resolves(fakeExecutionResult({ stdout: 'no remote set\n' }));
        const sync = exec.withArgs(sinon.match.array.startsWith(['sync']));
        const error = this.ctx.sandbox.stub(
            window,
            'showErrorMessage'
        ) as sinon.SinonStub;
        error.resolves(undefined);

        await commands.executeCommand('zit.sync');

        sinon.assert.calledOnceWithExactly(remote, ['remote']);
        sinon.assert.calledOnceWithExactly(
            error,
            'Your repository has no remotes configured.'
        );
        sinon.assert.notCalled(sync);
    });

    test('facade sets and unsets the Zit remote', async () => {
        const exec = getExecStub(this.ctx.sandbox);
        const remote = Uri.parse('https://example.test/facade.zit') as ZitURI;
        const set = exec
            .withArgs(['remote', remote.toString()])
            .resolves(fakeExecutionResult());
        const unset = exec
            .withArgs(['remote', '--unset'])
            .resolves(fakeExecutionResult());
        const repository = getRepository();

        await repository.setRemote(remote);
        await repository.setRemote();

        sinon.assert.calledOnceWithExactly(set, ['remote', remote.toString()]);
        sinon.assert.calledOnceWithExactly(unset, ['remote', '--unset']);
    });

    test('renders current and closed branch descriptions and ignores separators', async () => {
        const picker = this.ctx.sandbox.stub(window, 'showQuickPick');
        picker.onFirstCall().callsFake(items => {
            const choices = items as unknown as {
                description?: string;
            }[];
            assert.equal(choices[0].description, 'current, closed');
            assert.equal(choices[1].description, '');
            return Promise.resolve(undefined);
        });
        assert.equal(
            await interaction.pickBranch(
                [
                    {
                        name: 'closed-current' as ZitBranch,
                        isCurrent: true,
                        isClosed: true,
                    },
                    {
                        name: 'open' as ZitBranch,
                        isCurrent: false,
                        isClosed: false,
                    },
                ],
                'Choose branch'
            ),
            undefined
        );

        picker.onSecondCall().callsFake(items => {
            const choices = items as unknown as {
                label: string;
                run?: () => void;
            }[];
            return Promise.resolve(choices[1]);
        });
        assert.equal(await interaction.pickUpdateCheckin([[], []]), undefined);
        sinon.assert.calledTwice(picker);
    });

    test('commits a new branch through commit --branch', async () => {
        const exec = getExecStub(this.ctx.sandbox);
        fakeZitStatus(exec, 'edited branch-work.txt\n');
        const repository = getRepository();
        await repository.updateStatus('Branch commit setup' as Reason);
        const commit = exec
            .withArgs([
                'commit',
                '--branch',
                'feature' as ZitBranch,
                '-m',
                'start feature' as ZitCommitMessage,
            ])
            .resolves(fakeExecutionResult());
        this.ctx.sandbox.stub(window, 'showInputBox').resolves('feature');
        repository.sourceControl.inputBox.value = 'start feature';

        try {
            await commands.executeCommand('zit.commitBranch');
            sinon.assert.calledOnceWithExactly(commit, [
                'commit',
                '--branch',
                'feature',
                '-m',
                'start feature',
            ]);
            assert.equal(repository.sourceControl.inputBox.value, '');
        } finally {
            fakeZitStatus(exec, '');
            await repository.updateStatus('Branch commit cleanup' as Reason);
        }
    });

    test('does not create a branch when its commit message is cancelled', async () => {
        const exec = getExecStub(this.ctx.sandbox);
        fakeZitStatus(exec, 'edited cancelled-branch.txt\n');
        const repository = getRepository();
        await repository.updateStatus('Cancelled branch setup' as Reason);
        repository.sourceControl.inputBox.value = '';
        const input = this.ctx.sandbox.stub(window, 'showInputBox');
        input.onFirstCall().resolves('feature');
        input.onSecondCall().resolves(undefined);
        const commit = exec.withArgs(sinon.match.array.startsWith(['commit']));

        try {
            await commands.executeCommand('zit.commitBranch');
            sinon.assert.calledTwice(input);
            sinon.assert.notCalled(commit);
        } finally {
            fakeZitStatus(exec, '');
            await repository.updateStatus('Cancelled branch cleanup' as Reason);
        }
    });

    test('closes a branch through commit --close', async () => {
        const exec = getExecStub(this.ctx.sandbox);
        fakeZitStatus(exec, 'edited close-work.txt\n');
        const repository = getRepository();
        await repository.updateStatus('Close branch setup' as Reason);
        const commit = exec
            .withArgs([
                'commit',
                '--close',
                '-m',
                'close feature' as ZitCommitMessage,
            ])
            .resolves(fakeExecutionResult());
        repository.sourceControl.inputBox.value = 'close feature';

        try {
            await commands.executeCommand('zit.closeBranch');
            sinon.assert.calledOnceWithExactly(commit, [
                'commit',
                '--close',
                '-m',
                'close feature',
            ]);
            assert.equal(repository.sourceControl.inputBox.value, '');
        } finally {
            fakeZitStatus(exec, '');
            await repository.updateStatus('Close branch cleanup' as Reason);
        }
    });

    test('does not add a tag without an explicit or current check-in', async () => {
        const repository = getRepository();
        const internal = repository as unknown as {
            _zitStatus: typeof repository.zitStatus;
        };
        const previousStatus = internal._zitStatus;
        const input = this.ctx.sandbox.stub(window, 'showInputBox');
        const add = getExecStub(this.ctx.sandbox).withArgs(
            sinon.match.array.startsWith(['tag', 'add'])
        );
        internal._zitStatus = undefined;

        try {
            await commands.executeCommand('zit.tagAdd');
            sinon.assert.notCalled(input);
            sinon.assert.notCalled(add);
        } finally {
            internal._zitStatus = previousStatus;
        }
    });

    test('uses an explicit check-in when adding a tag', async () => {
        const repository = getRepository();
        const explicitTarget = 'explicit-target' as ZitCheckin;
        const add = getExecStub(this.ctx.sandbox)
            .withArgs(['tag', 'add', 'release', explicitTarget])
            .resolves(fakeExecutionResult());
        this.ctx.sandbox.stub(window, 'showInputBox').resolves('release');
        const commandCenter = Object.create(
            CommandCenter.prototype
        ) as CommandCenter;

        await commandCenter.tagAdd(repository, explicitTarget);

        sinon.assert.calledOnceWithExactly(add, [
            'tag',
            'add',
            'release',
            explicitTarget,
        ]);
    });

    test('does not save a stash when dirty tracked files are refused', async () => {
        const repository = getRepository();
        const exec = getExecStub(this.ctx.sandbox);
        const uri = Uri.joinPath(Uri.file(repository.root), 'dirty-stash.txt');
        const ls = exec.withArgs(['ls']).resolves(
            fakeExecutionResult({
                stdout: `${'a'.repeat(64)} dirty-stash.txt\n`,
            })
        );
        const save = this.ctx.sandbox.stub().resolves(true);
        const document = {
            uri,
            isUntitled: false,
            isDirty: true,
            save,
        } as unknown as TextDocument;
        this.ctx.sandbox.stub(workspace, 'textDocuments').value([document]);
        this.ctx.sandbox.stub(window, 'showInputBox').resolves('keep working');
        const warning = this.ctx.sandbox.stub(
            window,
            'showWarningMessage'
        ) as sinon.SinonStub;
        warning.resolves(undefined);
        const stash = exec.withArgs(
            sinon.match.array.startsWith(['stash', 'save'])
        );

        await commands.executeCommand('zit.stashSave');
        sinon.assert.calledOnceWithExactly(ls, ['ls']);

        sinon.assert.calledOnce(warning);
        sinon.assert.notCalled(save);
        sinon.assert.notCalled(stash);
    });

    test('surfaces merge conflicts and opens each conflicted file', async () => {
        const repository = getRepository();
        const exec = getExecStub(this.ctx.sandbox);
        const mergeResult = fakeExecutionResult({
            exitCode: 1,
            stderr:
                'zit merge: conflict in ./a.txt\n' +
                'zit merge: conflict in nested/b.txt\n' +
                'zit merge: conflict in nested/b.txt\n',
        });
        exec.withArgs(['merge', 'abc123']).resolves(mergeResult);
        this.ctx.sandbox.stub(repository, 'updateStatus').resolves(undefined);
        const warning = this.ctx.sandbox.stub(
            window,
            'showWarningMessage'
        ) as sinon.SinonStub;
        warning.resolves(undefined);
        const open = this.ctx.sandbox
            .stub(workspace, 'openTextDocument')
            .callsFake(async uri => ({ uri }) as unknown as TextDocument);
        const show = this.ctx.sandbox.stub(window, 'showTextDocument');
        show.resolves();

        const result = await repository.merge(
            'abc123' as ZitCheckin,
            MergeAction.Merge
        );

        assert.equal(result, mergeResult);
        sinon.assert.calledOnceWithExactly(
            warning,
            'Merge conflicts require resolution:\n • a.txt\n • nested/b.txt'
        );
        sinon.assert.calledTwice(open);
        assert.equal(
            (open.firstCall.args[0] as Uri).fsPath,
            Uri.joinPath(Uri.file(repository.root), 'a.txt').fsPath
        );
        assert.equal(
            (open.secondCall.args[0] as Uri).fsPath,
            Uri.joinPath(Uri.file(repository.root), 'nested/b.txt').fsPath
        );
        sinon.assert.calledTwice(show);
    });
}
