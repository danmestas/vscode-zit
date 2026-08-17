/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Arseniy Terekhin. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Command, SourceControl } from 'vscode';
import { Repository } from './repository';
import { localize } from './main';
import { ExecResult } from './zitExecutable';

/** Repository sync state shown beside the current branch. */
class SyncBar {
    private icon: 'sync' | 'warning' = 'sync';
    private syncMessage: `${string}\n` | '' = '';
    private nextSyncTime: Date | undefined;

    constructor(private repository: Repository) {}

    public onSyncReady(result: ExecResult) {
        this.icon = 'sync';
        if (!result.exitCode) {
            this.syncMessage = '';
        } else {
            if (/no remote/i.test(result.stderr)) {
                this.syncMessage = 'repository with no remote\n';
            } else {
                this.icon = 'warning';
                this.syncMessage = `Sync error: ${result.stderr.trim()}\n`;
            }
        }
    }

    public onNoRemote() {
        this.icon = 'sync';
        this.syncMessage = 'repository with no remote\n';
    }

    public onRemoteChanged(hasRemote: boolean) {
        this.icon = 'sync';
        this.syncMessage = hasRemote ? '' : 'repository with no remote\n';
    }

    public onSyncTimeUpdated(date: Date | undefined) {
        this.nextSyncTime = date;
    }

    public get command(): Command {
        const timeMessage = this.nextSyncTime
            ? `Next sync ${this.nextSyncTime.toTimeString().split(' ')[0]}`
            : `Auto sync disabled`;
        return {
            command: 'zit.sync',
            title: `$(${this.icon})`,
            tooltip: `${timeMessage}\n${this.syncMessage}Sync`,
            arguments: [this.repository satisfies Repository],
        };
    }
}

/** Build the current-branch status-bar command. */
function branchCommand(repository: Repository): Command {
    const { currentBranch, zitStatus } = repository;
    const icon = zitStatus!.isMerge ? '$(git-merge)' : '$(git-branch)';
    const title =
        icon +
        ' ' +
        (currentBranch || 'unknown') +
        (repository.addedGroup.resourceStates.length ||
        repository.workingGroup.resourceStates.length
            ? '+'
            : '');

    const checkin =
        zitStatus!.checkin ?? localize('unborn', 'no check-ins yet');
    return {
        command: 'zit.branchChange',
        tooltip: localize(
            'branch change {0}',
            '{0}\nChange Branch...',
            checkin
        ),
        title,
        arguments: [repository satisfies Repository],
    };
}

export class StatusBarCommands {
    private readonly syncBar: SyncBar;

    constructor(
        private readonly repository: Repository,
        private readonly sourceControl: SourceControl
    ) {
        this.syncBar = new SyncBar(repository);
        this.update();
    }

    public onSyncTimeUpdated(date: Date | undefined) {
        this.syncBar.onSyncTimeUpdated(date);
        this.update();
    }

    public onSyncReady(syncResult: ExecResult) {
        this.syncBar.onSyncReady(syncResult);
        this.update();
    }

    public onNoRemote() {
        this.syncBar.onNoRemote();
        this.update();
    }

    public onRemoteChanged(hasRemote: boolean) {
        this.syncBar.onRemoteChanged(hasRemote);
        this.update();
    }

    /**
     * Should be called whenever commands text/actions/tooltips
     * are updated
     */
    public update(): void {
        let commands: Command[];
        if (this.repository.zitStatus) {
            const update = branchCommand(this.repository);
            const sideEffects = this.repository.operations;
            const messages = [];
            for (const [, se] of sideEffects) {
                if (se.syncText) {
                    messages.push(se.syncText);
                }
            }
            messages.sort();
            const sync = messages.length
                ? {
                      title: '$(sync~spin)',
                      command: '',
                      tooltip: messages.join('\n'),
                  }
                : this.syncBar.command;

            commands = [update, sync];
        } else {
            // this class was just initialized, repository status is unknown
            commands = [
                {
                    command: '',
                    tooltip: localize(
                        'loading {0}',
                        'Loading {0}',
                        this.repository.root
                    ),
                    title: '$(sync~spin)',
                },
            ];
        }
        this.sourceControl.statusBarCommands = commands;
    }
}
