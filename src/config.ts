import { workspace } from 'vscode';
import type { ZitUsername, Distinct } from './openedRepository';
import type { UnvalidatedZitExecutablePath } from './zitFinder';

export type AutoSyncIntervalMs = Distinct<number, 'AutoSyncIntervalMs'>;

interface ConfigScheme {
    ignoreMissingZitWarning: boolean;
    path: UnvalidatedZitExecutablePath;
    autoSyncInterval: number;
    username: ZitUsername; // must be ignored when empty
    defaultUsername: ZitUsername; // must be ignored when empty
    autoRefresh: boolean;
    enableRenaming: boolean;
    confirmGitExport: 'Automatically' | 'Never' | null;
    globalArgs: string[];
    commitArgs: string[];
}

class Config {
    private get config() {
        return workspace.getConfiguration('zit');
    }

    private get<TName extends keyof ConfigScheme>(
        name: TName
    ): ConfigScheme[TName] {
        // for keys existing in packages.json this function
        // will not return `undefined`
        return this.config.get<ConfigScheme[TName]>(name)!;
    }

    get path(): UnvalidatedZitExecutablePath {
        return this.get('path').trim() as UnvalidatedZitExecutablePath;
    }

    /**
     * Enables automatic refreshing of Source Control tab and badge
     * counter when files within the project change.
     */
    get autoRefresh(): boolean {
        return this.get('autoRefresh');
    }

    get autoSyncIntervalMs(): AutoSyncIntervalMs {
        return (this.get('autoSyncInterval') * 1000) as AutoSyncIntervalMs;
    }

    get enableRenaming(): boolean {
        return this.get('enableRenaming');
    }

    get ignoreMissingZitWarning(): boolean {
        return this.get('ignoreMissingZitWarning');
    }

    disableMissingZitWarning() {
        return this.config.update('ignoreMissingZitWarning', true, false);
    }

    /**
     * * Specifies an explicit user to use for Zit commits.
     * * This should only be used if the user is different
     *   than the Zit default user.
     */
    get username(): ZitUsername {
        return this.get('username');
    }

    get defaultUsername(): ZitUsername {
        return this.get('defaultUsername');
    }

    disableRenaming() {
        return this.config.update('enableRenaming', false, false);
    }

    setGitExport(how: NonNullable<ConfigScheme['confirmGitExport']>) {
        return this.config.update('confirmGitExport', how, false);
    }

    get gitExport() {
        return this.get('confirmGitExport');
    }

    get globalArgs() {
        return this.get('globalArgs');
    }
    get commitArgs() {
        return this.get('commitArgs');
    }
}

const typedConfig = new Config();
export default typedConfig;
