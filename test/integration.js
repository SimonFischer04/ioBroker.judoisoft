const assert = require('node:assert/strict');
const path = require('path');
const { tests } = require('@iobroker/testing');
const { it } = require('mocha');

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('adapter help', getHarness => {
            it('advertises help and answers a callback without a device connection', async () => {
                const harness = getHarness();
                await harness.changeAdapterConfig('judoisoft', { native: { restApi: true, ip: '' } });
                const instance = await harness.getAdapterConfig();
                assert.equal(instance?.common.supportedMessages?.['help'], true);

                await harness.startAdapterAndWait();

                const reply = await new Promise(resolve => harness.sendTo('judoisoft.0', 'help', {}, resolve));
                assert.ok(reply && typeof reply === 'object' && 'commands' in reply && 'help' in reply);
                assert.deepEqual(reply.commands, [{ command: 'help', write: false }]);
                assert.ok(typeof reply.help === 'string');
                assert.match(reply.help, /judoisoft\.0\.info\.connection/);
                assert.match(reply.help, /local REST API/);
                assert.match(reply.help, /WaterStop \(boolean\) closes the shutoff valve with true/);
                assert.doesNotMatch(reply.help, /StandBy/);
            }).timeout(30_000);
        });
    },
});
