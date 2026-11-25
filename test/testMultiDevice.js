const assert = require('node:assert/strict');
const axios = require('axios');
const md5 = require('md5');
const { DEFAULT_DEVICE_ID, JudoDevice } = require('../lib/judoDevice');
const defaults = require('../io-package.json').native;

describe('Device connections', () => {
    it('keeps local and cloud sessions and command targets separate', async () => {
        const values = new Map();
        const adapter = /** @type {import('@iobroker/adapter-core').AdapterInstance} */ (
            /** @type {unknown} */ ({
                log: { debug() {}, warn() {}, error() {} },
                async setStateAsync(id, value) {
                    values.set(id, value);
                },
                setTimeout,
                clearTimeout,
            })
        );
        const local = new JudoDevice(
            adapter,
            DEFAULT_DEVICE_ID,
            'Default',
            { ...defaults, ip: 'local-device', password: 'local&password' },
            async () => {},
        );
        const cloudConfig = { ...defaults, cloud: true, restApi: true, user: 'cloud-user', password: 'cloud-password' };
        const first = new JudoDevice(adapter, 'first', 'First cloud device', cloudConfig, async () => {});
        const second = new JudoDevice(
            adapter,
            'second',
            'Second cloud device',
            { ...cloudConfig, deviceIndex: 1 },
            async () => {},
        );
        const cloudDevices = ['first-serial', 'second-serial'].map((serialnumber, index) => ({
            serialnumber,
            status: 'true',
            data: [{ da: `addr-${index}`, dt: `type-${index}`, data: { 1: { data: '000101' }, 2: { data: '0101' } } }],
        }));
        const reads = {
            'water current': '11 2',
            'water total': '0 2000 1000',
            'water yearly': '2025 0 0 0 0 0 0 0 0 0 0 0 0',
            valve: 'opened',
        };
        const writes = [];
        const logins = [];
        const axiosAdapter = axios.defaults.adapter;
        axios.defaults.adapter = async config => {
            assert(config.url);
            const url = new URL(config.url);
            const params = url.searchParams;
            const command = params.get('command');
            const cloud = url.hostname === 'www.myjudo.eu';
            let data;
            switch (command) {
                case 'login':
                    logins.push({
                        host: url.host,
                        user: params.get('user'),
                        password: params.get('password'),
                    });
                    data = { status: 'ok', token: cloud ? 'cloud-token' : 'local-token' };
                    break;
                case 'get device data':
                    data = { status: 'ok', data: cloudDevices };
                    break;
                case 'show':
                    data = { data: [{ wtuType: '1', 'serial number': 'local-serial' }] };
                    break;
                case 'connect':
                    data = { status: 'true' };
                    break;
                default:
                    assert.equal(params.get('token'), cloud ? 'cloud-token' : 'local-token');
                    if (command === 'write data' || params.has('parameter')) {
                        writes.push([
                            url.host,
                            params.get('serial_number'),
                            params.get('da'),
                            params.get('dt'),
                            params.get('data') ?? params.get('parameter'),
                        ]);
                    }
                    data = { status: 'ok', data: reads[command ?? ''] ?? '0' };
            }
            return { data, status: 200, statusText: 'OK', headers: {}, config };
        };

        try {
            await Promise.all([local.poll(), first.poll(), second.poll()]);
            assert([local, first, second].every(device => device.connected));
            assert.deepEqual(logins, [
                { host: 'local-device:8124', user: 'user', password: 'local&password' },
                { host: 'www.myjudo.eu', user: 'cloud-user', password: md5('cloud-password') },
                { host: 'www.myjudo.eu', user: 'cloud-user', password: md5('cloud-password') },
            ]);
            assert.equal(values.get('SerialNumber'), 'local-serial');
            assert.equal(values.get('first.SerialNumber'), 'first-serial');
            assert.equal(values.get('second.SerialNumber'), 'second-serial');

            await Promise.all([
                local.handleCommand('ResidualHardness', 7),
                first.handleCommand('ResidualHardness', 8),
                second.handleCommand('ResidualHardness', 9),
            ]);
            assert.deepEqual(writes, [
                ['local-device:8124', null, null, null, '7'],
                ['www.myjudo.eu', 'first-serial', 'addr-0', 'type-0', '8'],
                ['www.myjudo.eu', 'second-serial', 'addr-1', 'type-1', '9'],
            ]);
        } finally {
            await Promise.all([local.stop(), first.stop(), second.stop()]);
            axios.defaults.adapter = axiosAdapter;
        }
    });
});
