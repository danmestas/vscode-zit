import {
    CancellationToken,
    DecorationRangeBehavior,
    Disposable,
    Hover,
    languages,
    MarkdownString,
    Position,
    Range,
    TextDocument,
    TextDocumentChangeEvent,
    TextEditor,
    TextEditorSelectionChangeEvent,
    ThemableDecorationAttachmentRenderOptions,
    ThemeColor,
    window,
    workspace,
} from 'vscode';
import type { Annotation, ZitHash } from './openedRepository';
import type { Repository } from './repository';

const annotationDecoration = window.createTextEditorDecorationType({
    rangeBehavior: DecorationRangeBehavior.ClosedOpen,
    before: {
        borderColor: new ThemeColor('focusBorder'),
        height: '100%',
        margin: '0 26px -1px 0',
        fontWeight: 'normal',
        fontStyle: 'normal',
        backgroundColor: 'rgba(255, 255, 255, 0.07)',
        color: new ThemeColor('editor.foreground'),
    },
    light: {
        before: {
            backgroundColor: 'rgba(0, 0, 0, 0.07)',
        },
    },
});

const annotationHighlight = window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(128, 255, 255, 0.07)',
    light: {
        backgroundColor: 'rgba(0, 128, 128, 0.07)',
    },
});

export class ZitAnnotator {
    private static editors = new WeakMap<TextEditor, ZitAnnotator>();
    private readonly disposable: Disposable;
    private readonly document: TextDocument;
    private readonly hoverProvider: Disposable;
    private constructor(
        private readonly repository: Repository,
        private readonly editor: TextEditor,
        private readonly hashes: ZitHash[]
    ) {
        this.document = editor.document;
        this.disposable = Disposable.from(
            window.onDidChangeTextEditorSelection(
                this.onTextEditorSelectionChanged,
                this
            ),
            workspace.onDidCloseTextDocument(this.onDidCloseTextDocument, this),
            workspace.onDidChangeTextDocument(this.onTextDocumentChanged, this)
        );
        this.hoverProvider = languages.registerHoverProvider(
            { pattern: this.document.uri.fsPath },
            { provideHover: this.onHover.bind(this) }
        );
    }
    static create(
        repository: Repository,
        editor: TextEditor,
        annotations: Annotation[]
    ): ZitAnnotator {
        let previousHash: ZitHash | undefined;
        const nbsp = ' ';
        const decorations = annotations.map((annotation, lineNo) => {
            const range = editor.document.validateRange(
                new Range(lineNo, 0, lineNo, 0)
            );
            let before: ThemableDecorationAttachmentRenderOptions;
            const common = {
                borderStyle: 'solid',
                borderWidth: '0 2px 0 0',
            };
            if (previousHash == annotation[0]) {
                before = {
                    contentText: nbsp,
                    textDecoration: 'none;padding: 0 33ch 0 0',
                    ...common,
                };
            } else {
                previousHash = annotation[0];
                // total width: 8(hash) + 1 + 10(date) + 1 + 13 = 33
                const checkin = annotation[0].slice(0, 8) || nbsp.repeat(8);
                const date = annotation[1] || nbsp.repeat(10);
                const username = annotation[2].slice(-13);
                const contentText = `${checkin} ${date}${nbsp.repeat(
                    14 - username.length
                )}${username}`;
                before = {
                    contentText,
                    textDecoration: 'none;padding: 0 1ch 0 0',
                    ...common,
                };
            }
            if (!annotation[0]) {
                before.backgroundColor = 'rgba(53, 255, 28, 0.07)';
            }
            return { renderOptions: { before }, range };
        });
        editor.setDecorations(annotationDecoration, decorations);
        const hashes = annotations.map(annotation => annotation[0]);
        const annotator = new ZitAnnotator(repository, editor, hashes);
        ZitAnnotator.editors.set(editor, annotator);
        return annotator;
    }

    static tryDelete(editor: TextEditor): boolean {
        const annotator = ZitAnnotator.editors.get(editor);
        annotator?.dispose();
        return annotator !== undefined;
    }

    private onTextEditorSelectionChanged(
        event: TextEditorSelectionChangeEvent
    ): void {
        if (event.textEditor === this.editor) {
            const ranges: Range[] = [];
            const line = event.selections[0].active.line;
            const curHash = this.hashes[line];
            this.hashes.map((hash, lineNo) => {
                if (hash === curHash) {
                    ranges.push(new Range(lineNo, 0, lineNo, 0));
                }
            });
            event.textEditor.setDecorations(annotationHighlight, ranges);
        }
    }

    private onDidCloseTextDocument(document: TextDocument) {
        // this event can be delayed, but I believe
        // this is the right place to cleanup
        if (document === this.document) {
            this.dispose();
        }
    }

    private onTextDocumentChanged(event: TextDocumentChangeEvent) {
        if (event.document === this.document) {
            this.dispose();
        }
    }

    private async onHover(
        document: TextDocument,
        position: Position,
        _token: CancellationToken
    ): Promise<Hover | undefined> {
        if (document !== this.editor.document) {
            return undefined;
        }
        const checkin = this.hashes[position.line];
        if (!checkin) {
            return new Hover(new MarkdownString('local change'));
        }
        const info = await this.repository.info(checkin);
        const infoString =
            `**${info.comment}**\n\n` +
            Object.entries(info)
                .map(([key, value]) =>
                    key == 'comment' ? '' : `* ${key}: **${value}**\n`
                )
                .join('');
        return new Hover(new MarkdownString(infoString, true));
    }

    dispose(): void {
        ZitAnnotator.editors.delete(this.editor);
        this.editor.setDecorations(annotationDecoration, []);
        this.editor.setDecorations(annotationHighlight, []);
        this.disposable.dispose();
        this.hoverProvider.dispose();
    }
}
