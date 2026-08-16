import { Suite, suiteTeardown, suiteSetup, test } from 'mocha';
import { commands, window, workspace, Uri } from 'vscode';
import * as assert from 'assert/strict';
import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import type { languages } from 'vscode';
import * as sinon from 'sinon';
import { add, getRepository } from './common';
import type {
    Annotation,
    ZitCommitMessage,
    ZitHash,
    ZitUsername,
    OpenedRepository,
    RelativePath,
} from '../../openedRepository';
import { ZitAnnotator } from '../../praise';
import { revertChanges, type LineChange } from '../../revert';
import { delay } from '../../util';

function AnnotateSuite(this: Suite) {
    test('Annotate ignores absent editors and documents outside repositories', async () => {
        await commands.executeCommand('workbench.action.closePanel');
        await commands.executeCommand('workbench.action.closeAllEditors');
        const registerHoverProvider = this.ctx.sandbox.stub(
            vscode.languages,
            'registerHoverProvider'
        );
        try {
            await commands.executeCommand('zit.annotate');
            const outside = await workspace.openTextDocument({
                content: 'outside repository\n',
            });
            await window.showTextDocument(outside, {
                preserveFocus: false,
                preview: false,
            });
            await commands.executeCommand('zit.annotate');
            sinon.assert.notCalled(registerHoverProvider);
        } finally {
            registerHoverProvider.restore();
            await commands.executeCommand('workbench.action.closeAllEditors');
        }
    });

    suite('Annotate file', () => {
        let registerHoverProviderSpy: sinon.SinonSpy<
            Parameters<typeof languages.registerHoverProvider>
        >;
        let onDidChangeTextDocumentSpy: sinon.SinonSpy<
            Parameters<typeof workspace.onDidChangeTextDocument>
        >;
        let onDidCloseTextDocumentSpy: sinon.SinonSpy<
            Parameters<typeof workspace.onDidCloseTextDocument>
        >;
        let onDidChangeTextEditorSelectionSpy: sinon.SinonSpy<
            Parameters<typeof window.onDidChangeTextEditorSelection>
        >;
        const sandbox = this.ctx.sandbox;
        let path: string;
        let cancellationTokenSource: vscode.CancellationTokenSource;

        suiteSetup(async () => {
            this.timeout(30000); // sometimes io is unpredictable)
            cancellationTokenSource = new vscode.CancellationTokenSource();
            const uri = Uri.joinPath(this.ctx.workspaceUri, 'annotate.txt');
            path = uri.fsPath;
            const relativePath = 'annotate.txt' as RelativePath;
            await fs.writeFile(path, [...'first', ''].join('\n'));
            const repository = getRepository();
            const repositoryAccess = repository as unknown as {
                repository: OpenedRepository;
            };
            const openedRepository = repositoryAccess.repository;
            const ci = (n: number) =>
                openedRepository.exec([
                    'commit',
                    '--user',
                    `u${n}` as ZitUsername,
                    '-m',
                    `annotate ${n}` as ZitCommitMessage,
                    '--',
                    relativePath,
                ]);
            await openedRepository.exec(['add', '--', relativePath]);
            await ci(1);
            await fs.appendFile(path, [...'second', ''].join('\n'));
            await ci(2);
            await fs.appendFile(path, [...'third', ''].join('\n'));
            await ci(3);
            await fs.appendFile(path, [...'user', ''].join('\n'));
            await repository.updateStatus();

            await commands.executeCommand('workbench.action.closePanel');
            const document = await workspace.openTextDocument(uri);
            const editor = await window.showTextDocument(document, {
                preserveFocus: false,
                preview: false,
            });
            assert.equal(editor.document.uri.fsPath, path);
            assert.equal(window.activeTextEditor?.document.uri.fsPath, path);

            onDidChangeTextDocumentSpy = sandbox.spy(
                vscode.workspace,
                'onDidChangeTextDocument'
            );
            onDidCloseTextDocumentSpy = sandbox.spy(
                vscode.workspace,
                'onDidCloseTextDocument'
            );
            registerHoverProviderSpy = sandbox.spy(
                vscode.languages,
                'registerHoverProvider'
            );
            onDidChangeTextEditorSelectionSpy = sandbox.spy(
                vscode.window,
                'onDidChangeTextEditorSelection'
            );
        });

        suiteTeardown(async () => {
            cancellationTokenSource.dispose();
            if (window.activeTextEditor?.document.uri.fsPath == path) {
                await commands.executeCommand(
                    'workbench.action.closeActiveEditor'
                );
            }
            const swm: sinon.SinonStub = this.ctx.sandbox.stub(
                window,
                'showWarningMessage'
            );
            swm.onFirstCall().resolves('&&Discard Changes');

            const repository = getRepository();
            await commands.executeCommand(
                'zit.revertAll',
                repository.workingGroup
            );
            sinon.assert.calledOnce(swm);
        });

        test('First time', async () => {
            assert.equal(window.activeTextEditor?.document.uri.fsPath, path);
            await commands.executeCommand('zit.annotate');
            sinon.assert.calledOnce(registerHoverProviderSpy);
            sinon.assert.calledOnce(onDidChangeTextDocumentSpy);
            sinon.assert.calledOnce(onDidCloseTextDocumentSpy);
            sinon.assert.calledOnce(onDidChangeTextEditorSelectionSpy);
        });

        test('Second time', async () => {
            const registerHoverProviderSpy = this.ctx.sandbox.spy(
                vscode.languages,
                'registerHoverProvider'
            );
            assert.equal(window.activeTextEditor?.document.uri.fsPath, path);
            await commands.executeCommand('zit.annotate');
            sinon.assert.notCalled(registerHoverProviderSpy);
        });

        test('Hover full text', async () => {
            assert.ok(window.activeTextEditor);
            const hover =
                await registerHoverProviderSpy.firstCall.args[1].provideHover(
                    window.activeTextEditor.document,
                    new vscode.Position(1, 1),
                    cancellationTokenSource.token
                );
            assert.ok(hover);
            assert.ok(hover.contents[0] instanceof vscode.MarkdownString);
            assert.match(hover.contents[0].value, /^\*\*annotate 1\*\*/);
            assert.match(hover.contents[0].value, /\* user: \*\*u1\*\*/);
            assert.match(
                hover.contents[0].value,
                /\* checkin: \*\*[0-9a-f]+\*\*/
            );
        });

        test('Hover for another document', async () => {
            assert.ok(window.activeTextEditor);
            const hover =
                await registerHoverProviderSpy.firstCall.args[1].provideHover(
                    undefined as unknown as vscode.TextDocument,
                    undefined as unknown as vscode.Position,
                    cancellationTokenSource.token
                );
            assert.strictEqual(hover, undefined);
        });

        test('Hover user line', async () => {
            assert.ok(window.activeTextEditor);
            const hover =
                await registerHoverProviderSpy.firstCall.args[1].provideHover(
                    window.activeTextEditor.document,
                    new vscode.Position(100, 1),
                    cancellationTokenSource.token
                );
            assert.ok(hover);
            assert.ok(hover.contents[0] instanceof vscode.MarkdownString);
            assert.equal(hover.contents[0].value, 'local change');
        });

        test('Close text document event', async () => {
            const args = onDidCloseTextDocumentSpy.firstCall.args;
            const close = args[0].bind(args[1]);
            close({} as vscode.TextDocument);
            assert.ok(window.activeTextEditor);
            close(window.activeTextEditor.document);
        });

        test('Change text document event', async () => {
            const args = onDidChangeTextDocumentSpy.firstCall.args;
            const change = args[0].bind(args[1]);
            change({
                document: {} as vscode.TextDocument,
                contentChanges: [],
                reason: undefined,
            });
            assert.ok(window.activeTextEditor);
            change({
                document: window.activeTextEditor.document,
                contentChanges: [],
                reason: undefined,
            });
        });

        test('Change text document event', async () => {
            const args = onDidChangeTextEditorSelectionSpy.firstCall.args;
            const change = args[0].bind(args[1]);
            change({
                kind: undefined,
                selections: [],
                textEditor: undefined as unknown as vscode.TextEditor,
            });
            assert.ok(window.activeTextEditor);
            // setDecorations cannot be watched, so this is a code coverage test
            change({
                kind: undefined,
                selections: [
                    new vscode.Selection(
                        new vscode.Position(1, 1),
                        new vscode.Position(1, 1)
                    ),
                ],
                textEditor: window.activeTextEditor,
            });
        });
        test('Renders consecutive local annotation rows', () => {
            const editor = window.activeTextEditor;
            assert.ok(editor);
            const repository = getRepository();
            const annotations: Annotation[] = [
                ['' as ZitHash, '', '' as ZitUsername],
                ['' as ZitHash, '', '' as ZitUsername],
            ];
            ZitAnnotator.create(repository, editor, annotations);
            assert.equal(ZitAnnotator.tryDelete(editor), true);
        });
    });
}

function RevertChangeSuite(this: Suite) {
    test('Revert single change', async () => {
        const rootUri = this.ctx.workspaceUri;
        const filename = 'revert_change.txt';
        const uriToChange = Uri.joinPath(rootUri, filename);
        await commands.executeCommand('zit.revertChange', uriToChange); // branch coverage

        const content = [...'abcdefghijklmnopqrstuvwxyz'].join('\n');
        await add(filename, content, `add '${filename}'`);
        const content2 = [
            'top',
            ...'abcdeghijklmn',
            'typo',
            ...'opqrstuvwxyz',
        ].join('\n');
        await fs.writeFile(uriToChange.fsPath, content2);

        const document = await workspace.openTextDocument(uriToChange);
        await window.showTextDocument(document);

        // to fill this array, debug `zit.revertChange`
        const changes: LineChange[] = [
            {
                originalStartLineNumber: 0,
                originalEndLineNumber: 0,
                modifiedStartLineNumber: 1,
                modifiedEndLineNumber: 1,
            },
            {
                originalStartLineNumber: 6,
                originalEndLineNumber: 6,
                modifiedStartLineNumber: 6,
                modifiedEndLineNumber: 0,
            },
            {
                originalStartLineNumber: 14,
                originalEndLineNumber: 0,
                modifiedStartLineNumber: 15,
                modifiedEndLineNumber: 15,
            },
        ];
        await delay(150);
        await commands.executeCommand(
            'zit.revertChange',
            uriToChange,
            changes,
            2
        );
        assert.equal(
            document.getText(),
            ['top', ...'abcdeghijklmnopqrstuvwxyz'].join('\n'),
            'undo 1'
        );
        await delay(150);
        await commands.executeCommand(
            'zit.revertChange',
            uriToChange,
            changes.slice(0, 2),
            1
        );
        assert.equal(
            document.getText(),
            ['top', ...'abcdefghijklmnopqrstuvwxyz'].join('\n'),
            'undo 2'
        );
        await delay(150);
        await commands.executeCommand(
            'zit.revertChange',
            uriToChange,
            changes.slice(0, 1),
            0
        );
        assert.equal(document.getText(), content, 'undo 3');
        await document.save();
    }).timeout(11000);

    test('Revert nothing', async () => {
        await commands.executeCommand('zit.revertChange');
    });

    test('Ignores range reverts for non-file documents', async () => {
        const open = this.ctx.sandbox.stub(workspace, 'openTextDocument');
        const editor = {
            document: { uri: Uri.parse('untitled:coverage') },
        } as unknown as vscode.TextEditor;

        await revertChanges(editor, []);

        sinon.assert.notCalled(open);
    });

    test('Handles insertions and deletions at the final line', async () => {
        const lineAt = (line: number) => ({
            range: { end: new vscode.Position(line, 1) },
        });
        const original = {
            uri: Uri.file('/tmp/revert-original.txt'),
            lineCount: 3,
            lineAt,
            getText: () => '',
        } as unknown as vscode.TextDocument;
        const modified = {
            uri: Uri.file('/tmp/revert-modified.txt'),
            lineCount: 4,
            lineAt,
            getText: () => '',
        } as unknown as vscode.TextDocument;
        const visibleRange = new vscode.Range(0, 0, 0, 1);
        const revealRange = this.ctx.sandbox.stub();
        const editor = {
            document: modified,
            visibleRanges: [visibleRange],
            revealRange,
        } as unknown as vscode.TextEditor;
        this.ctx.sandbox.stub(workspace, 'openTextDocument').resolves(original);
        const apply = this.ctx.sandbox
            .stub(workspace, 'applyEdit')
            .resolves(true);

        await revertChanges(editor, [
            {
                originalStartLineNumber: 3,
                originalEndLineNumber: 3,
                modifiedStartLineNumber: 3,
                modifiedEndLineNumber: 0,
            },
            {
                originalStartLineNumber: 3,
                originalEndLineNumber: 0,
                modifiedStartLineNumber: 4,
                modifiedEndLineNumber: 4,
            },
        ]);

        sinon.assert.calledOnce(apply);
        sinon.assert.calledOnceWithExactly(revealRange, visibleRange);
    });
}

export function QualityOfLifeSuite(this: Suite): void {
    suite('Annotate', AnnotateSuite);
    suite('Revert change', RevertChangeSuite);
}
