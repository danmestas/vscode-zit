import { suiteSetup, teardown, Suite } from 'mocha';
import * as sinon from 'sinon';
import {
    StatusSuite,
    CleanSuite,
    RemoteSuite,
    FileSystemSuite,
    DiffSuite,
} from './commandSuites';
import { MergeSuite } from './mergeSuite';
import { cleanRoot, zitInit, zitOpen } from './common';
import { utilitiesSuite } from './utilitiesSuite';
import { resourceActionsSuite } from './resourceActionsSuite';
import { timelineSuite } from './timelineSuite';
import { CommitSuite } from './commitSuite';
import { QualityOfLifeSuite as QualityOfLifeSuite } from './qualityOfLifeSuite';
import { StashSuite, UpdateSuite } from './stateSuite';
import { RenameSuite } from './renameSuite';
import { BranchSuite } from './branchSuite';
import { RevertSuite } from './revertSuite';
import { GitExportSuite } from './gitExportSuite';
import { StatusBarSuite } from './statusBarSuite';
import { workspace } from 'vscode';

suite('Zit.OpenedRepo', function (this: Suite) {
    this.timeout(30_000);
    this.ctx.sandbox = sinon.createSandbox();
    this.ctx.workspaceUri = workspace.workspaceFolders![0].uri;

    suiteSetup(async () => {
        await cleanRoot();
        await zitInit();
        await zitOpen(this.ctx.sandbox);
    });

    suite('Utilities', utilitiesSuite);
    suite('Update', UpdateSuite);
    suite('Status Bar', StatusBarSuite);
    suite('Resource Actions', resourceActionsSuite);
    suite('Timeline', timelineSuite);
    suite('Revert', RevertSuite);
    suite('Stash', StashSuite);
    suite('Branch', BranchSuite);
    suite('Commit', CommitSuite);
    suite('Merge', MergeSuite);
    suite('Status', StatusSuite);
    suite('Rename', RenameSuite);
    suite('Clean', CleanSuite);
    suite('Remote', RemoteSuite);
    suite('FileSystem', FileSystemSuite);
    suite('Diff', DiffSuite);
    suite('Quality of Life', QualityOfLifeSuite);
    suite('Git Export', GitExportSuite);

    teardown(() => {
        this.ctx.sandbox.restore();
    });
});
