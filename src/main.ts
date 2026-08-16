/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ben Crowl. All rights reserved.
 *  Original Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// based on https://github.com/Microsoft/vscode/commit/41f0ff15d7327da30fdae73aa04ca570ce34fa0a

import { ExtensionContext, window, Disposable, commands, Uri } from 'vscode';
import { Model } from './model';
import { CommandCenter } from './commands';
import { ZitFileSystemProvider } from './fileSystemProvider';
import * as nls from 'vscode-nls';
import typedConfig from './config';
import { findZit } from './zitFinder';
import { ZitExecutable } from './zitExecutable';

export const localize = nls.loadMessageBundle();

async function init(context: ExtensionContext): Promise<Model | undefined> {
    const disposables: Disposable[] = [];
    context.subscriptions.push(
        new Disposable(() => Disposable.from(...disposables).dispose())
    );

    const outputChannel = window.createOutputChannel('Zit', { log: true });
    disposables.push(outputChannel);

    const zitPath = typedConfig.path;
    const zitInfo = await findZit(zitPath, outputChannel);
    const executable = new ZitExecutable(outputChannel);

    const model = new Model(executable, zitPath);
    disposables.push(model);
    model.foundExecutable(zitInfo);
    if (!zitInfo && !typedConfig.ignoreMissingZitWarning) {
        const download = localize('downloadZit', 'Download Zit');
        const neverShowAgain = localize('neverShowAgain', "Don't Show Again");
        const editPath = localize('editPath', 'Edit "zit.path"');
        const choice = await window.showWarningMessage(
            localize(
                'notfound',
                "Zit was not found. Install it or configure it using the 'zit.path' setting."
            ),
            download,
            editPath,
            neverShowAgain
        );
        if (choice === download) {
            commands.executeCommand(
                'vscode.open',
                Uri.parse(
                    'https://fossil.craftdesign.group/zit/uv/download.html'
                )
            );
        } else if (choice === editPath) {
            commands.executeCommand(
                'workbench.action.openSettings',
                'zit.path'
            );
        } else if (choice === neverShowAgain) {
            await typedConfig.disableMissingZitWarning();
        }
    }

    const onRepository = () =>
        commands.executeCommand(
            'setContext',
            'zitOpenRepositoryCount',
            model.repositories.length
        );
    model.onDidOpenRepository(onRepository, null, disposables);
    model.onDidCloseRepository(onRepository, null, disposables);
    onRepository();

    disposables.push(
        new CommandCenter(executable, model, outputChannel),
        new ZitFileSystemProvider(model)
    );
    return model;
}

export async function activate(
    context: ExtensionContext
): Promise<void | Model> {
    return init(context).catch(err => console.error(err));
}
