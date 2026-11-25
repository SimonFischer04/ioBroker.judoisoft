'use strict';

const fs = require('node:fs');
const { isIPv6 } = require('node:net');
const path = require('node:path');
const { DeviceManagement } = require('@iobroker/dm-utils');
const { DEFAULT_DEVICE_ID } = require('./judoDevice');
const defaults = require('../io-package.json').native;
const adminConfig = require('../admin/jsonConfig.json');
const { label: defaultDeviceLabel, items: connectionFields } = adminConfig.items._defaultDevice;

const translationsDirectory = path.join(__dirname, '../admin/i18n');
/** @type {[string, Record<string, string>][]} */
const dictionaries = fs
    .readdirSync(translationsDirectory)
    .filter(file => file.endsWith('.json'))
    .map(file => [path.basename(file, '.json'), require(path.join(translationsDirectory, file))]);

/** @param {string} key - Translation key in the Admin dictionaries. */
function translate(key) {
    return {
        en: key,
        ...Object.fromEntries(dictionaries.map(([language, dictionary]) => [language, dictionary[key] ?? key])),
    };
}

/** @type {Record<string, import('@iobroker/dm-utils').ConfigItemAny>} */
const fields = Object.fromEntries(
    Object.entries(connectionFields).map(([key, field]) => [
        key,
        /** @type {import('@iobroker/dm-utils').ConfigItemAny} */ ({
            ...field,
            label: translate(field.label),
            ...('tooltip' in field ? { tooltip: translate(field.tooltip) } : {}),
        }),
    ]),
);

const addTitle = { en: 'Add device', de: 'Gerät hinzufügen' };
const editTitle = { en: 'Edit device', de: 'Gerät bearbeiten' };

/** @typedef {import('./judoDevice').DeviceConfig} DeviceConfig */
/** @typedef {import('./judoDevice').JudoDevice} JudoDevice */
/** @typedef {import('@iobroker/dm-utils').ActionContext} ActionContext */
/** @typedef {import('@iobroker/dm-utils').DeviceInfo<string>} DeviceInfo */
/** @typedef {import('@iobroker/dm-utils').JsonFormSchema} JsonFormSchema */
/** @typedef {import('@iobroker/dm-utils').JsonFormData} JsonFormData */

/**
 * @typedef {import('@iobroker/adapter-core').AdapterInstance & {
 *     devicesLoaded: Promise<void>;
 *     devices: Map<string, JudoDevice>;
 *     addDevice(id: string, name: string, config: DeviceConfig): Promise<void>;
 *     editDevice(device: JudoDevice, name: string, config: DeviceConfig): Promise<void>;
 *     removeDevice(device: JudoDevice): Promise<void>;
 * }} JudoAdapter
 */

/** @augments {DeviceManagement<JudoAdapter>} */
class JudoDeviceManagement extends DeviceManagement {
    /** Prevent passwords from appearing in the Device Manager's debug output. */
    get log() {
        return { ...super.log, debug: () => {} };
    }

    /** @returns {import('@iobroker/dm-utils').InstanceDetails} Device Manager actions for the instance. */
    getInstanceInfo() {
        return {
            apiVersion: 'v3',
            identifierLabel: { en: 'Object ID', de: 'Objekt-ID' },
            actions: [
                {
                    id: 'add',
                    icon: 'add',
                    title: addTitle,
                    handler: async context => ({ refresh: await this.configureDevice(context) }),
                },
            ],
        };
    }

    /** @param {import('@iobroker/dm-utils').DeviceLoadContext<string>} context - Device list to populate. */
    async loadDevices(context) {
        await this.adapter.devicesLoaded;
        context.setTotalDevices(this.adapter.devices.size);
        for (const device of this.adapter.devices.values()) {
            context.addDevice(this.deviceInfo(device));
        }
    }

    /**
     * @param {JudoDevice} device - Configured device.
     * @returns {DeviceInfo} Device card.
     */
    deviceInfo(device) {
        const isDefault = device.id === DEFAULT_DEVICE_ID;
        return {
            id: device.id,
            identifier: isDefault ? this.adapter.namespace : `${this.adapter.namespace}.${device.id}`,
            name: isDefault ? defaultDeviceLabel : device.name,
            status: {
                connection: {
                    stateId: `${this.adapter.namespace}.${device.connectionId}`,
                    mapping: { true: 'connected', false: 'disconnected' },
                },
            },
            hasDetails: true,
            actions: isDefault
                ? []
                : [
                      {
                          id: 'edit',
                          icon: 'settings',
                          title: editTitle,
                          handler: async (id, context) => ({
                              refresh: (await this.configureDevice(context, id)) ? 'devices' : 'none',
                          }),
                      },
                      {
                          id: 'delete',
                          icon: 'delete',
                          title: { en: 'Remove device', de: 'Gerät entfernen' },
                          handler: async (id, context) => ({
                              refresh: (await this.confirmRemoval(context, id)) ? 'devices' : 'none',
                          }),
                      },
                  ],
        };
    }

    /**
     * @param {string} id - Device identifier.
     * @returns {import('@iobroker/dm-utils').DeviceDetails<string> | { error: string }} Connection details.
     */
    getDeviceDetails(id) {
        const device = this.adapter.devices.get(id);
        if (!device) {
            return { error: 'Device no longer exists.' };
        }
        const { cloud, restApi, ip, deviceIndex, user, interval } = device.config;
        /** @type {Record<string, import('@iobroker/dm-utils').ConfigItemAny>} */
        const items = {
            mode: { type: 'text', readOnly: true, label: { en: 'Connection mode', de: 'Verbindungsart' }, sm: 6 },
            user: { type: 'text', readOnly: true, label: translate('user_label'), sm: 6 },
            interval: { type: 'number', readOnly: true, label: translate('interval_label'), sm: 6 },
            ...(cloud
                ? { deviceIndex: { type: 'number', readOnly: true, label: translate('deviceIndex_label'), sm: 6 } }
                : { ip: { type: 'text', readOnly: true, label: translate('ip_label'), sm: 6 } }),
        };
        return {
            id,
            schema: { type: 'panel', items },
            data: { mode: cloud ? 'Cloud' : restApi ? 'Local REST API' : 'Local', user, interval, deviceIndex, ip },
        };
    }

    /**
     * @param {ActionContext} context - Device Manager dialog.
     * @param {string} [id] - Device identifier when editing.
     */
    async configureDevice(context, id) {
        const device = id ? this.adapter.devices.get(id) : undefined;
        if (id && !device) {
            await context.showMessage('Device no longer exists.');
            return false;
        }
        const { cloud, restApi, ip, deviceIndex, user, interval } = device?.config ?? defaults;
        /** @type {JsonFormSchema} */
        const schema = {
            type: 'panel',
            items: {
                id: {
                    type: 'text',
                    label: { en: 'Device ID', de: 'Geräte-ID' },
                    tooltip: {
                        en: 'Used in object IDs. Start with a lowercase letter or digit. Hyphens and underscores are allowed.',
                        de: 'Wird in Objekt-IDs verwendet. Mit Kleinbuchstaben oder Ziffer beginnen. Bindestriche und Unterstriche sind erlaubt.',
                    },
                    readOnly: !!device,
                    sm: 6,
                },
                name: { type: 'text', label: { en: 'Name', de: 'Name' }, sm: 6 },
                ...fields,
                password: {
                    label: translate('password_label'),
                    type: 'password',
                    sm: 6,
                    hidden: 'data.clearPassword',
                    ...(device
                        ? {
                              tooltip: {
                                  en: 'Leave empty to keep the saved password.',
                                  de: 'Leer lassen, um das gespeicherte Passwort zu behalten.',
                              },
                          }
                        : {}),
                },
                ...(device?.config.password
                    ? {
                          clearPassword: {
                              type: 'checkbox',
                              label: { en: 'Clear saved password', de: 'Gespeichertes Passwort löschen' },
                              sm: 12,
                          },
                      }
                    : {}),
            },
        };
        const form = await context.showForm(schema, {
            data: {
                id: id ?? '',
                name: device?.name ?? '',
                cloud,
                restApi,
                ip,
                deviceIndex,
                user,
                interval,
                password: '',
                clearPassword: false,
            },
            title: device ? editTitle : addTitle,
        });
        if (!form) {
            return false;
        }

        try {
            const objectId = id ?? String(form.id ?? '').trim();
            const name = String(form.name ?? '').trim() || objectId;
            const config = this.readConfig(form, device?.config.password);
            if (device) {
                await this.adapter.editDevice(device, name, config);
            } else {
                await this.adapter.addDevice(objectId, name, config);
            }
            return true;
        } catch (error) {
            await context.showMessage(error.message);
            return false;
        }
    }

    /**
     * @param {JsonFormData} form - Submitted connection settings.
     * @param {string} [savedPassword] - Current password when editing.
     * @returns {DeviceConfig} Validated connection settings.
     */
    readConfig(form, savedPassword) {
        const cloud = form.cloud === true;
        const restApi = form.restApi === true;
        const ip = String(form.ip ?? '').trim();
        const interval = Number(form.interval);
        const deviceIndex = Number(form.deviceIndex ?? defaults.deviceIndex);
        if (!Number.isSafeInteger(interval) || interval < 1 || interval > 2_147_483) {
            throw new Error('Enter a polling interval between 1 and 2147483 seconds.');
        }
        if (cloud && (!Number.isSafeInteger(deviceIndex) || deviceIndex < 0)) {
            throw new Error('Enter a cloud device index of 0 or higher.');
        }
        if (!cloud) {
            try {
                const host = isIPv6(ip) ? `[${ip}]` : ip;
                const url = new URL(restApi ? `http://${host}` : `https://${host}:8124`);
                if (!ip || /[@/?#\\]/.test(ip) || url.username || url.password) {
                    throw new Error();
                }
            } catch {
                throw new Error('Enter the IP address or host name of the local device.');
            }
        }
        return {
            cloud,
            restApi,
            ip,
            interval,
            deviceIndex: Number.isSafeInteger(deviceIndex) && deviceIndex >= 0 ? deviceIndex : defaults.deviceIndex,
            user: String(form.user ?? defaults.user),
            password: form.clearPassword === true ? '' : String(form.password || savedPassword || ''),
        };
    }

    /**
     * @param {ActionContext} context - Device Manager confirmation dialog.
     * @param {string} id - Device to remove.
     */
    async confirmRemoval(context, id) {
        const device = this.adapter.devices.get(id);
        if (!device) {
            return false;
        }
        const confirmed = await context.showConfirmation({
            en: 'Remove this device and all of its states?',
            de: 'Dieses Gerät und alle zugehörigen Datenpunkte entfernen?',
        });
        if (!confirmed) {
            return false;
        }
        try {
            await this.adapter.removeDevice(device);
            return true;
        } catch (error) {
            await context.showMessage(error.message);
            return false;
        }
    }
}

module.exports = JudoDeviceManagement;
