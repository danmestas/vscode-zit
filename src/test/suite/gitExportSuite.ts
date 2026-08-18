import { commands, Uri, window } from 'vscode';
import * as assert from 'assert/strict';
import * as sinon from 'sinon';
import { Suite } from 'mocha';
import * as interaction from '../../interaction';
import {
    fakeExecutionResult,
    getExecStub,
    getRepository,
    stubZitConfig,
} from './common';

export function GitExportSuite(this: Suite): void {
    test('exports the checkout root to the selected Git directory', async () => {
        stubZitConfig(this.ctx.sandbox)
            .get.withArgs('confirmGitExport')
            .returns('Automatically');
        this.ctx.sandbox
            .stub(window, 'showOpenDialog')
            .resolves([Uri.file('/tmp/zit-git-export')]);
        const repository = getRepository();
        const exportCall = getExecStub(this.ctx.sandbox)
            .withArgs(['export-git', repository.root, '/tmp/zit-git-export'])
            .resolves(fakeExecutionResult());

        await commands.executeCommand('zit.gitExport');

        const signal = exportCall.firstCall.args[2]?.signal;
        assert.ok(signal instanceof AbortSignal);
        sinon.assert.calledOnceWithExactly(
            exportCall,
            ['export-git', repository.root, '/tmp/zit-git-export'],
            undefined,
            { signal }
        );
    });

    test('does not export when confirmation is declined', async () => {
        stubZitConfig(this.ctx.sandbox)
            .get.withArgs('confirmGitExport')
            .returns('Never');
        const openDialog = this.ctx.sandbox.stub(window, 'showOpenDialog');
        const exec = getExecStub(this.ctx.sandbox);

        await commands.executeCommand('zit.gitExport');

        sinon.assert.notCalled(openDialog);
        sinon.assert.notCalled(exec);
    });

    test('does not export when destination selection is canceled', async () => {
        stubZitConfig(this.ctx.sandbox)
            .get.withArgs('confirmGitExport')
            .returns('Automatically');
        this.ctx.sandbox.stub(window, 'showOpenDialog').resolves(undefined);
        const exec = getExecStub(this.ctx.sandbox);

        await commands.executeCommand('zit.gitExport');

        assert.equal(exec.callCount, 0);
    });

    test('handles every interactive Git export confirmation choice', async () => {
        const config = stubZitConfig(this.ctx.sandbox);
        config.update
            .withArgs('confirmGitExport', 'Automatically', false)
            .resolves();
        config.update.withArgs('confirmGitExport', 'Never', false).resolves();
        const prompt = this.ctx.sandbox.stub(
            window,
            'showInformationMessage'
        ) as sinon.SinonStub;
        prompt.onCall(0).resolves('Yes');
        prompt.onCall(1).resolves('No');
        prompt.onCall(2).resolves(undefined);
        prompt.onCall(3).resolves('Automatically');
        prompt.onCall(4).resolves('Never');

        assert.equal(await interaction.confirmGitExport(), true);
        assert.equal(await interaction.confirmGitExport(), false);
        assert.equal(await interaction.confirmGitExport(), false);
        assert.equal(await interaction.confirmGitExport(), true);
        assert.equal(await interaction.confirmGitExport(), false);

        sinon.assert.calledTwice(config.update);
        sinon.assert.calledWithExactly(
            config.update,
            'confirmGitExport',
            'Automatically',
            false
        );
        sinon.assert.calledWithExactly(
            config.update,
            'confirmGitExport',
            'Never',
            false
        );
    });
}
