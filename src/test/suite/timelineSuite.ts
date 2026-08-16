import * as vscode from 'vscode';
import { window } from 'vscode';
import * as assert from 'assert/strict';
import { ZitUriParams, toZitUri } from '../../uri';
import type { DocumentFsPath } from '../../zitExecutable';
import {
    add,
    cleanupZit,
    fakeExecutionResult,
    getExecStub,
    getExecutable,
    getModel,
    getRepository,
} from './common';
import { Suite, suiteSetup } from 'mocha';
import * as sinon from 'sinon';
import {
    OpenedRepository,
    RelativePath,
    ResourceStatus,
    ZitClass,
    ZitCheckin,
    ZitHash,
} from '../../openedRepository';
import * as interaction from '../../interaction';
import { CommitSources, type InteractionAPI } from '../../interaction';
import type {
    Commit,
    CommitDetails,
    ZitBranch,
    ZitCommitMessage,
    ZitUsername,
} from '../../openedRepository';
import { CommandCenter } from '../../commands';
import type { Model } from '../../model';
import type { Repository } from '../../repository';
import { ZitTimelineProvider } from '../../timelineProvider';

// separate function because hash size is different
const uriMatch = (uri: vscode.Uri, checkin: ZitCheckin) =>
    sinon.match((exp: vscode.Uri): boolean => {
        const exp_q = JSON.parse(exp.query) as ZitUriParams;
        return (
            uri.path === exp.path &&
            uri.fsPath === exp_q.path &&
            exp_q.checkin === checkin
        );
    });

export function timelineSuite(this: Suite): void {
    let file2uri: vscode.Uri;

    suiteSetup(async function () {
        this.timeout(30000);
        await cleanupZit(getRepository());
        await add('file1.txt', 'line1\n', 'file1.txt: first');
        await add('file1.txt', 'line1\nline2\n', 'file1.txt: second');
        await add('file1.txt', 'line1\nline2\nline3\n', 'file1.txt: third');
        await add('file2.txt', 'line1\n', 'file2.txt: first');
        await add('file2.txt', 'line1\nline2\n', 'file2.txt: second');
        file2uri = await add(
            'file2.txt',
            'line1\nline2\nline3\n',
            'file2.txt: third'
        );
    });

    test('parses bounded Zit timeline rows and resolves full check-ins', async () => {
        const repository = getRepository();
        const exec = getExecStub(this.ctx.sandbox);
        const first = 'a'.repeat(64) as ZitHash;
        const second = 'b'.repeat(64) as ZitHash;

        exec.withArgs(['timeline', '-n', '2']).resolves(
            fakeExecutionResult({
                stdout:
                    `not a timeline row\n` +
                    `  ${first.slice(
                        0,
                        12
                    )}  2026-08-15T17:26:35  trunk  seed\n` +
                    `M ${second.slice(
                        0,
                        12
                    )}  2026-08-14T16:25:34  feature  merge\n`,
            })
        );
        exec.withArgs(['info', first.slice(0, 12)]).resolves(
            fakeExecutionResult({
                stdout: `${first}\nbranch:  trunk\nleaf:    no\n`,
            })
        );
        exec.withArgs(['info', second.slice(0, 12)]).resolves(
            fakeExecutionResult({
                stdout: `${second}\nbranch:  feature\nleaf:    open\n`,
            })
        );
        exec.withArgs(['artifact', first, '--raw']).resolves(
            fakeExecutionResult({
                stdout: 'C seed\nD 2026-08-15T17:26:35\nU alice\nZ ignored\n',
            })
        );
        exec.withArgs(['artifact', second, '--raw']).resolves(
            fakeExecutionResult({
                stdout: `C merge\nD 2026-08-14T16:25:34\nP ${first} ${'c'.repeat(
                    64
                )}\nU bob\nZ ignored\n`,
            })
        );

        const commits = await repository.getLogEntries({ limit: 2 });

        assert.deepEqual(
            commits.map(commit => ({
                hash: commit.hash,
                branch: commit.branch,
                message: commit.message,
                author: commit.author,
                date: commit.date.toISOString(),
            })),
            [
                {
                    hash: first,
                    branch: 'trunk',
                    message: 'seed',
                    author: 'alice',
                    date: '2026-08-15T17:26:35.000Z',
                },
                {
                    hash: second,
                    branch: 'feature',
                    message: 'merge',
                    author: 'bob',
                    date: '2026-08-14T16:25:34.000Z',
                },
            ]
        );
        sinon.assert.calledOnceWithExactly(
            exec.withArgs(['timeline', '-n', '2']),
            ['timeline', '-n', '2']
        );
    });

    test('uses file-filtered Zit log and primary-parent diff details', async () => {
        const repository = getRepository();
        const exec = getExecStub(this.ctx.sandbox);
        const checkin = 'd'.repeat(64) as ZitHash;
        const primary = 'e'.repeat(64) as ZitHash;
        const mergeParent = 'f'.repeat(64) as ZitHash;
        const fileUri = vscode.Uri.joinPath(
            this.ctx.workspaceUri,
            'history',
            'file.txt'
        );
        const relativePath = 'history/file.txt' as RelativePath;

        exec.withArgs(['log', '-n', '1', checkin, relativePath]).resolves(
            fakeExecutionResult({ stdout: `checkin ${checkin}\n` })
        );
        exec.withArgs(['info', checkin]).resolves(
            fakeExecutionResult({
                stdout:
                    `${checkin}\nbranch:  feature\nleaf:    open\n` +
                    `parent:  ${primary}\nmerge:   ${mergeParent}\n`,
            })
        );
        exec.withArgs(['artifact', checkin, '--raw']).resolves(
            fakeExecutionResult({
                stdout:
                    `C merge\\sprimary\nD 2026-08-15T17:26:35\n` +
                    `P ${primary} ${mergeParent}\nU carol\nZ ignored\n`,
            })
        );
        exec.withArgs(['log', '-n', '1', checkin]).resolves(
            fakeExecutionResult({ stdout: `checkin ${checkin}\n` })
        );

        const commits = await repository.getLogEntries({
            fileUri,
            checkin,
            limit: 1,
        });

        assert.equal(commits.length, 1);
        assert.equal(commits[0].message, 'merge primary');
        assert.equal(commits[0].author, 'carol');
        sinon.assert.calledOnceWithExactly(
            exec.withArgs(['log', '-n', '1', checkin, relativePath]),
            ['log', '-n', '1', checkin, relativePath]
        );

        exec.withArgs([
            'diff',
            '--brief',
            '--from',
            primary,
            '--to',
            checkin,
        ]).resolves(
            fakeExecutionResult({
                stdout:
                    'M\thistory/spaced\\sfile.txt\n' +
                    'D\tdeleted\\\\name.bin\n' +
                    'A added.bin\nnot a changed-file row\n',
            })
        );
        const details = await repository.getCommitDetails(checkin);
        assert.deepEqual(
            details.files.map(file => [file.status, file.path]),
            [
                [ResourceStatus.MODIFIED, 'history/spaced file.txt'],
                [ResourceStatus.DELETED, 'deleted/name.bin'],
                [ResourceStatus.ADDED, 'added.bin'],
            ]
        );
    });

    test('models root commit additions with an empty diff left side', async () => {
        const repository = getRepository();
        const repositoryAccess = repository as unknown as {
            repository: OpenedRepository;
        };
        const openedRepository = repositoryAccess.repository;
        const exec = getExecStub(this.ctx.sandbox);
        const root = '1'.repeat(64) as ZitHash;

        exec.withArgs(['log', '-n', '1', root]).resolves(
            fakeExecutionResult({ stdout: `checkin ${root}\n` })
        );
        exec.withArgs(['info', root]).resolves(
            fakeExecutionResult({
                stdout: `${root}\nbranch:  trunk\nleaf:    open\n`,
            })
        );
        exec.withArgs(['artifact', root, '--raw']).resolves(
            fakeExecutionResult({
                stdout:
                    `C root\nD 2026-08-15T17:26:35\n` +
                    `F binary.bin ${'2'.repeat(64)}\n` +
                    `F spaced\\sname.bin ${'3'.repeat(64)}\n` +
                    `F removed.bin\nU root-user\nZ ignored\n`,
            })
        );

        const details = await repository.getCommitDetails(root);
        assert.deepEqual(
            details.files.map(file => [file.status, file.path]),
            [
                [ResourceStatus.ADDED, 'binary.bin'],
                [ResourceStatus.ADDED, 'spaced name.bin'],
            ]
        );
        assert.equal(await openedRepository.getInfo(root, 'parent'), undefined);

        const diff = this.ctx.sandbox
            .stub(vscode.commands, 'executeCommand')
            .withArgs('vscode.diff')
            .resolves();
        await repository.diffToParent(
            'binary.bin' as RelativePath,
            root,
            ResourceStatus.ADDED
        );
        const [left, right] = diff.firstCall.args.slice(1, 3) as vscode.Uri[];
        assert.equal((JSON.parse(left.query) as ZitUriParams).empty, true);
        assert.equal((JSON.parse(right.query) as ZitUriParams).checkin, root);
    });

    test('uses empty virtual sides for added and deleted historical files', async () => {
        const repository = getRepository();
        const exec = getExecStub(this.ctx.sandbox);
        const checkin = '8'.repeat(64) as ZitHash;
        const parent = '9'.repeat(64) as ZitHash;
        exec.withArgs(['info', checkin]).resolves(
            fakeExecutionResult({ stdout: `${checkin}\n` })
        );
        exec.withArgs(['artifact', checkin, '--raw']).resolves(
            fakeExecutionResult({
                stdout: `D 2026-08-15T17:26:35\nP ${parent}\n`,
            })
        );
        const diff = this.ctx.sandbox
            .stub(vscode.commands, 'executeCommand')
            .withArgs('vscode.diff')
            .resolves();

        await repository.diffToParent(
            'added.bin' as RelativePath,
            checkin,
            ResourceStatus.ADDED
        );
        await repository.diffToParent(
            'deleted.bin' as RelativePath,
            checkin,
            ResourceStatus.DELETED
        );

        const addedUris = diff.firstCall.args.slice(1, 3) as vscode.Uri[];
        assert.equal(
            (JSON.parse(addedUris[0].query) as ZitUriParams).empty,
            true
        );
        assert.equal(
            (JSON.parse(addedUris[1].query) as ZitUriParams).checkin,
            checkin
        );
        const deletedUris = diff.secondCall.args.slice(1, 3) as vscode.Uri[];
        assert.equal(
            (JSON.parse(deletedUris[0].query) as ZitUriParams).checkin,
            parent
        );
        assert.equal(
            (JSON.parse(deletedUris[1].query) as ZitUriParams).empty,
            true
        );
    });

    test('reads binary history with zit cat and parses full annotate output', async () => {
        const repository = getRepository();
        const repositoryAccess = repository as unknown as {
            repository: OpenedRepository;
        };
        const openedRepository = repositoryAccess.repository;
        const executable = getExecutable();
        assert.deepEqual(
            await repository.cat({
                path: this.ctx.workspaceUri.fsPath,
                empty: true,
            }),
            Buffer.alloc(0)
        );
        assert.equal(
            await repository.cat({ path: this.ctx.workspaceUri.fsPath }),
            undefined
        );
        const checkin = '3'.repeat(64) as ZitHash;
        const bytes = Buffer.from([0, 1, 2, 255]);
        const cat = this.ctx.sandbox.stub(executable, 'cat').resolves(bytes);
        const content = await openedRepository.cat(
            'binary.bin' as RelativePath,
            checkin
        );
        assert.deepEqual(content, bytes);
        sinon.assert.calledOnceWithExactly(cat, openedRepository.root, [
            'cat',
            'binary.bin',
            checkin,
        ]);

        const exec = getExecStub(this.ctx.sandbox);
        exec.withArgs(['annotate', 'notes.txt', '--full']).resolves(
            fakeExecutionResult({
                stdout:
                    `malformed annotate row\n` +
                    `${checkin} 2026-08-15 first line\n` +
                    `${checkin} 2026-08-15 second line\n`,
            })
        );
        const notesPath = vscode.Uri.joinPath(
            this.ctx.workspaceUri,
            'notes.txt'
        ).fsPath as DocumentFsPath;
        assert.deepEqual(await openedRepository.annotate(notesPath), [
            [checkin, '2026-08-15', ''],
            [checkin, '2026-08-15', ''],
        ]);
    });

    test('bounds malformed history and rejects incomplete Zit data', async () => {
        const repository = getRepository();
        const repositoryAccess = repository as unknown as {
            repository: OpenedRepository;
        };
        const openedRepository = repositoryAccess.repository;
        const exec = getExecStub(this.ctx.sandbox);

        await assert.rejects(
            openedRepository.getLogEntries({
                filePath: 'file.txt' as RelativePath,
                limit: 1,
            }),
            /requires a check-in/
        );
        exec.withArgs(['annotate', 'missing.txt', '--full']).resolves(
            fakeExecutionResult({ exitCode: 1, stderr: 'not tracked\n' })
        );
        assert.deepEqual(
            await openedRepository.annotate(
                vscode.Uri.joinPath(this.ctx.workspaceUri, 'missing.txt')
                    .fsPath as DocumentFsPath
            ),
            []
        );
        const annotatedCheckin = '3'.repeat(64) as ZitCheckin;
        exec.withArgs([
            'annotate',
            'notes.txt',
            annotatedCheckin,
            '--full',
        ]).resolves(
            fakeExecutionResult({
                stdout: `${annotatedCheckin} 2026-08-15 relative\n`,
            })
        );
        assert.deepEqual(
            await openedRepository.annotate(
                'notes.txt' as DocumentFsPath,
                annotatedCheckin
            ),
            [[annotatedCheckin, '2026-08-15', '']]
        );

        for (const [limit, bounded] of [
            [0, '512'],
            [-2, '2'],
            [999, '512'],
        ] as const) {
            exec.withArgs(['timeline', '-n', bounded]).resolves(
                fakeExecutionResult({ stdout: 'not a timeline row\n' })
            );
            assert.deepEqual(
                await openedRepository.getLogEntries({ limit }),
                []
            );
        }

        const unresolved = 'missing' as ZitCheckin;
        exec.withArgs(['info', unresolved]).resolves(
            fakeExecutionResult({ stdout: 'not-a-hash\n' })
        );
        await assert.rejects(
            openedRepository.getInfo(unresolved, 'hash'),
            /did not resolve/
        );

        const unreadable = '4'.repeat(64) as ZitHash;
        exec.withArgs(['info', unreadable]).resolves(
            fakeExecutionResult({ stdout: `${unreadable}\n` })
        );
        exec.withArgs(['artifact', unreadable, '--raw']).resolves(
            fakeExecutionResult({ exitCode: 1, stderr: 'unreadable\n' })
        );
        await assert.rejects(
            openedRepository.getInfo(unreadable, 'parent'),
            /could not be read/
        );
        const encoded = '6'.repeat(64) as ZitHash;
        const parent = '7'.repeat(64) as ZitHash;
        exec.withArgs(['info', encoded]).resolves(
            fakeExecutionResult({
                stdout: `${encoded}\nbranch:  trunk\nmalformed field\n`,
            })
        );
        exec.withArgs(['artifact', encoded, '--raw']).resolves(
            fakeExecutionResult({
                stdout:
                    'C line\\sone\\nline\\ttwo\\r\\\\end\n' +
                    'D 2026-08-15T17:26:35\n' +
                    `P invalid ${parent}\nF \nU user\\sname\nZ ignored\n`,
            })
        );
        const encodedInfo = await openedRepository.info(encoded);
        assert.equal(encodedInfo.comment, 'line one\nline\ttwo\r\\end');
        assert.equal(encodedInfo.user, 'user name');
        assert.equal(encodedInfo.parent, parent);

        const undated = '5'.repeat(64) as ZitHash;
        exec.withArgs(['log', '-n', '1', undated]).resolves(
            fakeExecutionResult({
                stdout: `not a log row\ncheckin ${undated}\n`,
            })
        );
        exec.withArgs(['info', undated]).resolves(
            fakeExecutionResult({ stdout: `${undated}\n` })
        );
        exec.withArgs(['artifact', undated, '--raw']).resolves(
            fakeExecutionResult({ stdout: 'C no\\sdate\nU nobody\n' })
        );
        await assert.rejects(
            openedRepository.getLogEntries({
                checkin: undated,
                limit: 1,
            }),
            /has no date/
        );
        const fallback = '8'.repeat(64) as ZitHash;
        exec.withArgs(['log', '-n', '1', fallback]).resolves(
            fakeExecutionResult({ stdout: `checkin ${fallback}\n` })
        );
        exec.withArgs(['info', fallback]).resolves(
            fakeExecutionResult({ stdout: `${fallback}\n` })
        );
        exec.withArgs(['artifact', fallback, '--raw']).resolves(
            fakeExecutionResult({ stdout: 'D 2026-08-15T17:26:35Z\n' })
        );
        assert.deepEqual(
            await openedRepository.getLogEntries({
                checkin: fallback,
                limit: 1,
            }),
            [
                {
                    author: '',
                    branch: 'trunk',
                    date: new Date('2026-08-15T17:26:35Z'),
                    hash: fallback,
                    message: '',
                },
            ]
        );
    });

    test('`zit.fileLog` undefined', async () => {
        await vscode.commands.executeCommand('zit.fileLog');
    });

    test('Show diff from `zit.fileLog`', async () => {
        const repository = getRepository();
        const showQuickPick = this.ctx.sandbox.stub(window, 'showQuickPick');
        showQuickPick.onFirstCall().callsFake(items => {
            assert.ok(items instanceof Array);
            assert.equal(items[0].label, '$(tag) Current');
            return Promise.resolve(items[0]);
        });
        showQuickPick.onSecondCall().callsFake(items => {
            assert.ok(items instanceof Array);
            assert.equal(items[0].label, '$(circle-outline) Parent');
            return Promise.resolve(items[0]);
        });

        const diffCommand = this.ctx.sandbox
            .stub(vscode.commands, 'executeCommand')
            .callThrough()
            .withArgs('vscode.diff')
            .resolves();

        await vscode.commands.executeCommand('zit.fileLog', file2uri);
        sinon.assert.calledTwice(showQuickPick);

        const currentHash = await repository.getInfo('current', 'hash');
        const parentHash = await repository.getInfo(currentHash, 'parent');
        assert.ok(parentHash);
        sinon.assert.calledOnceWithExactly(
            diffCommand,
            'vscode.diff',
            toZitUri(file2uri, currentHash),
            toZitUri(file2uri, parentHash),
            `file2.txt (${currentHash.slice(0, 12)} vs. ${parentHash.slice(
                0,
                12
            )})`
        );
    }).timeout(2000);

    const testDiff = async (
        callback: (
            items: readonly vscode.QuickPickItem[]
        ) => Thenable<vscode.QuickPickItem>
    ) => {
        const repository = getRepository();
        const showQuickPick = this.ctx.sandbox.stub(window, 'showQuickPick');
        showQuickPick.onFirstCall().callsFake(items => {
            assert.ok(items instanceof Array);

            assert.equal(items[0].label, '$(tag) Current');
            return Promise.resolve(items[0]);
        });
        showQuickPick.onSecondCall().callsFake(items => {
            assert.ok(items instanceof Array);
            return callback(items);
        });

        const diffCommand = this.ctx.sandbox
            .stub(vscode.commands, 'executeCommand')
            .callThrough()
            .withArgs('vscode.diff')
            .resolves();

        await vscode.commands.executeCommand('zit.log');
        sinon.assert.calledTwice(showQuickPick);

        const currentHash = await repository.getInfo('current', 'hash');
        const parentHash = await repository.getInfo(currentHash, 'parent');
        assert.ok(parentHash);

        sinon.assert.calledOnceWithExactly(
            diffCommand,
            'vscode.diff',
            uriMatch(file2uri, parentHash),
            uriMatch(file2uri, currentHash),
            `file2.txt (${parentHash.slice(0, 12)} vs. ${currentHash.slice(
                0,
                12
            )})`,
            { preview: false }
        );
    };
    for (const scenario of [
        {
            name: 'current',
            item: 1,
            label: '$(tag) Current',
            target: 'current' as const,
        },
        {
            name: 'tip',
            item: 2,
            label: '$(tag) Tip',
            target: 'tip' as const,
        },
        {
            name: 'working checkout',
            item: 3,
            label: '$(circle-outline) Checkout',
            target: undefined,
        },
    ]) {
        test(`Show file history against ${scenario.name}`, async () => {
            const repository = getRepository();
            const currentHash = await repository.getInfo('current', 'hash');
            const targetHash =
                scenario.target === undefined
                    ? undefined
                    : await repository.getInfo(scenario.target, 'hash');
            const showQuickPick = this.ctx.sandbox.stub(
                window,
                'showQuickPick'
            );
            showQuickPick.onFirstCall().callsFake(items => {
                assert.ok(items instanceof Array);
                return Promise.resolve(items[0]);
            });
            showQuickPick.onSecondCall().callsFake(items => {
                assert.ok(items instanceof Array);
                assert.equal(items[scenario.item].label, scenario.label);
                return Promise.resolve(items[scenario.item]);
            });
            const diffCommand = this.ctx.sandbox
                .stub(vscode.commands, 'executeCommand')
                .callThrough()
                .withArgs('vscode.diff')
                .resolves();

            await vscode.commands.executeCommand('zit.fileLog', file2uri);

            const targetUri =
                targetHash === undefined
                    ? file2uri
                    : toZitUri(file2uri, targetHash);
            const targetName = targetHash?.slice(0, 12) ?? 'local';
            sinon.assert.calledOnceWithExactly(
                diffCommand,
                'vscode.diff',
                toZitUri(file2uri, currentHash),
                targetUri,
                `file2.txt (${currentHash.slice(0, 12)} vs. ${targetName})`
            );
        }).timeout(2000);
    }

    test('Show diff from `zit.Log`', async () => {
        await testDiff(items => {
            assert.equal(items[4].label, '    M  file2.txt');
            return Promise.resolve(items[4]);
        });
    });

    test('Show diff all from `zit.Log`', async () => {
        await testDiff(items => {
            assert.equal(
                items[2].label,
                '$(go-to-file) Open all changed files'
            );
            return Promise.resolve(items[2]);
        });
    });

    test('Amend commit message', async () => {
        await add('amend.txt', '\n', 'message to amend');

        const showQuickPick = this.ctx.sandbox.stub(window, 'showQuickPick');
        showQuickPick.onFirstCall().callsFake(items => {
            assert.ok(items instanceof Array);
            assert.equal(items[0].label, '$(tag) Current');
            return Promise.resolve(items[0]);
        });
        showQuickPick.onSecondCall().callsFake(items => {
            assert.ok(items instanceof Array);
            const aItem = items.find(item => item.label === '    A  amend.txt');
            assert.ok(aItem);
            assert.equal(aItem.description, '.');
            assert.equal(items[1].label, '$(edit) Edit commit message');
            return Promise.resolve(items[1]);
        });
        const messageStub = this.ctx.sandbox
            .stub(window, 'showInputBox')
            .withArgs(sinon.match({ placeHolder: 'Commit message' }))
            .resolves('updated commit message');
        const sim: sinon.SinonStub = this.ctx.sandbox
            .stub(window, 'showInformationMessage')
            .resolves();

        await vscode.commands.executeCommand('zit.log');
        sinon.assert.calledTwice(showQuickPick);
        sinon.assert.calledOnceWithExactly(messageStub, {
            value: 'message to amend',
            placeHolder: 'Commit message',
            prompt: 'Please provide a commit message',
            ignoreFocusOut: true,
        });
        sinon.assert.calledOnceWithExactly(sim, 'Commit message was updated.');

        const repository = getRepository();
        const currentHash = await repository.getInfo('current', 'hash');
        const info = await repository.info(currentHash);
        assert.equal(info.comment, 'updated commit message');
    }).timeout(5000);

    test('Rejects current history without a checkout check-in', async () => {
        const repository = getRepository();
        const internals = repository as unknown as {
            _zitStatus: unknown;
        };
        const status = internals._zitStatus;
        internals._zitStatus = undefined;
        try {
            await assert.rejects(
                repository.info('current'),
                /has no current check-in/
            );
        } finally {
            internals._zitStatus = status;
        }
    });

    test('History command resolves explicit and selected repositories', async () => {
        const repository = getRepository();
        const showQuickPick = this.ctx.sandbox
            .stub(window, 'showQuickPick')
            .resolves(undefined);
        await vscode.commands.executeCommand('zit.log', repository);
        sinon.assert.calledOnce(showQuickPick);
        showQuickPick.resetHistory();

        const model = getModel();
        const repositories = this.ctx.sandbox
            .stub(model, 'repositories')
            .value([repository, repository]);
        const pickRepository = this.ctx.sandbox
            .stub(model, 'pickRepository')
            .resolves(undefined);
        await vscode.commands.executeCommand('zit.log');
        sinon.assert.calledOnce(pickRepository);
        sinon.assert.notCalled(showQuickPick);
        pickRepository.restore();
        repositories.restore();
    });

    test('History picker actions preserve no-op and separator behavior', async () => {
        const commit: Commit = {
            author: 'user' as ZitUsername,
            branch: 'trunk' as ZitBranch,
            date: new Date('2026-08-15T17:26:35Z'),
            hash: '9'.repeat(64) as ZitHash,
            message: 'history item' as ZitCommitMessage,
        };
        const showQuickPick = this.ctx.sandbox.stub(window, 'showQuickPick');
        showQuickPick.onFirstCall().callsFake(items => {
            assert.ok(items instanceof Array);
            const selected = items[0] as vscode.QuickPickItem & {
                run(): void;
            };
            selected.run();
            return Promise.resolve(selected);
        });
        assert.equal(
            await interaction.pickCommitToCherrypick([commit]),
            commit.hash
        );

        const run = this.ctx.sandbox.stub();
        const action = this.ctx.sandbox.stub().returns(run);
        showQuickPick.onSecondCall().callsFake(items => {
            assert.ok(items instanceof Array);
            return Promise.resolve(items[1]);
        });
        const back = await interaction.pickCommit(
            CommitSources.Repo,
            [commit],
            action
        );
        assert.ok(back);
        showQuickPick.onThirdCall().callsFake(items => {
            assert.ok(items instanceof Array);
            assert.equal(items[0], back);
            return Promise.resolve(undefined);
        });
        await interaction.pickCommit(
            CommitSources.Repo,
            [commit],
            action,
            back
        );
        showQuickPick.onCall(3).callsFake(items => {
            assert.ok(items instanceof Array);
            return Promise.resolve(items[5]);
        });
        await interaction.pickDiffAction([commit], action, run);
        sinon.assert.notCalled(run);
    });

    test('History details handle default file icons and unchanged edits', async () => {
        const commit: Commit = {
            author: 'user' as ZitUsername,
            branch: 'trunk' as ZitBranch,
            date: new Date('2026-08-15T17:26:35Z'),
            hash: 'a'.repeat(64) as ZitHash,
            message: 'unchanged message' as ZitCommitMessage,
        };
        const details: CommitDetails = {
            ...commit,
            files: [
                {
                    klass: 'EDITED' as ZitClass,
                    path: 'unclassified.txt' as RelativePath,
                    status: '' as unknown as ResourceStatus,
                },
            ],
        };
        const updateCommitMessage = this.ctx.sandbox.stub().resolves();
        const api: InteractionAPI = {
            currentBranch: commit.branch,
            getCommitDetails: this.ctx.sandbox.stub().resolves(details),
            getLogEntries: this.ctx.sandbox.stub().resolves([commit]),
            diffToParent: this.ctx.sandbox.stub().resolves(),
            updateCommitMessage,
        };
        const showQuickPick = this.ctx.sandbox.stub(window, 'showQuickPick');
        for (const call of [0, 2]) {
            showQuickPick.onCall(call).callsFake(items => {
                assert.ok(items instanceof Array);
                return Promise.resolve(items[1]);
            });
            showQuickPick.onCall(call + 1).callsFake(items => {
                assert.ok(items instanceof Array);
                assert.equal(items[4].label, '      unclassified.txt');
                return Promise.resolve(items[1]);
            });
        }
        const input = this.ctx.sandbox.stub(window, 'showInputBox');
        input.onFirstCall().resolves(undefined);
        input.onSecondCall().resolves(commit.message);

        await interaction.presentLogSourcesMenu(api);
        await interaction.presentLogSourcesMenu(api);

        sinon.assert.notCalled(updateCommitMessage);
    });
    test('History details return to the same bounded source list', async () => {
        const commit: Commit = {
            author: 'user' as ZitUsername,
            branch: 'trunk' as ZitBranch,
            date: new Date('2026-08-15T17:26:35Z'),
            hash: 'b'.repeat(64) as ZitHash,
            message: 'return to history' as ZitCommitMessage,
        };
        const details: CommitDetails = {
            ...commit,
            files: [],
        };
        const getCommitDetails = this.ctx.sandbox.stub().resolves(details);
        const api: InteractionAPI = {
            currentBranch: commit.branch,
            getCommitDetails,
            getLogEntries: this.ctx.sandbox.stub().resolves([commit]),
            diffToParent: this.ctx.sandbox.stub().resolves(),
            updateCommitMessage: this.ctx.sandbox.stub().resolves(),
        };
        const showQuickPick = this.ctx.sandbox.stub(window, 'showQuickPick');
        showQuickPick.onFirstCall().callsFake(items => {
            assert.ok(items instanceof Array);
            assert.equal(items.length, 2);
            return Promise.resolve(items[1]);
        });
        showQuickPick.onSecondCall().callsFake(items => {
            assert.ok(items instanceof Array);
            assert.equal(items[0].label, '$(arrow-left)  go back');
            assert.equal(items[0].description, 'to repo history');
            return Promise.resolve(items[0]);
        });
        showQuickPick.onThirdCall().callsFake(items => {
            assert.ok(items instanceof Array);
            assert.equal(items.length, 2);
            assert.equal(
                items[1].label,
                `$(circle-outline) ${commit.hash.slice(0, 12)} • trunk`
            );
            return Promise.resolve(undefined);
        });

        await interaction.presentLogSourcesMenu(api);

        sinon.assert.calledThrice(showQuickPick);
        sinon.assert.calledOnceWithExactly(getCommitDetails, commit.hash);
    });
    test('Timeline view renders project commits with Zit metadata', async () => {
        const commit: Commit = {
            author: 'timeline-user' as ZitUsername,
            branch: 'trunk' as ZitBranch,
            date: new Date('2026-08-15T17:26:35Z'),
            hash: 'c'.repeat(64) as ZitHash,
            message: 'Timeline view commit' as ZitCommitMessage,
        };
        const getLogEntries = this.ctx.sandbox.stub().resolves([commit]);
        const repository = {
            root: '/tmp/timeline-project',
            getLogEntries,
        } as unknown as Repository;
        const repositoryChanged = new vscode.EventEmitter<unknown>();
        const repositoryOpened = new vscode.EventEmitter<Repository>();
        const repositoryClosed = new vscode.EventEmitter<Repository>();
        const model = {
            repositories: [repository],
            getRepository: this.ctx.sandbox.stub().returns(repository),
            onDidChangeRepository: repositoryChanged.event,
            onDidOpenRepository: repositoryOpened.event,
            onDidCloseRepository: repositoryClosed.event,
        } as unknown as Model;
        const provider = new ZitTimelineProvider(model);

        try {
            provider.showProject();
            const items = await provider.getChildren();

            assert.equal(items.length, 1);
            assert.equal(items[0].label, commit.message);
            assert.match(String(items[0].description), /trunk/);
            assert.match(String(items[0].description), /timeline-user/);
            assert.match(String(items[0].description), /c{12}/);
            assert.deepEqual(items[0].command, {
                command: 'zit.timelineOpen',
                title: 'Open Commit',
                arguments: [repository, commit, undefined],
            });
            sinon.assert.calledOnceWithExactly(getLogEntries, { limit: 51 });
        } finally {
            provider.dispose();
            repositoryChanged.dispose();
            repositoryOpened.dispose();
            repositoryClosed.dispose();
        }
    });

    test('Timeline view scopes file history and loads bounded pages', async () => {
        const commits = Array.from({ length: 120 }, (_, index): Commit => ({
            author: 'timeline-user' as ZitUsername,
            branch: 'trunk' as ZitBranch,
            date: new Date('2026-08-15T17:26:35Z'),
            hash: index.toString(16).padStart(64, '0') as ZitHash,
            message: `Timeline commit ${index}` as ZitCommitMessage,
        }));
        const getLogEntries = this.ctx.sandbox
            .stub()
            .callsFake(({ limit }: { limit: number }) =>
                Promise.resolve(commits.slice(0, limit))
            );
        const repository = {
            root: '/tmp/timeline-project',
            getLogEntries,
        } as unknown as Repository;
        const fileUri = vscode.Uri.file(
            '/tmp/timeline-project/src/timeline.ts'
        );
        const repositoryChanged = new vscode.EventEmitter<unknown>();
        const repositoryOpened = new vscode.EventEmitter<Repository>();
        const repositoryClosed = new vscode.EventEmitter<Repository>();
        const getRepository = this.ctx.sandbox.stub().returns(repository);
        const model = {
            repositories: [repository],
            getRepository,
            onDidChangeRepository: repositoryChanged.event,
            onDidOpenRepository: repositoryOpened.event,
            onDidCloseRepository: repositoryClosed.event,
        } as unknown as Model;
        const provider = new ZitTimelineProvider(model);

        try {
            // Exercise the editor-event boundary without exposing it publicly.
            const providerEvents = provider as unknown as {
                onActiveEditorChanged(editor: vscode.Uri | undefined): void;
            };
            providerEvents.onActiveEditorChanged(
                toZitUri(fileUri, commits[0].hash)
            );
            providerEvents.onActiveEditorChanged(undefined);
            getRepository.returns(undefined);
            repositoryChanged.fire(undefined);
            repositoryClosed.fire(repository);
            getRepository.returns(repository);
            repositoryOpened.fire(repository);
            const firstPage = await provider.getChildren();

            assert.equal(firstPage.length, 51);
            assert.equal(firstPage[firstPage.length - 1].label, 'Load more');
            const firstOptions = getLogEntries.firstCall.args[0] as {
                fileUri: vscode.Uri;
                limit: number;
            };
            assert.equal(firstOptions.fileUri.toString(), fileUri.toString());
            assert.equal(firstOptions.limit, 51);

            provider.loadMore(repository);
            const secondPage = await provider.getChildren();

            assert.equal(secondPage.length, 101);
            assert.equal(secondPage[secondPage.length - 1].label, 'Load more');
            const secondOptions = getLogEntries.secondCall.args[0] as {
                fileUri: vscode.Uri;
                limit: number;
            };
            assert.equal(secondOptions.fileUri.toString(), fileUri.toString());
            assert.equal(secondOptions.limit, 101);

            provider.loadMore(repository);
            const finalPage = await provider.getChildren();

            assert.equal(finalPage.length, commits.length);
            assert.notEqual(finalPage[finalPage.length - 1].label, 'Load more');
            const finalOptions = getLogEntries.thirdCall.args[0] as {
                fileUri: vscode.Uri;
                limit: number;
            };
            assert.equal(finalOptions.fileUri.toString(), fileUri.toString());
            assert.equal(finalOptions.limit, 151);
        } finally {
            provider.dispose();
            repositoryChanged.dispose();
            repositoryOpened.dispose();
            repositoryClosed.dispose();
        }
    });

    test('Timeline commands select scopes and open exact commits', async () => {
        const fileUri = vscode.Uri.file(
            '/tmp/timeline-project/src/timeline.ts'
        );
        const commit: Commit = {
            author: 'timeline-user' as ZitUsername,
            branch: 'trunk' as ZitBranch,
            date: new Date('2026-08-15T17:26:35Z'),
            hash: 'd'.repeat(64) as ZitHash,
            message: 'Open timeline commit' as ZitCommitMessage,
        };
        const showFile = this.ctx.sandbox.stub();
        const showProject = this.ctx.sandbox.stub();
        const loadMore = this.ctx.sandbox.stub();
        const refresh = this.ctx.sandbox.stub();
        const timeline = { showFile, showProject, loadMore, refresh };
        const commandCenter = Object.assign(
            Object.create(CommandCenter.prototype),
            { timeline }
        ) as CommandCenter;
        const executeCommand = this.ctx.sandbox
            .stub(vscode.commands, 'executeCommand')
            .resolves();

        await commandCenter.timelineFile(fileUri);
        await commandCenter.timelineProject();
        commandCenter.timelineRefresh();
        const repository = {
            mapFileUriToRepoRelativePath: this.ctx.sandbox
                .stub()
                .returns('src/timeline.ts' as RelativePath),
            getCommitDetails: this.ctx.sandbox.stub().resolves({
                ...commit,
                files: [
                    {
                        klass: 'EDITED' as ZitClass,
                        path: 'src/timeline.ts' as RelativePath,
                        status: ResourceStatus.MODIFIED,
                    },
                ],
            } satisfies CommitDetails),
            diffToParent: this.ctx.sandbox.stub().resolves(),
        } as unknown as Repository;
        await commandCenter.timelineLoadMore(repository);

        sinon.assert.calledOnceWithExactly(showFile, fileUri);
        sinon.assert.calledOnce(showProject);
        sinon.assert.calledOnceWithExactly(loadMore, repository);
        sinon.assert.calledOnce(refresh);
        sinon.assert.calledTwice(executeCommand);
        sinon.assert.alwaysCalledWithExactly(
            executeCommand,
            'zit.timeline.focus'
        );

        const presentCommit = this.ctx.sandbox
            .stub(interaction, 'presentCommit')
            .resolves();
        await commandCenter.timelineOpen(repository, commit);
        sinon.assert.calledOnceWithExactly(
            presentCommit,
            repository,
            commit.hash
        );

        await commandCenter.timelineOpen(repository, commit, fileUri);
        sinon.assert.calledOnceWithExactly(
            repository.diffToParent as sinon.SinonStub,
            'src/timeline.ts',
            commit.hash,
            ResourceStatus.MODIFIED
        );
    });
}
