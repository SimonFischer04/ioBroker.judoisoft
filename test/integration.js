const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('node:http');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { tests } = require('@iobroker/testing');

const instance = 'judoisoft.0';

/**
 * @param {string} date - Hex value returned by the device clock.
 * @param {string} password - Password expected by the test device.
 */
async function restDevice(date, password) {
    const device = { online: true, writes: /** @type {string[]} */ ([]) };
    const authorization = `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;
    const registers = { FF00: '47', '0600': 'C220', '0100': '661301', '0E00': '6414CB7B', 6100: date };
    const server = createServer((request, response) => {
        if (!device.online || request.headers.authorization !== authorization) {
            response.writeHead(device.online ? 401 : 503).end();
            return;
        }
        const register = request.url?.split('/').pop() ?? '';
        if (/^3000[0-9A-F]{2}$/.test(register)) {
            device.writes.push(register);
            response.writeHead(200).end();
            return;
        }
        if (registers[register]) {
            response
                .writeHead(200, { 'Content-Type': 'application/json' })
                .end(JSON.stringify({ data: registers[register] }));
        } else {
            response.writeHead(400).end();
        }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address === 'object');
    return Object.assign(device, { server, address: `127.0.0.1:${address.port}` });
}

/**
 * @param {() => boolean | Promise<boolean>} condition - Condition to verify after the adapter has handled an update.
 * @param {string} message - Assertion to report if the update does not arrive.
 */
async function waitFor(condition, message) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (await condition()) {
            return;
        }
        await delay(50);
    }
    assert.fail(message);
}

tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite, it }) {
        suite('Device Manager', getHarness => {
            it('keeps legacy IDs while adding, editing and removing a second device', async function () {
                this.timeout(45_000);
                const harness = getHarness();
                const original = await restDevice('0507170a1b1b', 'legacy-password');
                const workshop = await restDevice('0607170a1b1b', 'workshop-password');

                const getState = async id => (await harness.states.getStateAsync(`${instance}.${id}`))?.val;
                const send = (command, message = {}) =>
                    new Promise((resolve, reject) => {
                        const timeout = setTimeout(() => reject(new Error(`No response to dm:${command}`)), 5000);
                        harness.sendTo(instance, `dm:${command}`, message, response => {
                            clearTimeout(timeout);
                            resolve(response);
                        });
                    });
                const startAdapter = async () => {
                    await harness.startAdapter();
                    await waitFor(async () => (await getState('info.connection')) === true, 'Default device connected');
                };

                try {
                    await harness.changeAdapterConfig('judoisoft', {
                        native: {
                            restApi: true,
                            ip: original.address,
                            user: 'admin',
                            password: 'legacy-password',
                            interval: 1,
                        },
                    });
                    await startAdapter();

                    assert.equal(await getState('Date'), 1688552847000);
                    const info = await send('instanceInfo');
                    assert.equal(info.apiVersion, 'v3');
                    assert.equal(info.actions[0].id, 'add');
                    const form = await send('instanceAction', { actionId: 'add' });
                    assert.equal(form.type, 'form');
                    const added = await send('actionProgress', {
                        origin: form.origin,
                        data: {
                            ...form.form.data,
                            id: 'workshop',
                            name: 'Workshop',
                            ip: workshop.address,
                            restApi: true,
                            user: 'admin',
                            password: 'workshop-password',
                            interval: 1,
                        },
                    });
                    assert.equal(added.result.refresh, true);
                    await waitFor(
                        async () => (await getState('workshop.info.connection')) === true,
                        'Workshop connected',
                    );
                    assert.equal(await getState('workshop.Date'), 1688639247000);
                    assert.equal(await getState('Date'), 1688552847000);

                    await harness.states.setStateAsync(`${instance}.ResidualHardness`, { val: 8, ack: false });
                    await harness.states.setStateAsync(`${instance}.workshop.ResidualHardness`, { val: 9, ack: false });
                    await waitFor(
                        () => original.writes.length === 1 && workshop.writes.length === 1,
                        'Both commands arrived',
                    );
                    assert.deepEqual(original.writes, ['300008']);
                    assert.deepEqual(workshop.writes, ['300009']);

                    const names = await send('loadDevices');
                    assert.deepEqual(
                        names.add.map(device => device.id),
                        ['default', 'workshop'],
                    );
                    const edit = await send('deviceAction', { deviceId: 'workshop', actionId: 'edit' });
                    assert.equal(edit.form.data.password, '');
                    const edited = await send('actionProgress', {
                        origin: edit.origin,
                        data: { ...edit.form.data, name: 'Outbuilding', interval: 2 },
                    });
                    assert.equal(edited.result.refresh, 'devices');

                    const object = await harness.objects.getObjectAsync(`${instance}.workshop`);
                    assert.equal(object.common.name, 'Outbuilding');
                    assert.equal(object.native.judoisoft.interval, 2);
                    assert(object.native.judoisoft.password);
                    assert.notEqual(object.native.judoisoft.password, 'workshop-password');

                    await waitFor(
                        async () => (await getState('workshop.info.connection')) === true,
                        'Edited device reconnected',
                    );
                    assert.equal(await getState('Date'), 1688552847000);

                    workshop.online = false;
                    await waitFor(
                        async () => (await getState('workshop.info.connection')) === false,
                        'Workshop went offline',
                    );
                    assert.equal(await getState('info.connection'), true);
                    assert(!harness.hasLog('workshop-password'));

                    await send('instanceInfo');
                    await send('loadDevices');
                    const confirmation = await send('deviceAction', { deviceId: 'workshop', actionId: 'delete' });
                    assert.equal(confirmation.type, 'confirm');
                    const removed = await send('actionProgress', { origin: confirmation.origin, confirm: true });
                    assert.equal(removed.result.refresh, 'devices');
                    assert.equal(await harness.objects.getObjectAsync(`${instance}.workshop.Date`), null);
                    assert.equal(await getState('Date'), 1688552847000);
                    assert.equal(await getState('info.connection'), true);
                } finally {
                    original.server.close();
                    workshop.server.close();
                }
            });
        });

        suite('Persisted devices', getHarness => {
            it('loads a saved device and its credentials without a default device', async function () {
                this.timeout(15_000);
                const harness = getHarness();
                const workshop = await restDevice('0607170a1b1b', 'workshop-password');
                try {
                    await harness.objects.setObjectAsync(`${instance}.workshop`, {
                        type: 'device',
                        common: { name: 'Workshop' },
                        native: {
                            judoisoft: {
                                cloud: false,
                                restApi: true,
                                deviceIndex: 0,
                                ip: workshop.address,
                                user: 'admin',
                                password: await harness.encryptValue('workshop-password'),
                                interval: 1,
                            },
                        },
                    });
                    await harness.startAdapter();
                    const getState = async id => (await harness.states.getStateAsync(`${instance}.${id}`))?.val;
                    await waitFor(async () => (await getState('info.connection')) === true, 'Saved device connected');
                    assert.equal(await getState('workshop.Date'), 1688639247000);
                    assert.equal(await getState('workshop.info.connection'), true);
                    assert.equal(await harness.objects.getObjectAsync(`${instance}.Date`), null);
                } finally {
                    workshop.server.close();
                }
            });
        });
    },
});
