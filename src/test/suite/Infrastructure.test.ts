import * as assert from 'assert/strict';
import * as cp from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as typedConfigModule from '../../config';
import * as sinon from 'sinon';
import { LogOutputChannel } from 'vscode';
import { Old, ageFromNow } from '../../humanise';
import { ThrottlingQueue } from '../../throttlingQueue';
import * as interaction from '../../interaction';
import {
    ExecFailure,
    Reason,
    RawExecResult,
    ZitCWD,
    ZitExecutable,
    ZitExecutablePath,
    ZitStdErr,
    ZitStdOut,
    ZitVersion,
    toString as execFailureToString,
} from '../../zitExecutable';

function outputChannel(): LogOutputChannel {
    return {
        info: sinon.stub(),
        warn: sinon.stub(),
        error: sinon.stub(),
        show: sinon.stub(),
    } as unknown as LogOutputChannel;
}

function childProcess(options: {
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    error?: NodeJS.ErrnoException;
    closeDelayMs?: number;
}) {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr,
        stdin,
    }) as unknown as cp.ChildProcessWithoutNullStreams;
    process.nextTick(() => {
        if (options.stdout) {
            stdout.write(options.stdout);
        }
        if (options.stderr) {
            stderr.write(options.stderr);
        }
        stdout.end();
        stderr.end();
        if (options.error) {
            child.emit('error', options.error);
        }
        const close = () =>
            child.emit(
                'close',
                options.exitCode !== undefined
                    ? options.exitCode
                    : options.error
                      ? -2
                      : 0
            );
        if (options.closeDelayMs) {
            setTimeout(close, options.closeDelayMs);
        } else {
            close();
        }
    });
    return child;
}

suite('Infrastructure', () => {
    const sandbox = sinon.createSandbox();

    teardown(() => sandbox.restore());

    function executable(): ZitExecutable {
        const executable = new ZitExecutable(outputChannel());
        executable.setInfo({
            path: '/bin/zit' as ZitExecutablePath,
            version: [0, 1, 3] as ZitVersion,
        });
        return executable;
    }

    test('raw execution records output, duration, and redacted command metadata', async () => {
        const spawn = sandbox
            .stub(cp, 'spawn')
            .returns(
                childProcess({ stdout: 'ok\n', stderr: 'note\n', exitCode: 0 })
            );
        const controller = new AbortController();
        const args = [
            'push',
            'https://user:secret@example.test/repository',
            '--password',
            'secret',
            '--password=inline-secret',
            '--password',
        ];

        const result = await executable().rawExec(args, {
            cwd: '/tmp' as ZitCWD,
            signal: controller.signal,
        });

        assert.deepEqual(spawn.firstCall.args[1], args);
        assert.equal(spawn.firstCall.args[2].signal, controller.signal);
        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout.toString(), 'ok\n');
        assert.equal(result.stderr.toString(), 'note\n');
        assert.deepEqual(result.args, [
            'push',
            'https://user:*********@example.test/repository',
            '--password',
            '*********',
            '--password=*********',
            '--password',
        ]);
        assert.doesNotMatch(result.command, /secret/);
        assert.ok(result.durationMs >= 0);
        assert.equal(result.spawnFailure, undefined);
    });

    test('spawn failures use the normalized process result', async () => {
        const error = Object.assign(new Error('spawn zit ENOENT'), {
            name: 'Error',
            code: 'ENOENT',
        });
        sandbox.stub(cp, 'spawn').returns(childProcess({ error }));

        const result = await executable().rawExec(['status'], {
            cwd: '/tmp' as ZitCWD,
        });

        assert.equal(result.exitCode, 1);
        assert.deepEqual(result.spawnFailure, {
            name: 'Error',
            message: 'spawn zit ENOENT',
            code: 'ENOENT',
        });
        assert.equal(result.stdout.length, 0);
        assert.equal(result.stderr.length, 0);
    });

    test('cancellation propagates instead of becoming an operational failure', async () => {
        const error = Object.assign(new Error('The operation was aborted'), {
            name: 'AbortError',
            code: 'ABORT_ERR',
        });
        const spawn = sandbox
            .stub(cp, 'spawn')
            .returns(childProcess({ error }));
        const controller = new AbortController();

        await assert.rejects(
            executable().rawExec(['status'], {
                cwd: '/tmp' as ZitCWD,
                signal: controller.signal,
            }),
            (caught: Error & { code?: string }) =>
                caught.name === 'AbortError' && caught.code === 'ABORT_ERR'
        );
        assert.equal(spawn.firstCall.args[2]?.signal, controller.signal);
    });

    test('synchronous spawn failures and code-only cancellation preserve their semantics', async () => {
        const spawn = sandbox.stub(cp, 'spawn');
        spawn.onFirstCall().throws(new Error('spawn failed'));

        const failed = await executable().rawExec(['status'], {
            cwd: '/tmp' as ZitCWD,
        });
        assert.equal(failed.exitCode, 1);
        assert.deepEqual(failed.spawnFailure, {
            name: 'Error',
            message: 'spawn failed',
        });

        const cancellation = Object.assign(new Error('aborted'), {
            code: 'ABORT_ERR',
        });
        spawn.onSecondCall().throws(cancellation);
        await assert.rejects(
            executable().rawExec(['status'], {
                cwd: '/tmp' as ZitCWD,
            }),
            cancellation
        );
    });

    test('raw execution normalizes usage and signal exits and supplies stdin', async () => {
        let stdinEnd!: sinon.SinonSpy;
        const spawn = sandbox.stub(cp, 'spawn');
        spawn.onFirstCall().callsFake(() => childProcess({ exitCode: 2 }));
        spawn.onSecondCall().callsFake(() => {
            const child = childProcess({ exitCode: null });
            stdinEnd = sandbox.spy(child.stdin, 'end');
            return child;
        });

        assert.equal(
            (
                await executable().rawExec(['status', '--bad'], {
                    cwd: '/tmp' as ZitCWD,
                })
            ).exitCode,
            2
        );
        assert.equal(
            (
                await executable().rawExec(['commit'], {
                    cwd: '/tmp' as ZitCWD,
                    stdin_data: 'commit input',
                })
            ).exitCode,
            1
        );
        sinon.assert.calledOnce(stdinEnd);
        assert.equal(stdinEnd.firstCall.args[0], 'commit input');
        assert.equal('stdin_data' in spawn.secondCall.args[2], false);
        assert.equal('logErrors' in spawn.secondCall.args[2], false);
    });

    test('interactive output prompts and writes the response', async () => {
        const clock = sandbox.useFakeTimers();
        const child = childProcess({
            stdout: 'Password: ',
            closeDelayMs: 75,
        });
        const stdinWrite = sandbox.spy(child.stdin, 'write');
        const spawn = sandbox.stub(cp, 'spawn').returns(child);
        const inputPrompt = sandbox
            .stub(interaction, 'inputPrompt')
            .resolves('response');

        const pending = executable().rawExec(['push'], {
            cwd: '/tmp' as ZitCWD,
        });
        await clock.tickAsync(51);
        sinon.assert.calledOnceWithExactly(
            inputPrompt,
            'Password: ' as ZitStdOut,
            ['push']
        );
        sinon.assert.calledOnce(stdinWrite);
        assert.equal(stdinWrite.firstCall.args[0], 'response\n');
        await clock.tickAsync(24);
        assert.equal((await pending).exitCode, 0);

        inputPrompt.resetHistory();
        spawn.returns(
            childProcess({
                stdout: 'still working\n',
                closeDelayMs: 75,
            })
        );
        const nonPrompting = executable().rawExec(['push'], {
            cwd: '/tmp' as ZitCWD,
        });
        await clock.tickAsync(75);
        assert.equal((await nonPrompting).exitCode, 0);
        sinon.assert.notCalled(inputPrompt);
    });

    test('global args follow the verb and preserve caller metadata', async () => {
        const clock = sandbox.useFakeTimers();
        sandbox
            .stub(typedConfigModule.default, 'globalArgs')
            .get(() => ['--quiet']);
        const zit = executable();
        let finish!: (result: RawExecResult) => void;
        const rawExec = sandbox.stub(zit, 'rawExec').returns(
            new Promise<RawExecResult>(resolve => {
                finish = resolve;
            })
        );
        const reason = 'coverage' as Reason;

        const pending = zit.exec('/tmp' as ZitCWD, ['diff', '--brief'], reason);
        await clock.tickAsync(500);
        sinon.assert.calledOnceWithExactly(
            zit.outputChannel.info as sinon.SinonStub,
            'zit diff --brief: still running // coverage'
        );
        assert.deepEqual(rawExec.firstCall.args[0], [
            'diff',
            '--quiet',
            '--brief',
        ]);

        finish({
            zitPath: '/bin/zit' as ZitExecutablePath,
            exitCode: 0,
            stdout: Buffer.from('ok\n'),
            stderr: Buffer.alloc(0),
            args: ['diff', '--quiet', '--brief'],
            cwd: '/tmp' as ZitCWD,
            command: '/bin/zit diff --quiet --brief',
            durationMs: 1,
        });
        assert.equal((await pending).exitCode, 0);
        sinon.assert.calledWithExactly(
            zit.outputChannel.info as sinon.SinonStub,
            'zit diff --brief: 1ms // coverage'
        );
    });

    test('usage failures preserve exit code 2 and actionable stderr', async () => {
        const zit = executable();
        sandbox.stub(zit, 'rawExec').resolves({
            zitPath: '/bin/zit' as ZitExecutablePath,
            exitCode: 2,
            stdout: Buffer.alloc(0),
            stderr: Buffer.from('zit status: unknown option --bad\n'),
            args: ['status', '--bad'],
            cwd: '/tmp' as ZitCWD,
            command: '/bin/zit status --bad',
            durationMs: 2,
        });

        const result = await zit.exec(
            '/tmp' as ZitCWD,
            ['status', '--bad'],
            undefined,
            { logErrors: false }
        );

        assert.equal(result.exitCode, 2);
        assert.equal(result.stderr, 'zit status: unknown option --bad\n');
        assert.equal((result as ExecFailure).message, 'Failed to execute zit');
    });

    test('operational failures log diagnostics and honor opening the output', async () => {
        const zit = executable();
        const rawExec = sandbox.stub(zit, 'rawExec');
        const base = {
            zitPath: '/bin/zit' as ZitExecutablePath,
            exitCode: 1 as const,
            stdout: Buffer.alloc(0),
            args: ['status'],
            cwd: '/tmp' as ZitCWD,
            command: '/bin/zit status',
            durationMs: 1,
        };
        rawExec.onFirstCall().resolves({
            ...base,
            stderr: Buffer.from('operational failure\n'),
        });
        rawExec.onSecondCall().resolves({
            ...base,
            stderr: Buffer.alloc(0),
            spawnFailure: {
                name: 'Error',
                message: 'spawn failure',
            },
        });
        rawExec.onThirdCall().resolves({
            ...base,
            stderr: Buffer.alloc(0),
        });
        const errorPrompt = sandbox.stub(interaction, 'errorPromptOpenLog');
        errorPrompt.onFirstCall().resolves(true);

        await zit.exec('/tmp' as ZitCWD, ['status']);
        await zit.exec('/tmp' as ZitCWD, ['status']);
        await zit.exec('/tmp' as ZitCWD, ['status']);

        sinon.assert.calledWithExactly(
            zit.outputChannel.error as sinon.SinonStub,
            '(/bin/zit status): operational failure\n'
        );
        sinon.assert.calledWithExactly(
            zit.outputChannel.error as sinon.SinonStub,
            '(/bin/zit status): spawn failure'
        );
        sinon.assert.calledOnce(zit.outputChannel.show as sinon.SinonStub);
        sinon.assert.callCount(errorPrompt, 3);
    });

    test('error toString includes normalized process details', () => {
        const failure = {
            stdout: 'my stdout' as ZitStdOut,
            stderr: 'my stderr' as ZitStdErr,
            exitCode: 1,
            args: ['status'],
            cwd: '/tmp' as ZitCWD,
            zitPath: '/bin/zit' as ZitExecutablePath,
            command: '/bin/zit status',
            durationMs: 1,
            message: 'my message',
            toString: execFailureToString,
        } as ExecFailure;
        assert.match(failure.toString(), /^my message \{/);
        assert.match(failure.toString(), /"command": "\/bin\/zit status"/);
        assert.doesNotMatch(failure.toString(), /"toString"/);
    });

    suite('ageFromNow', function () {
        const N = 1686899727000;
        const minutes = (n: number) => new Date(N + n * 60000);
        const days = (n: number) => minutes(n * 24 * 60);
        let fakeTimers: sinon.SinonFakeTimers;

        suiteSetup(() => {
            fakeTimers = sinon.useFakeTimers(N);
        });
        suiteTeardown(() => fakeTimers.restore());
        test('Now', () => assert.equal(ageFromNow(new Date()), 'now'));
        test('Now - 12 seconds', () =>
            assert.equal(ageFromNow(minutes(-0.2)), 'a few moments ago'));
        test('Now - 30 seconds', () =>
            assert.equal(ageFromNow(minutes(-0.5)), '30 seconds ago'));
        test('Now - 1 minute', () =>
            assert.equal(ageFromNow(minutes(-1)), '60 seconds ago'));
        test('Now - 2 minutes', () =>
            assert.equal(ageFromNow(minutes(-2)), '2 minutes ago'));
        test('Now - 10 minute', () =>
            assert.equal(ageFromNow(minutes(-10)), '10 minutes ago'));
        test('Now - 1 hour', () =>
            assert.equal(ageFromNow(minutes(-60)), '1 hour ago'));
        test('Now - 23.5 hour', () =>
            assert.equal(ageFromNow(minutes(-23.5 * 60)), 'yesterday'));
        test('Now - 1 day', () =>
            assert.equal(ageFromNow(days(-1)), 'yesterday'));
        test('Now - 2 days', () =>
            assert.equal(ageFromNow(days(-2)), '2 days ago'));
        test('Now - 3 days', () =>
            assert.equal(ageFromNow(days(-3)), '3 days ago'));
        test('Now - 6 days', () =>
            assert.equal(ageFromNow(days(-6)), 'last week'));
        test('Now - 7 days', () =>
            assert.equal(ageFromNow(days(-7)), '6/9/2023'));
        test('Long ago is empty string', () =>
            assert.equal(ageFromNow(days(-30), Old.EMPTY_STRING), ''));
        test('Now + 1 minute', () =>
            assert.equal(ageFromNow(minutes(1)), 'future (1 minute)'));
        test('Now + 1 day', () =>
            assert.equal(ageFromNow(days(1)), 'future (24 hours)'));
        test('Now + 7 days', () =>
            assert.equal(ageFromNow(days(7)), 'future (7 days)'));
        test('Now + one year', () =>
            assert.equal(ageFromNow(days(366)), 'future (366 days)'));
    });

    test('Queue next logic', async () => {
        const queue = new ThrottlingQueue();
        const p1 = queue.enqueue(() => Promise.resolve(1), 'p');
        const p2 = queue.enqueue(() => Promise.resolve(2), 'p');
        const p3 = queue.enqueue(() => Promise.resolve(3), 'p');
        assert.deepEqual(await Promise.allSettled([p1, p2, p3]), [
            { status: 'fulfilled', value: 1 },
            { status: 'fulfilled', value: 2 },
            { status: 'fulfilled', value: 2 },
        ]);
    });

    test('Queue can handle exceptions', async () => {
        const error = new Error();
        const queue = new ThrottlingQueue();
        const result = await Promise.allSettled([
            queue.enqueue(() => Promise.reject(error), 'p'),
        ]);
        assert.deepEqual(result, [{ status: 'rejected', reason: error }]);
    });
});
