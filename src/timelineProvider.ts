import * as path from 'path';
import {
    Disposable,
    Event,
    EventEmitter,
    MarkdownString,
    ThemeIcon,
    TreeDataProvider,
    TreeItem,
    TreeItemCollapsibleState,
    TreeView,
    Uri,
    window,
} from 'vscode';
import * as humanise from './humanise';
import { fromZitUri } from './uri';
import { Commit, MAX_HISTORY_ENTRIES } from './openedRepository';
import type { Model } from './model';
import type { Repository } from './repository';

const PAGE_SIZE = 50;
const SHORT_HASH_LENGTH = 12;

export type ZitTimelineItem =
    | TimelineCommitItem
    | TimelineRepositoryItem
    | TimelineLoadMoreItem
    | TimelineMessageItem;

class TimelineCommitItem extends TreeItem {
    constructor(
        repository: Repository,
        commit: Commit,
        fileUri: Uri | undefined
    ) {
        super(commit.message);
        const hash = commit.hash.slice(0, SHORT_HASH_LENGTH);
        this.id = `${repository.root}:${fileUri?.path ?? ''}:${commit.hash}`;
        this.description = `${commit.branch} • ${commit.author} • ${hash} • ${humanise.ageFromNow(commit.date)}`;
        this.iconPath = new ThemeIcon('git-commit');
        this.contextValue = 'zitTimelineCommit';
        this.command = {
            command: 'zit.timelineOpen',
            title: 'Open Commit',
            arguments: [repository, commit, fileUri],
        };

        const tooltip = new MarkdownString(undefined, true);
        tooltip.appendText(commit.message);
        tooltip.appendMarkdown('\n\n');
        tooltip.appendText(
            `${commit.branch} • ${commit.author} • ${hash} • ${commit.date.toLocaleString()}`
        );
        this.tooltip = tooltip;
    }
}

class TimelineRepositoryItem extends TreeItem {
    constructor(readonly repository: Repository) {
        super(
            path.basename(repository.root),
            TreeItemCollapsibleState.Expanded
        );
        this.id = repository.root;
        this.description = repository.root;
        this.iconPath = new ThemeIcon('repo');
        this.contextValue = 'zitTimelineRepository';
    }
}

class TimelineLoadMoreItem extends TreeItem {
    constructor(repository: Repository) {
        super('Load more');
        this.id = `${repository.root}:load-more`;
        this.iconPath = new ThemeIcon('ellipsis');
        this.command = {
            command: 'zit.timelineLoadMore',
            title: 'Load More',
            arguments: [repository],
        };
    }
}

class TimelineMessageItem extends TreeItem {
    constructor(message: string) {
        super(message);
        this.iconPath = new ThemeIcon('history');
    }
}

export class ZitTimelineProvider
    implements TreeDataProvider<ZitTimelineItem>, Disposable
{
    private readonly _onDidChangeTreeData = new EventEmitter<
        ZitTimelineItem | undefined
    >();
    readonly onDidChangeTreeData: Event<ZitTimelineItem | undefined> =
        this._onDidChangeTreeData.event;

    private readonly disposables: Disposable[] = [];
    private readonly limits = new Map<string, number>();
    private fileUri: Uri | undefined;
    private view: TreeView<ZitTimelineItem> | undefined;

    constructor(private readonly model: Model) {
        this.disposables.push(
            model.onDidOpenRepository(this.onRepositoryChanged, this),
            model.onDidCloseRepository(this.onRepositoryChanged, this),
            model.onDidChangeRepository(this.onRepositoryChanged, this),
            window.onDidChangeActiveTextEditor(editor =>
                this.onActiveEditorChanged(editor?.document.uri)
            )
        );

        this.onActiveEditorChanged(window.activeTextEditor?.document.uri);
    }

    setView(view: TreeView<ZitTimelineItem>): void {
        this.view = view;
        this.updateDescription();
    }

    getTreeItem(element: ZitTimelineItem): TreeItem {
        return element;
    }

    async getChildren(element?: ZitTimelineItem): Promise<ZitTimelineItem[]> {
        if (element instanceof TimelineRepositoryItem) {
            return this.getHistoryItems(element.repository);
        }
        if (element) {
            return [];
        }

        if (this.fileUri) {
            const repository = this.model.getRepository(this.fileUri);
            return repository ? this.getHistoryItems(repository) : [];
        }

        const repositories = this.model.repositories;
        if (repositories.length === 1) {
            return this.getHistoryItems(repositories[0]);
        }
        return repositories.map(
            repository => new TimelineRepositoryItem(repository)
        );
    }

    showFile(uri: Uri): void {
        if (uri.scheme !== 'file' || !this.model.getRepository(uri)) {
            return;
        }
        this.fileUri = uri;
        this.limits.clear();
        this.updateDescription();
        this.refresh();
    }

    showProject(): void {
        this.fileUri = undefined;
        this.limits.clear();
        this.updateDescription();
        this.refresh();
    }

    loadMore(repository: Repository): void {
        const limit = this.getLimit(repository);
        this.limits.set(
            repository.root,
            Math.min(limit + PAGE_SIZE, MAX_HISTORY_ENTRIES)
        );
        this.refresh();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    dispose(): void {
        this.view = undefined;
        this._onDidChangeTreeData.dispose();
        Disposable.from(...this.disposables).dispose();
    }

    private onActiveEditorChanged(uri: Uri | undefined): void {
        if (!uri) {
            return;
        }
        if (uri.scheme === 'file') {
            this.showFile(uri);
        } else if (uri.scheme === 'zit') {
            this.showFile(Uri.file(fromZitUri(uri).path));
        }
    }

    private onRepositoryChanged(): void {
        this.updateDescription();
        this.refresh();
    }

    private async getHistoryItems(
        repository: Repository
    ): Promise<ZitTimelineItem[]> {
        const limit = this.getLimit(repository);
        const requestLimit = Math.min(limit + 1, MAX_HISTORY_ENTRIES);
        const options = this.fileUri
            ? { fileUri: this.fileUri, limit: requestLimit }
            : { limit: requestLimit };
        const commits = await repository.getLogEntries(options);
        const visibleCommits = commits.slice(0, limit);
        if (visibleCommits.length === 0) {
            return [new TimelineMessageItem('No history found')];
        }

        const items: ZitTimelineItem[] = visibleCommits.map(
            commit => new TimelineCommitItem(repository, commit, this.fileUri)
        );
        if (commits.length > limit && limit < MAX_HISTORY_ENTRIES) {
            items.push(new TimelineLoadMoreItem(repository));
        }
        return items;
    }

    private getLimit(repository: Repository): number {
        return this.limits.get(repository.root) ?? PAGE_SIZE;
    }

    private updateDescription(): void {
        if (!this.view) {
            return;
        }
        if (this.fileUri) {
            const repository = this.model.getRepository(this.fileUri);
            this.view.description = repository
                ? path.relative(repository.root, this.fileUri.fsPath)
                : undefined;
            return;
        }

        const repositories = this.model.repositories;
        this.view.description =
            repositories.length === 1
                ? path.basename(repositories[0].root)
                : `${repositories.length} repositories`;
    }
}
