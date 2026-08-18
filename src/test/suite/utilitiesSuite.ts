import * as vscode from 'vscode';
import { commands, Uri, window, workspace } from 'vscode';
import * as sinon from 'sinon';
import * as assert from 'assert/strict';
import { fakeExecutionResult, getExecStub, getRepository } from './common';
import { Suite, teardown, setup } from 'mocha';
import { debounce, memoize, sequentialize, throttle } from '../../decorators';
import { delay, dispose } from '../../util';
import { RelativePath, ZitHash } from '../../openedRepository';
import { fromZitUri, toZitEmptyUri, toZitUri } from '../../uri';
import * as interaction from '../../interaction';
import {
    ExecFailure,
    ZitArgsWithOptions,
    ZitStdOut,
} from '../../zitExecutable';

function undoSuite(this: Suite) {
    test('Undo executes once after confirmation', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        const undo = execStub
            .withArgs(['undo'])
            .resolves(
                fakeExecutionResult({ stdout: 'undo: working tree restored\n' })
            );
        const confirm = this.ctx.sandbox.stub(
            window,
            'showInformationMessage'
        ) as sinon.SinonStub;
        confirm.resolves('Undo');

        await commands.executeCommand('zit.undo');

        sinon.assert.calledOnceWithExactly(undo, ['undo']);
    });

    test('Undo warns when no operation is available', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        execStub.withArgs(['undo']).resolves(
            fakeExecutionResult({
                exitCode: 1,
                stderr: 'zit undo: nothing to undo\n',
            })
        );
        const confirm = this.ctx.sandbox.stub(
            window,
            'showInformationMessage'
        ) as sinon.SinonStub;
        confirm.resolves('Undo');
        const warning = this.ctx.sandbox.stub(
            window,
            'showWarningMessage'
        ) as sinon.SinonStub;

        await commands.executeCommand('zit.undo');

        sinon.assert.calledOnceWithExactly(warning, 'Nothing to undo.');
    });

    test('Undo propagates operational failures', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        execStub.withArgs(['undo']).resolves(
            fakeExecutionResult({
                exitCode: 1,
                stderr: '',
            })
        );
        const confirm = this.ctx.sandbox.stub(
            window,
            'showInformationMessage'
        ) as sinon.SinonStub;
        confirm.resolves('Undo');

        await assert.rejects(
            Promise.resolve(commands.executeCommand('zit.undo')),
            /zit undo failed/
        );
    });

    test('Redo executes after confirmation', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        const redo = execStub
            .withArgs(['redo'])
            .resolves(fakeExecutionResult({ stdout: 'redo complete\n' }));
        const info = this.ctx.sandbox.stub(
            window,
            'showInformationMessage'
        ) as sinon.SinonStub;
        info.resolves('Redo');

        await commands.executeCommand('zit.redo');

        sinon.assert.calledOnceWithExactly(redo, ['redo']);
    });

    test('Canceling undo does not execute it', async () => {
        const execStub = getExecStub(this.ctx.sandbox);
        const undo = execStub.withArgs(['undo']);
        this.ctx.sandbox
            .stub(window, 'showInformationMessage')
            .resolves(undefined);

        await commands.executeCommand('zit.undo');

        sinon.assert.notCalled(undo);
    });
    test('Dispose clears sets after disposing every member', () => {
        const first = { dispose: this.ctx.sandbox.stub() };
        const second = { dispose: this.ctx.sandbox.stub() };
        const disposables = new Set([first, second]);

        dispose(disposables);

        sinon.assert.calledOnce(first.dispose);
        sinon.assert.calledOnce(second.dispose);
        assert.equal(disposables.size, 0);
    });
}

function decoratorsSuite(this: Suite) {
    let fakeTimers: sinon.SinonFakeTimers;
    const startTimeStamp = new Date('2024-03-13T00:00:00Z').getTime();

    setup(() => {
        fakeTimers = sinon.useFakeTimers(startTimeStamp);
    });
    teardown(() => {
        // assert.equal(fakeTimers.countTimers(), 0, 'All timers must run');
        fakeTimers.restore();
    });

    test('Memoize', async () => {
        class MemoizeTest {
            constructor(
                public memoize_count_a = 0,
                public memoize_count_b = 0
            ) {}
            @memoize
            public get memoized_property_a(): Uri {
                ++this.memoize_count_a;
                return Uri.file('memoize_a.txt');
            }
            @memoize
            public get memoized_property_b(): Uri {
                ++this.memoize_count_b;
                return Uri.file('memoize_b.txt');
            }
            public get counts(): [number, number] {
                return [this.memoize_count_a, this.memoize_count_b];
            }
        }
        const dt = new MemoizeTest();
        assert.equal(dt.memoized_property_a.fsPath, '/memoize_a.txt');
        assert.deepStrictEqual(dt.counts, [1, 0]);
        assert.equal(dt.memoized_property_a.fsPath, '/memoize_a.txt');
        assert.deepStrictEqual(dt.counts, [1, 0]);
        assert.equal(dt.memoized_property_b.fsPath, '/memoize_b.txt');
        assert.deepStrictEqual(dt.counts, [1, 1]);
        assert.equal(dt.memoized_property_b.fsPath, '/memoize_b.txt');
        assert.deepStrictEqual(dt.counts, [1, 1]);
        assert.equal(dt.memoized_property_a.fsPath, '/memoize_a.txt');
        assert.deepStrictEqual(dt.counts, [1, 1]);
    });
    test('Throttle', async () => {
        class ThrottledTest {
            constructor(public throttle_count = 0) {}
            @throttle
            async throttled_method(key: string): Promise<string> {
                await delay(25);
                return `${key}-${this.throttle_count++}`;
            }
        }
        const dt = new ThrottledTest();
        assert.equal(fakeTimers.countTimers(), 0);
        const p0 = dt.throttled_method('a');
        const p1 = dt.throttled_method('b');
        const p2 = dt.throttled_method('c');
        assert.equal(fakeTimers.countTimers(), 1);
        const resPromise = Promise.all([p0, p1, p2]);
        await fakeTimers.runAllAsync();
        assert.equal(fakeTimers.countTimers(), 0);
        assert.deepStrictEqual(await resPromise, ['a-0', 'b-1', 'b-1']);
        assert.equal(fakeTimers.countTimers(), 0);
        assert.equal(dt.throttle_count, 2);
    });
    test('Sequentialize', async () => {
        class SequentializeTest {
            constructor(public sequentialize_count = 0) {}
            @sequentialize
            async sequentialized_method(
                ms: number,
                key: string
            ): Promise<string> {
                await delay(ms);
                return `${key}-${this.sequentialize_count++}`;
            }
        }

        const dt = new SequentializeTest();
        const p0 = dt.sequentialized_method(50, 'a');
        const p1 = dt.sequentialized_method(20, 'b');
        const p2 = dt.sequentialized_method(10, 'c');
        const resPromise = Promise.race([p0, p1, p2]);
        assert.equal(fakeTimers.countTimers(), 0);
        await fakeTimers.runAllAsync();
        assert.deepStrictEqual(await resPromise, 'a-0');
        assert.equal(fakeTimers.countTimers(), 0);
        assert.equal(dt.sequentialize_count, 3);
        assert.deepStrictEqual(await p1, 'b-1');
        assert.deepStrictEqual(await p2, 'c-2');
    });
    test('Debounce', async () => {
        class DebounceTest {
            constructor(public debounce_count = 0) {}
            @debounce(50)
            debounced_method(): void {
                this.debounce_count++;
            }
        }

        const dt = new DebounceTest();
        assert.equal(fakeTimers.countTimers(), 0);
        const p0 = dt.debounced_method();
        assert.equal(fakeTimers.countTimers(), 1);
        const p1 = dt.debounced_method();
        const p2 = dt.debounced_method();
        const resPromise = Promise.all([p0, p1, p2]);
        assert.equal(fakeTimers.countTimers(), 1);
        const debounceTimer = fakeTimers.next();
        assert.deepEqual(await resPromise, [undefined, undefined, undefined]);
        assert.equal(fakeTimers.countTimers(), 0);
        assert.equal(debounceTimer, startTimeStamp + 50, 'main timer worked');
        assert.equal(dt.debounce_count, 1, 'reached main timer only');
    });
}

function coreInteractionSuite(this: Suite): void {
    test('Clone progress forwards cancellation to the operation', async () => {
        const cancellation = new vscode.CancellationTokenSource();
        const withProgress = this.ctx.sandbox.stub(
            window,
            'withProgress'
        ) as sinon.SinonStub;
        let signal!: AbortSignal;
        withProgress.callsFake(async (options, task) => {
            assert.deepEqual(options, {
                title: 'Cloning Zit repository...',
                location: vscode.ProgressLocation.Notification,
                cancellable: true,
            });
            const result = task(
                { report: this.ctx.sandbox.stub() },
                cancellation.token
            );
            await Promise.resolve();
            cancellation.cancel();
            return result;
        });

        await assert.rejects(
            interaction.runCloneWithProgress(
                operationSignal =>
                    new Promise<void>((_resolve, reject) => {
                        signal = operationSignal;
                        operationSignal.addEventListener('abort', () =>
                            reject(
                                Object.assign(new Error('aborted'), {
                                    name: 'AbortError',
                                    code: 'ABORT_ERR',
                                })
                            )
                        );
                    })
            ),
            (error: unknown) => error instanceof vscode.CancellationError
        );

        assert.equal(signal.aborted, true);
        sinon.assert.calledOnce(withProgress);
    });

    test('Surfaces merge conflict paths', async () => {
        const warning = this.ctx.sandbox.stub(
            window,
            'showWarningMessage'
        ) as sinon.SinonStub;

        await interaction.warnMergeConflicts(['one.txt', 'nested/two.txt']);

        sinon.assert.calledOnceWithExactly(
            warning,
            'Merge conflicts require resolution:\n' +
                ' • one.txt\n' +
                ' • nested/two.txt'
        );
    });

    test('Returns the cloned-repository prompt choice', async () => {
        const info = this.ctx.sandbox.stub(
            window,
            'showInformationMessage'
        ) as sinon.SinonStub;
        info.onFirstCall().resolves('Open Repository');
        info.onSecondCall().resolves(undefined);

        assert.equal(await interaction.promptOpenClonedRepo(), true);
        assert.equal(await interaction.promptOpenClonedRepo(), false);
    });

    test('Accepts anonymous clone credentials', async () => {
        const input = this.ctx.sandbox.stub(window, 'showInputBox');
        input.onFirstCall().resolves('');
        input.onSecondCall().resolves('');

        assert.equal(await interaction.inputCloneUser(), '');
        assert.equal(await interaction.inputClonePassword(), '');
        const userOptions = input.firstCall.args[0];
        assert.ok(userOptions);
        assert.equal(userOptions.prompt, 'Username');
        assert.equal(userOptions.placeHolder, 'None');
        assert.equal(userOptions.ignoreFocusOut, true);
        assert.equal(typeof userOptions.value, 'string');
        assert.deepEqual(input.secondCall.args[0], {
            prompt: 'User Authentication',
            placeHolder: 'Password. Leave empty for none',
            password: true,
            ignoreFocusOut: true,
        });
    });

    test('Accepts authenticated clone credentials', async () => {
        const input = this.ctx.sandbox.stub(window, 'showInputBox');
        input.onFirstCall().resolves('alice');
        input.onSecondCall().resolves('secret');

        assert.equal(await interaction.inputCloneUser(), 'alice');
        assert.equal(await interaction.inputClonePassword(), 'secret');
    });

    test('Cancels clone credential prompts', async () => {
        const input = this.ctx.sandbox
            .stub(window, 'showInputBox')
            .resolves(undefined);

        assert.equal(await interaction.inputCloneUser(), undefined);
        assert.equal(await interaction.inputClonePassword(), undefined);
        sinon.assert.callCount(input, 2);
    });

    test('Builds interactive command prompts from the final output line', async () => {
        const input = this.ctx.sandbox
            .stub(window, 'showInputBox')
            .resolves('answer');

        assert.equal(
            await interaction.inputPrompt(
                'first line\nFinal prompt:' as ZitStdOut,
                ['sync'] as ZitArgsWithOptions
            ),
            'answer'
        );
        sinon.assert.calledOnceWithExactly(input, {
            title: 'Zit: sync',
            prompt: 'Final prompt:',
            ignoreFocusOut: true,
        });
    });

    test('Cancels the open-dialog rename path without a destination', async () => {
        this.ctx.sandbox.stub(window, 'showQuickPick').callsFake(items => {
            assert.ok(items instanceof Array);
            return Promise.resolve(items[0]);
        });
        const open = this.ctx.sandbox
            .stub(window, 'showOpenDialog')
            .resolves(undefined);

        const result = await interaction.selectNewFileLocation(
            Uri.file('/tmp'),
            'old.txt' as RelativePath,
            []
        );

        assert.equal(result, undefined);
        sinon.assert.calledOnce(open);
    });

    test('Describes forgetting one added file while discarding changes', async () => {
        const warning = this.ctx.sandbox.stub(
            window,
            'showWarningMessage'
        ) as sinon.SinonStub;
        warning.resolves('&&Discard Changes');

        assert.equal(
            await interaction.confirmDiscardChanges(
                ['tracked.txt'],
                ['added.txt']
            ),
            true
        );
        assert.match(
            warning.firstCall.args[0],
            /forget added file 'added.txt'/
        );
    });

    test('Offers the Zit log for normalized command failures', async () => {
        const error = this.ctx.sandbox.stub(
            window,
            'showErrorMessage'
        ) as sinon.SinonStub;
        error.onFirstCall().resolves('Open Zit Log');
        error.onSecondCall().resolves(undefined);
        error.onThirdCall().resolves(undefined);
        const stderrFailure = fakeExecutionResult({
            exitCode: 1,
            stderr: 'abort: checkout unavailable\nignored detail\n',
        }) as ExecFailure;
        const messageFailure = Object.assign(
            fakeExecutionResult({ exitCode: 1 }),
            { message: 'spawn unavailable' }
        ) as ExecFailure;
        const genericFailure = Object.assign(
            fakeExecutionResult({ exitCode: 1 }),
            { message: '', toString: () => '' }
        ) as ExecFailure;

        assert.equal(await interaction.errorPromptOpenLog(stderrFailure), true);
        assert.equal(
            await interaction.errorPromptOpenLog(messageFailure),
            false
        );
        assert.equal(
            await interaction.errorPromptOpenLog(genericFailure),
            false
        );
        assert.equal(error.firstCall.args[0], 'Zit: checkout unavailable');
        assert.equal(error.secondCall.args[0], 'Zit: spawn unavailable');
        assert.equal(error.thirdCall.args[0], 'Zit error');
    });

    test('Uses generic interactive prompt titles when argv is empty', async () => {
        const input = this.ctx.sandbox
            .stub(window, 'showInputBox')
            .resolves(undefined);

        await interaction.inputPrompt(
            'Question:' as ZitStdOut,
            [] as unknown as ZitArgsWithOptions
        );

        sinon.assert.calledOnceWithExactly(input, {
            title: 'Zit: command',
            prompt: 'Question:',
            ignoreFocusOut: true,
        });
    });

    test('Validates commit branch names before returning them', async () => {
        const input = this.ctx.sandbox
            .stub(window, 'showInputBox')
            .callsFake(options => {
                assert.equal(
                    options?.validateInput?.('   '),
                    'Branch name is required'
                );
                assert.equal(options?.validateInput?.('feature'), undefined);
                return Promise.resolve('feature');
            });

        assert.deepEqual(await interaction.inputNewBranchOptions(), {
            branch: 'feature',
        });
        sinon.assert.calledOnce(input);
    });

    test('Ignores non-runnable rename and update separators', async () => {
        const pick = this.ctx.sandbox
            .stub(window, 'showQuickPick')
            .callsFake(items => {
                assert.ok(items instanceof Array);
                return Promise.resolve(items[1]);
            });
        const open = this.ctx.sandbox.stub(window, 'showOpenDialog');

        assert.equal(
            await interaction.selectNewFileLocation(
                Uri.file('/tmp'),
                'old.txt' as RelativePath,
                []
            ),
            undefined
        );
        assert.equal(await interaction.pickCheckin([[], []]), undefined);
        sinon.assert.calledTwice(pick);
        sinon.assert.notCalled(open);
    });

    test('Uses a home-directory checkout suggestion without a workspace', async () => {
        const interactionPath = require.resolve('../../interaction');
        const cachedInteraction = require.cache[interactionPath];
        delete require.cache[interactionPath];
        // Dynamic import is required to exercise uncached module initialization.
        const freshInteraction = await import('../../interaction');
        const workspaceFolders = sinon
            .stub(workspace, 'workspaceFolders')
            .get(() => undefined);
        const open = sinon.stub(window, 'showOpenDialog').resolves(undefined);

        try {
            assert.equal(
                await freshInteraction.selectCheckoutDirectory('Open'),
                undefined
            );
            const options = open.firstCall.args[0];
            assert.ok(options);
            assert.ok(options.defaultUri);
            assert.equal(options.openLabel, 'Open');
            assert.equal(options.defaultUri.path.endsWith('/repo_name'), true);
        } finally {
            open.restore();
            workspaceFolders.restore();
            assert.ok(cachedInteraction);
            require.cache[interactionPath] = cachedInteraction;
        }
    });
}

export function utilitiesSuite(this: Suite): void {
    suite('Undo', undoSuite.bind(this));
    suite('Decorators', decoratorsSuite.bind(this));
    suite('Core interaction', coreInteractionSuite.bind(this));
    test('Zit historical URIs retain version and empty-document identity', () => {
        const source = Uri.file('/tmp/history.bin');
        const checkin = 'a'.repeat(64) as ZitHash;
        const historical = toZitUri(source, checkin);
        const empty = toZitEmptyUri(source);

        assert.equal(historical.scheme, 'zit');
        assert.deepEqual(fromZitUri(historical), {
            path: source.fsPath,
            checkin,
        });
        assert.equal(empty.scheme, 'zit');
        assert.deepEqual(fromZitUri(empty), {
            path: source.fsPath,
            empty: true,
        });
        assert.throws(
            () => fromZitUri(Uri.parse('zit:/tmp/history.bin?not-json')),
            SyntaxError
        );
    });
    test('Show output', async () => {
        await vscode.commands.executeCommand('zit.showOutput');
        // currently there is no way to validate zit.showOutput
    });
    test('Commit input box knows which repository to use', () => {
        const repository = getRepository();
        assert.deepStrictEqual(repository.sourceControl.acceptInputCommand, {
            command: 'zit.commitWithInput',
            title: 'Commit',
            arguments: [repository],
        });
    });
}
