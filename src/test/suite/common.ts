import * as assert from 'assert/strict';
import { Uri } from 'vscode';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import * as fs from 'fs';
import {
    ZitExecutable,
    ZitCWD,
    ZitArgs,
    ZitStdErr,
    ZitStdOut,
    ZitExecutablePath,
    ExecResult,
    Reason,
} from '../../zitExecutable';
import { Model } from '../../model';
import { Repository } from '../../repository';
import {
    ZitCommitMessage,
    OpenedRepository,
    RelativePath,
    ResourceStatus,
} from '../../openedRepository';
import { ZitResourceGroup } from '../../resourceGroups';

export type SinonStubT<T extends (...args: any) => any> = sinon.SinonStub<
    Parameters<T>,
    ReturnType<T>
>;

export async function cleanRoot(): Promise<void> {
    assert.ok(
        vscode.workspace.workspaceFolders,
        'Expected opened workspace. Probably setup issue and `out/test/test_repo` does not exist.'
    );
    const rootPath = vscode.workspace.workspaceFolders[0].uri;
    await fs.promises.rm(rootPath.fsPath, {
        force: true,
        recursive: true,
    });
    await fs.promises.mkdir(rootPath.fsPath, { recursive: true });
}

export async function zitInit(): Promise<void> {
    assert.ok(vscode.workspace.workspaceFolders);
    const rootUri = vscode.workspace.workspaceFolders[0].uri;
    const root = rootUri.fsPath as ZitCWD;
    const executable = getExecutable();

    const initialized = await executable.exec(root, [
        'init',
        '--',
        root,
    ] as ZitArgs);
    assert.equal(initialized.exitCode, 0, initialized.stderr);
    assert.ok(fs.existsSync(Uri.joinPath(rootUri, '.zit').fsPath));
    assert.ok(fs.existsSync(Uri.joinPath(rootUri, '.zit-checkout').fsPath));

    const seed = 'vscode-zit-test.txt';
    await fs.promises.writeFile(
        Uri.joinPath(rootUri, seed).fsPath,
        'deterministic Zit integration fixture\n'
    );
    const added = await executable.exec(root, [
        'add',
        '--',
        seed as RelativePath,
    ]);
    assert.equal(added.exitCode, 0, added.stderr);
    const committed = await executable.exec(root, [
        'commit',
        '-m',
        'Initial integration fixture' as ZitCommitMessage,
        '--user',
        'vscode-zit-tests',
        '--no-sync',
        '--',
        seed as RelativePath,
    ] as ZitArgs);
    assert.equal(committed.exitCode, 0, committed.stderr);
}

export async function zitOpen(sandbox: sinon.SinonSandbox): Promise<void> {
    assert.ok(vscode.workspace.workspaceFolders);
    const rootUri = vscode.workspace.workspaceFolders[0].uri;
    sandbox.stub(vscode.window, 'showOpenDialog').resolves([rootUri]);
    await vscode.commands.executeCommand('zit.open');
    assert.equal(getModel().repositories.length, 1);
    sandbox.restore();
}

export function getModel(): Model {
    const extension = vscode.extensions.getExtension('koog1000.zit');
    assert.ok(extension);
    const model = extension.exports as Model;
    assert.ok(model, "extension initialization didn't succeed");
    return model;
}

export function getRepository(): Repository {
    const model = getModel();
    assert.equal(model.repositories.length, 1);
    return model.repositories[0];
}

export function getOpenedRepository(): OpenedRepository {
    const opened = Reflect.get(getRepository(), 'repository') as unknown;
    assert.ok(opened instanceof OpenedRepository);
    return opened;
}

export function getExecutable(): ZitExecutable {
    const model = getModel();
    const executable = model['executable'];
    assert.ok(executable);
    return executable;
}

export type ExecStub = SinonStubT<OpenedRepository['exec']>;
/** Returns calling through `OpenedRepository.exec` stub */
export function getExecStub(sandbox: sinon.SinonSandbox): ExecStub {
    return sandbox.stub(getOpenedRepository(), 'exec').callThrough();
}

type RawExecFunc = ZitExecutable['rawExec'];
type RawExecStub = SinonStubT<RawExecFunc>;
/** Returns calling through `ZitExecutable.rawExec` stub */
export function getRawExecStub(sandbox: sinon.SinonSandbox): RawExecStub {
    const repository = getRepository();
    const executable: ZitExecutable = (repository as any).repository.executable;
    return sandbox.stub(executable, 'rawExec').callThrough();
}

export function fakeExecutionResult({
    stdout,
    stderr,
    args,
    exitCode,
}: {
    stdout?: string;
    stderr?: string;
    args?: ZitArgs;
    exitCode?: number;
} = {}): ExecResult {
    return {
        zitPath: '' as ZitExecutablePath,
        exitCode: exitCode ?? 0,
        stdout: (stdout ?? '') as ZitStdOut,
        stderr: (stderr ?? '') as ZitStdErr,
        args: args ?? ['status'],
        cwd: '' as ZitCWD,
        command: `zit ${(args ?? ['status']).join(' ')}`,
        durationMs: 0,
    } as ExecResult;
}

export function fakeRawExecutionResult({
    stdout,
    stderr,
    args,
    exitCode,
}: {
    stdout?: string;
    stderr?: string;
    args?: ZitArgs;
    exitCode?: 0 | 1;
} = {}): Awaited<ReturnType<RawExecFunc>> {
    return {
        zitPath: '' as ZitExecutablePath,
        exitCode: exitCode ?? 0,
        stdout: Buffer.from(stdout ?? ''),
        stderr: Buffer.from(stderr ?? ''),
        args: args ?? ['status'],
        cwd: '' as ZitCWD,
        command: `zit ${(args ?? ['status']).join(' ')}`,
        durationMs: 0,
    };
}

export function fakeStatusResult(status: string): ExecResult {
    const args: ZitArgs = ['status'];
    const header = 'On branch trunk (check-in ' + '0'.repeat(64) + ')\n';
    return fakeExecutionResult({ stdout: header + status, args });
}

export function fakeZitStatus(
    execStub: ExecStub,
    status: string,
    diff?: string
): ExecStub {
    const lines = status
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
    const tracked = lines.filter(line => !line.startsWith('extra '));
    const extras = lines
        .filter(line => line.startsWith('extra '))
        .map(line => line.slice('extra '.length));
    const brief =
        diff ??
        tracked
            .filter(line => /^(?:added|edited|missing) /.test(line))
            .map(line => {
                const separator = line.indexOf(' ');
                const kind = line.slice(0, separator);
                const filePath = line.slice(separator + 1);
                const marker =
                    kind === 'added' ? 'A' : kind === 'missing' ? 'D' : 'M';
                return `${marker} ${filePath}`;
            })
            .join('\n');

    const statusStub = execStub
        .withArgs(['status'])
        .resolves(fakeStatusResult(tracked.join('\n')));
    execStub.withArgs(['diff', '--brief']).resolves(
        fakeExecutionResult({
            args: ['diff', '--brief'] as ZitArgs,
            stdout: brief ? `${brief.trimEnd()}\n` : '',
        })
    );
    execStub.withArgs(['extras']).resolves(
        fakeExecutionResult({
            args: ['extras'] as ZitArgs,
            stdout: extras.length ? `${extras.join('\n')}\n` : '',
        })
    );
    return statusStub;
}

type Changes = `${number} files modified.` | 'None. Already up-to-date';

export function fakeUpdateResult(
    changes: Changes = 'None. Already up-to-date'
) {
    return fakeExecutionResult({ stdout: `changes: ${changes}\n` });
}

export async function add(
    filename: string,
    content: string,
    commitMessage: string
): Promise<Uri> {
    const repository = getRepository();
    const openedRepository: OpenedRepository = (repository as any).repository;

    const rootUri = vscode.workspace.workspaceFolders![0].uri;
    const fileUri = Uri.joinPath(rootUri, filename);
    const isNewFile = !fs.existsSync(fileUri.fsPath);
    await fs.promises.writeFile(fileUri.fsPath, content);
    if (isNewFile) {
        const addRes = await openedRepository.exec([
            'add',
            '--',
            filename as RelativePath,
        ]);
        assert.equal(addRes.stdout.trimEnd(), `added ${filename}`);
    }
    const commitRes = await openedRepository.exec([
        'commit',
        '-m',
        commitMessage as ZitCommitMessage,
        '--',
        filename as RelativePath,
    ]);
    assert.equal(commitRes.exitCode, 0, 'Commit failed');
    const statusResult = await repository.updateStatus(
        'Test: refresh after add commit' as Reason
    );
    assert.equal(statusResult, undefined);
    return fileUri;
}

export async function cleanupZit(repository: Repository): Promise<void> {
    const openedRepository: OpenedRepository = (repository as any).repository;
    const refreshed = await repository.updateStatus(
        'Test: refresh before cleanupZit' as Reason
    );
    assert.equal(refreshed, undefined);
    const working = repository.workingGroup.resourceStates.map(resource =>
        repository.mapFileUriToRepoRelativePath(resource.resourceUri)
    );
    const added = repository.addedGroup.resourceStates.map(resource =>
        repository.mapFileUriToRepoRelativePath(resource.resourceUri)
    );
    if (
        working.length ||
        added.length ||
        repository.untrackedGroup.resourceStates.length
    ) {
        if (added.length) {
            const forgetRes = await openedRepository.exec([
                'rm',
                '--',
                ...added,
            ]);
            assert.equal(forgetRes.exitCode, 0);
        }
        if (working.length) {
            const revertRes = await openedRepository.exec([
                'revert',
                '--',
                ...working,
            ]);
            assert.equal(revertRes.exitCode, 0);
        }
        const cleanRes1 = await openedRepository.exec(
            ['clean', '--force'],
            'Test: cleanupZit' as Reason
        );
        assert.equal(cleanRes1.exitCode, 0);

        const updateRes = await repository.updateStatus(
            'Test: cleanupZit' as Reason
        );
        assert.equal(updateRes, undefined);
        // if we fail on the next line, it could be that there's fake status
        assertGroups(repository, {}, 'Cleanup failed inside `cleanupZit`');
    } else {
        assertGroups(repository, {}, 'Totally unexpected state');
    }
    for (const group of vscode.window.tabGroups.all) {
        const allClosed = await vscode.window.tabGroups.close(group);
        assert.ok(allClosed);
    }
}

export function assertGroups(
    repository: Repository,
    groups: {
        working?: Readonly<[string, ResourceStatus]>[];
        added?: Readonly<[string, ResourceStatus]>[];
        untracked?: Readonly<[string, ResourceStatus]>[];
    },
    message?: string
): void {
    const group_to_map = (grp: ZitResourceGroup) => {
        return new Map<string, ResourceStatus>(
            grp.resourceStates.map(res => [res.resourceUri.fsPath, res.status])
        );
    };
    assert.deepStrictEqual(
        new Map([
            ['working', group_to_map(repository.workingGroup)],
            ['added', group_to_map(repository.addedGroup)],
            ['untracked', group_to_map(repository.untrackedGroup)],
        ]),
        new Map([
            ['working', new Map(groups.working)],
            ['added', new Map(groups.added)],
            ['untracked', new Map(groups.untracked)],
        ]),
        message
    );
}

export function statusBarCommands() {
    const repository = getRepository();
    const commands = repository.sourceControl.statusBarCommands;
    assert.ok(commands);
    return commands;
}

export function stubZitConfig(sandbox: sinon.SinonSandbox) {
    const configStub = {
        update: sinon.stub(),
        get: sinon.stub(),
    };
    configStub.get.withArgs('username').returns('');
    configStub.get.withArgs('confirmGitExport').returns(null);
    configStub.get.withArgs('enableRenaming').returns(true);
    configStub.get.withArgs('path').returns('');
    configStub.get.withArgs('globalArgs').returns([]);
    configStub.get.withArgs('commitArgs').returns([]);
    configStub.get.withArgs('autoRefresh').returns(false);
    configStub.get.withArgs('defaultUsername').returns('');
    configStub.get.callsFake((...args: any[]) => {
        /* c8 ignore next */
        throw new Error(`get: called with ${JSON.stringify(args)}`);
    });
    configStub.update.callsFake((...args: any[]) => {
        /* c8 ignore next */
        throw new Error(`update: called with ${JSON.stringify(args)}`);
    });

    sandbox
        .stub(vscode.workspace, 'getConfiguration')
        .callThrough()
        .withArgs('zit')
        .returns(configStub as any);
    return configStub;
}
