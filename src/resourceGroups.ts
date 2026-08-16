import { ZitRoot, FileStatus, ResourceStatus } from './openedRepository';
import {
    Uri,
    SourceControlResourceGroup,
    SourceControl,
    Disposable,
} from 'vscode';
import * as path from 'path';
import { ZitResource } from './repository';

import { localize } from './main';

interface IGroupStatusesParams {
    repositoryRoot: ZitRoot;
    statusGroups: IStatusGroups;
    fileStatuses: FileStatus[];
}

export interface IStatusGroups {
    added: ZitResourceGroup;
    working: ZitResourceGroup;
    untracked: ZitResourceGroup;
}

export type ZitResourceId = keyof IStatusGroups;

export function createEmptyStatusGroups(scm: SourceControl): IStatusGroups {
    const addedGroup = new ZitResourceGroup(
        scm,
        'added',
        localize('added files', 'Added Files')
    );
    const workingGroup = new ZitResourceGroup(
        scm,
        'working',
        localize('changes', 'Changes')
    );
    const untrackedGroup = new ZitResourceGroup(
        scm,
        'untracked',
        localize('untracked files', 'Untracked Files')
    );

    return {
        added: addedGroup,
        working: workingGroup,
        untracked: untrackedGroup,
    };
}

export interface IZitResourceGroup extends SourceControlResourceGroup {
    resourceStates: ZitResource[];
}

export class ZitResourceGroup {
    private readonly _uriToResource: Map<string, ZitResource>;
    private readonly _vscode_group: IZitResourceGroup;
    get disposable(): Disposable {
        return this._vscode_group;
    }
    get resourceStates(): ZitResource[] {
        return this._vscode_group.resourceStates;
    }
    getResource(uri: Uri): ZitResource | undefined {
        return this._uriToResource.get(uri.toString());
    }
    includesUri(uri: Uri): boolean {
        return this._uriToResource.has(uri.toString());
    }
    includesDir(uriStr: string): boolean {
        // important: `uriStr` should end with path.sep to work properly
        for (const key of this._uriToResource.keys()) {
            if (key.startsWith(uriStr)) {
                return true;
            }
        }
        return false;
    }

    constructor(
        sourceControl: SourceControl,
        id: ZitResourceId,
        readonly label: string // translated string
    ) {
        this._uriToResource = new Map<string, ZitResource>();
        this._vscode_group = sourceControl.createResourceGroup(
            id,
            label
        ) as IZitResourceGroup;
        this._vscode_group.hideWhenEmpty = true;
    }

    is(id: ZitResourceId): boolean {
        return this._vscode_group.id === id;
    }

    updateResources(resources: ZitResource[]): void {
        this._vscode_group.resourceStates = resources;
        this._uriToResource.clear();
        resources.forEach(resource =>
            this._uriToResource.set(resource.resourceUri.toString(), resource)
        );
    }
}

export function groupStatuses({
    repositoryRoot,
    statusGroups: { added, working, untracked },
    fileStatuses,
}: IGroupStatusesParams): void {
    const addedResources: ZitResource[] = [];
    const workingResources: ZitResource[] = [];
    const untrackedResources: ZitResource[] = [];

    const chooseResourcesAndGroup = (
        status: ResourceStatus
    ): [ZitResource[], ZitResourceGroup] => {
        if (status === ResourceStatus.ADDED) {
            return [addedResources, added];
        }
        if (status === ResourceStatus.EXTRA) {
            return [untrackedResources, untracked];
        }
        return [workingResources, working];
    };

    for (const raw of fileStatuses) {
        const uri = Uri.file(path.join(repositoryRoot, raw.path));
        const [resources, group] = chooseResourcesAndGroup(raw.status);
        resources.push(new ZitResource(group, uri, raw.status, raw.klass));
    }

    added.updateResources(addedResources);
    working.updateResources(workingResources);
    untracked.updateResources(untrackedResources);
}

export const isResourceGroup = (
    obj: ZitResource | SourceControlResourceGroup
): obj is SourceControlResourceGroup =>
    (<SourceControlResourceGroup>obj).resourceStates !== undefined;
