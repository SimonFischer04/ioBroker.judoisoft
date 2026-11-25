'use strict';

const utils = require('@iobroker/adapter-core');
const { COMMANDS, DEFAULT_DEVICE_ID, JudoDevice } = require('./lib/judoDevice');
const JudoDeviceManagement = require('./lib/deviceManagement');
const defaults = require('./io-package.json').native;

/** @typedef {import('./lib/judoDevice').DeviceConfig} DeviceConfig */

// New device IDs use lowercase characters. Reserve the legacy lowercase root IDs and the default device ID.
const RESERVED_IDS = new Set([DEFAULT_DEVICE_ID, 'info', 'token']);

class Judoisoft extends utils.Adapter {
    /** @param {Partial<utils.AdapterOptions>} [options] - Adapter initialization options. */
    constructor(options) {
        super({ ...options, name: 'judoisoft' });
        /** @type {Map<string, JudoDevice>} */
        this.devices = new Map();
        this.deviceChanges = Promise.resolve();
        this.unloading = false;
        /** @type {Promise<void>} */
        this.devicesLoaded = new Promise(resolve => {
            this.once('ready', () => {
                void this.onReady()
                    .catch(() => this.log.error('Could not load the JUDO device configuration'))
                    .finally(resolve);
            });
        });
        new JudoDeviceManagement(this);
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        await this.setStateAsync('info.connection', false, true);
        await this.subscribeStatesAsync(COMMANDS.flatMap(command => [command, `*.${command}`]));
        const legacyIp = this.config.ipaddress?.trim();
        const ip = this.config.ip?.trim() || (legacyIp === defaults.ipaddress ? '' : legacyIp) || '';
        if (this.config.cloud || ip) {
            await this.startDevice(DEFAULT_DEVICE_ID, 'Default device', { ...defaults, ...this.config, ip });
        }

        const devices = await this.getDevicesAsync();
        await Promise.all(
            devices.map(async object => {
                const id = object._id.slice(this.namespace.length + 1);
                const stored = object.native.judoisoft;
                if (!stored || !this.isDeviceId(id)) {
                    return;
                }
                try {
                    const config = { ...stored, password: stored.password ? this.decrypt(stored.password) : '' };
                    await this.startDevice(id, object.common.name || id, config);
                } catch {
                    this.log.error(`[${id}] Could not load the device settings`);
                }
            }),
        );
    }

    /** @param {() => void} callback - Completes adapter shutdown. */
    onUnload(callback) {
        this.unloading = true;
        void this.shutdown()
            .catch(() => this.log.error('Could not clear connection states on shutdown'))
            .finally(callback);
    }

    async shutdown() {
        await Promise.all([...this.devices.values()].map(device => device.stop()));
        await this.deviceChanges;
        await Promise.all([
            this.setStateAsync('info.connection', false, true),
            ...[...this.devices.values()]
                .filter(device => device.id !== DEFAULT_DEVICE_ID)
                .map(device => this.setStateAsync(device.connectionId, false, true)),
        ]);
    }

    /**
     * Routes writes by the full state ID so identical command names can be used on different devices.
     *
     * @param {string} id - Full state ID.
     * @param {ioBroker.State | null | undefined} state - New state, or null when deleted.
     */
    onStateChange(id, state) {
        if (!state || state.ack || this.unloading || !id.startsWith(`${this.namespace}.`)) {
            return;
        }
        const relativeId = id.slice(this.namespace.length + 1);
        const separator = relativeId.indexOf('.');
        const device = this.devices.get(separator === -1 ? DEFAULT_DEVICE_ID : relativeId.slice(0, separator));
        const command = relativeId.slice(separator + 1);
        if (device?.stateId(command) === relativeId) {
            void device.handleCommand(command, state.val);
        }
    }

    async updateConnection() {
        if (!this.unloading) {
            const defaultDevice = this.devices.get(DEFAULT_DEVICE_ID);
            const connected = defaultDevice?.connected ?? [...this.devices.values()].some(device => device.connected);
            await this.setStateAsync('info.connection', connected, true);
        }
    }

    /** @param {string} id - Candidate for a device's root object ID. */
    isDeviceId(id) {
        return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) && !RESERVED_IDS.has(id);
    }

    /**
     * @param {string} id - Stable device identifier.
     * @param {ioBroker.StringOrTranslated} name - Display name.
     * @param {DeviceConfig} config - Connection settings.
     */
    async startDevice(id, name, config) {
        if (this.unloading) {
            return;
        }
        const device = new JudoDevice(this, id, typeof name === 'string' ? name : name.en, config, () =>
            this.updateConnection(),
        );
        this.devices.set(id, device);
        try {
            await device.initialize();
            if (!this.unloading) {
                device.start();
            }
        } catch {
            this.log.error(`[${id}] Could not initialize the device objects`);
        }
    }

    /**
     * Serializes configuration changes from separate Device Manager dialogs.
     *
     * @param {() => Promise<void>} change - Device configuration change.
     */
    changeDevice(change) {
        const task = this.deviceChanges.then(async () => {
            await this.devicesLoaded;
            if (this.unloading) {
                throw new Error('The adapter is shutting down.');
            }
            await change();
        });
        this.deviceChanges = task.catch(() => {});
        return task;
    }

    /**
     * @param {string} id - New device's stable identifier.
     * @param {string} name - Display name.
     * @param {DeviceConfig} config - Connection settings.
     */
    addDevice(id, name, config) {
        return this.changeDevice(async () => {
            if (!this.isDeviceId(id)) {
                throw new Error(
                    'Choose an unreserved object ID with up to 64 lowercase letters, digits, hyphens or underscores. Start with a letter or digit.',
                );
            }
            const root = `${this.namespace}.${id}`;
            const existing = await this.getObjectAsync(id);
            const children = await this.getObjectListAsync({ startkey: `${root}.`, endkey: `${root}.\u9999` });
            if (this.devices.has(id) || existing || children.rows.length) {
                throw new Error('This object ID is already in use.');
            }
            await this.saveDevice(id, name, config);
            await this.startDevice(id, name, config);
        });
    }

    /**
     * @param {JudoDevice} device - Device when the edit dialog was opened.
     * @param {string} name - Updated display name.
     * @param {DeviceConfig} config - Updated connection settings.
     */
    editDevice(device, name, config) {
        return this.changeDevice(async () => {
            this.checkCurrentDevice(device);
            await this.saveDevice(device.id, name, config);
            await device.stop();
            await this.startDevice(device.id, name, config);
            await this.updateConnection();
        });
    }

    /** @param {JudoDevice} device - Device when the confirmation dialog was opened. */
    removeDevice(device) {
        return this.changeDevice(async () => {
            this.checkCurrentDevice(device);
            await device.stop();
            try {
                await this.delObjectAsync(device.id, { recursive: true });
            } catch {
                await this.startDevice(device.id, device.name, device.config);
                throw new Error('Could not remove the device objects.');
            }
            this.devices.delete(device.id);
            await this.updateConnection();
        });
    }

    /** @param {JudoDevice} device - Device that the action applies to. */
    checkCurrentDevice(device) {
        if (!this.isDeviceId(device.id) || this.devices.get(device.id) !== device) {
            throw new Error('The device configuration has changed. Reopen the device to try again.');
        }
    }

    /**
     * @param {string} id - Device identifier.
     * @param {string} name - Display name.
     * @param {DeviceConfig} config - Connection settings.
     */
    async saveDevice(id, name, config) {
        const { password, ...settings } = config;
        await this.extendObjectAsync(id, {
            type: 'device',
            common: { name },
            native: { judoisoft: { ...settings, password: password ? this.encrypt(password) : '' } },
        });
    }
}

// @ts-expect-error parent is a valid property on module
if (module.parent) {
    /** @param {Partial<utils.AdapterOptions>} [options] - Adapter initialization options. */
    module.exports = options => new Judoisoft(options);
} else {
    new Judoisoft();
}
