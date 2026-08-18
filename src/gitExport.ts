import { CancellationError, ProgressLocation, window } from 'vscode';
import type { Repository } from './repository';
import type { UserPath } from './openedRepository';
import { confirmGitExport } from './interaction';

export async function inputExportDestination(): Promise<UserPath | undefined> {
    const destination = (
        await window.showOpenDialog({
            title: 'Select the destination Git repository',
            openLabel: 'Export here',
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
        })
    )?.[0];
    return destination?.fsPath as UserPath | undefined;
}

export async function exportGit(repository: Repository): Promise<void> {
    if (!(await confirmGitExport())) {
        return;
    }
    const destination = await inputExportDestination();
    if (!destination) {
        return;
    }
    await window.withProgress(
        {
            title: `Exporting Zit repository to ${destination}`,
            location: ProgressLocation.Notification,
            cancellable: true,
        },
        async (progress, token) => {
            const controller = new AbortController();
            const cancellation = token.onCancellationRequested(() =>
                controller.abort()
            );
            if (token.isCancellationRequested) {
                controller.abort();
            }
            try {
                progress.report({ message: 'Exporting check-ins…' });
                await repository.gitExport(destination, controller.signal);
                if (controller.signal.aborted) {
                    throw new CancellationError();
                }
                progress.report({ message: 'Git export complete' });
            } catch (error) {
                if (controller.signal.aborted) {
                    throw new CancellationError();
                }
                throw error;
            } finally {
                cancellation.dispose();
            }
        }
    );
}
