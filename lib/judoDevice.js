'use strict';

const judoConv = require('./dataConverter');
const restData = require('./restData');
const axios = require('axios');
const https = require('node:https');
const { isIPv6 } = require('node:net');
const md5 = require('md5');
const defaults = require('../io-package.json').native;

const DEFAULT_DEVICE_ID = 'default';
const COMMANDS = ['WaterStop', 'Regeneration', 'ResidualHardness', 'StandBy'];
const CLOUD_RETRY_DELAY = 5 * 60_000;
const REQUEST_TIMEOUT = 60_000;

// Older local devices use a self-signed certificate.
const localAgent = new https.Agent({ rejectUnauthorized: false });

/** @typedef {Pick<ioBroker.AdapterConfig, 'cloud' | 'ip' | 'restApi' | 'deviceIndex' | 'interval' | 'user' | 'password'>} DeviceConfig */
/** @typedef {import('@iobroker/adapter-core').AdapterInstance} AdapterInstance */

/** Polls one JUDO device and owns its commands and object IDs. */
class JudoDevice {
    /**
     * @param {AdapterInstance} adapter - Adapter that owns the device objects.
     * @param {string} id - Stable device identifier.
     * @param {string} name - Device name shown in Device Manager.
     * @param {DeviceConfig} config - Connection settings for this device.
     * @param {() => Promise<void>} onConnectionChange - Updates the instance connection state.
     */
    constructor(adapter, id, name, config, onConnectionChange) {
        this.adapter = adapter;
        this.id = id;
        this.name = name;
        this.config = config;
        this.onConnectionChange = onConnectionChange;
        this.log = {
            debug: message => adapter.log.debug(`[${id}] ${message}`),
            warn: message => adapter.log.warn(`[${id}] ${message}`),
            error: message => adapter.log.error(`[${id}] ${message}`),
        };
        this.prefix = id === DEFAULT_DEVICE_ID ? '' : `${id}.`;
        this.connectionId = this.stateId('info.connection');
        this.baseUrl = this.getBaseUrl();
        const interval = Number(config.interval);
        this.interval = Math.min(interval >= 1 ? interval : defaults.interval, 2_147_483) * 1000;
        this.controller = new AbortController();
        this.connected = false;
        /** @type {string | undefined} */
        this.token = undefined;
        /** @type {string | undefined} */
        this.cloudSerialNumber = undefined;
        this.cloudDeviceAddress = undefined;
        this.cloudDeviceType = undefined;
        /** @type {number | null} */
        this.localDeviceType = null;
        this.staticInfoLoaded = false;
        this.pauseValveState = false;
        this.pauseStandBy = false;
        /** @type {ioBroker.Timeout | undefined} */
        this.pollTimer = undefined;
        this.pollTask = Promise.resolve();
        this.commandTask = Promise.resolve();
    }

    /** @param {string} id - State or channel ID within the device. */
    stateId(id) {
        return `${this.prefix}${id}`;
    }

    /**
     * @param {string} id - State ID within the device.
     * @param {ioBroker.StateValue} value - Acknowledged state value.
     * @param {boolean} ack - Whether this update acknowledges a value.
     */
    async setState(id, value, ack) {
        if (!this.controller.signal.aborted) {
            await this.adapter.setStateAsync(this.stateId(id), value, ack);
        }
    }

    /**
     * @param {string} id - Object ID within the device.
     * @param {ioBroker.PartialObject} object - Object to create or extend.
     */
    async extendObjectAsync(id, object) {
        if (!this.controller.signal.aborted) {
            await this.adapter.extendObjectAsync(this.stateId(id), object);
        }
    }

    /** Creates the device objects before polling starts. */
    async initialize() {
        if (this.prefix) {
            await this.extendObjectAsync('info', { type: 'channel', common: { name: 'Information' }, native: {} });
            await this.extendObjectAsync('info.connection', {
                type: 'state',
                common: {
                    name: 'Device connection',
                    type: 'boolean',
                    role: 'indicator.connected',
                    read: true,
                    write: false,
                    def: false,
                },
                native: {},
            });
            await this.setState('info.connection', false, true);
        }
        await this.createStates();
    }

    /** Starts a poll and tracks it so shutdown can drain it. */
    start() {
        this.pollTask = this.poll().catch(() => {
            this.log.error(`Could not update device status`);
        });
    }

    /** Cancels future work and waits for current writes to finish. */
    async stop() {
        this.controller.abort();
        if (this.pollTimer) {
            this.adapter.clearTimeout(this.pollTimer);
            this.pollTimer = undefined;
        }
        await Promise.all([this.pollTask, this.commandTask]);
    }

    /** Polls once, then schedules the next poll for this device. */
    async poll() {
        if (this.controller.signal.aborted) {
            return;
        }
        let delay = this.interval;
        try {
            if (!this.isRestApiMode() && !this.token) {
                await this.login();
            }

            if (this.isCloudMode()) {
                await this.getInfosCloud();
            } else if (this.isRestApiMode()) {
                if (!this.staticInfoLoaded) {
                    await this.getInfoStaticLocalRest();
                }
                await this.getInfosLocalRest();
            } else {
                if (!this.staticInfoLoaded) {
                    await this.getInfoStaticLocal();
                    this.staticInfoLoaded = true;
                }
                await this.getInfosLocal();
            }
        } catch {
            if (!this.controller.signal.aborted) {
                this.token = undefined;
                delay = this.isCloudMode() ? CLOUD_RETRY_DELAY : this.interval;
                await this.setConnected(false);
                this.log.warn(`Poll failed. Retrying in ${delay / 1000} seconds.`);
            }
        } finally {
            if (!this.controller.signal.aborted) {
                this.pollTimer = this.adapter.setTimeout(() => this.start(), delay);
            }
        }
    }

    /** @param {boolean} connected - Whether polling reached the device in its configured mode. */
    async setConnected(connected) {
        if (this.controller.signal.aborted || (this.prefix && this.connected === connected)) {
            return;
        }
        this.connected = connected;
        if (this.prefix) {
            await this.setState('info.connection', connected, true);
        }
        await this.onConnectionChange();
    }

    /**
     * @param {string} command - Device command.
     * @param {ioBroker.StateValue} value - Requested value.
     */
    handleCommand(command, value) {
        if (!COMMANDS.includes(command) || (command === 'StandBy' && this.isRestApiMode())) {
            return this.commandTask;
        }
        this.commandTask = this.commandTask
            .then(async () => {
                if (this.controller.signal.aborted) {
                    return;
                }
                try {
                    if (this.isRestApiMode()) {
                        await this.setCommandStateLocalRest(command, value);
                    } else if (this.isCloudMode()) {
                        if (this.token && this.cloudSerialNumber) {
                            await this.setCommandStateCloud(command, value);
                        }
                    } else if (this.token) {
                        await this.setCommandStateLocal(command, value);
                    }
                } finally {
                    this.pauseValveState = false;
                    this.pauseStandBy = false;
                }
            })
            .catch(() => {
                if (!this.controller.signal.aborted) {
                    this.log.error(`${command} failed`);
                }
            });
        return this.commandTask;
    }

    /** Builds the endpoint for the configured connection mode. */
    getBaseUrl() {
        if (this.isCloudMode()) {
            return 'https://www.myjudo.eu/interface/';
        }
        const address = this.config.ip;
        const host = isIPv6(address) ? `[${address}]` : address;
        return this.isRestApiMode() ? `http://${host}/api/rest/` : `https://${host}:8124/?group=`;
    }

    /** Whether to use the JUDO cloud. */
    isCloudMode() {
        return !!this.config.cloud;
    }

    /** Whether to use the local REST interface. */
    isRestApiMode() {
        return !!this.config.restApi && !this.isCloudMode();
    }

    /** Reads version and service details from the legacy local interface. */
    async getInfoStaticLocal() {
        this.log.debug('get Information Static Local');
        try {
            const soft = await this.getAxiosData(
                `${this.baseUrl}version&command=software%20version&msgnumber=1&token=${this.token}`,
            ); //SoftwareVersion
            await this.setState('SoftwareVersion', soft.data.data, true);
        } catch {
            this.log.error('SoftwareVersion ERROR ');
        }

        try {
            const hard = await this.getAxiosData(
                `${this.baseUrl}version&command=hardware%20version&msgnumber=1&token=${this.token}`,
            ); //HardwareVersion
            await this.setState('HardwareVersion', hard.data.data, true);
        } catch {
            this.log.error('HardwareVersion ERROR ');
        }

        try {
            const instDat = await this.getAxiosData(
                `${this.baseUrl}contract&command=init%20date&msgnumber=1&token=${this.token}`,
            ); //InstallationDate
            await this.setState('InstallationDate', Number(instDat.data.data) * 1000, true);
        } catch {
            this.log.error('InstallationDate ERROR ');
        }

        try {
            const servDat = await this.getAxiosData(
                `${this.baseUrl}contract&command=service%20date&msgnumber=1&token=${this.token}`,
            ); //ServiceDate
            await this.setState('ServiceDate', Number(servDat.data.data) * 1000, true);
        } catch {
            this.log.error('ServiceDate ERROR ');
        }
    }

    /** Reads the selected device from the cloud account. */
    async getInfosCloud() {
        this.log.debug(`get Consumption data Cloud`);
        const getDeviceData = () =>
            this.getAxiosData(`${this.baseUrl}?token=${this.token}&group=register&command=get%20device%20data`);
        let { data } = await getDeviceData();
        if (!this.isLoggedIn(data)) {
            await this.login();
            ({ data } = await getDeviceData());
        }
        if (!this.isLoggedIn(data) || !Array.isArray(data.data) || !data.data.length) {
            throw new Error('No devices found in cloud account');
        }

        const deviceIndex = Number(this.config.deviceIndex || 0);
        // Preserve the selection used by existing installations for an out-of-range index.
        const index = this.prefix ? deviceIndex : Math.max(0, Math.min(deviceIndex, data.data.length - 1));
        if (index !== deviceIndex) {
            this.log.warn(`Cloud device index ${deviceIndex} is out of range. Using index ${index}.`);
        }
        const device = data.data[index];
        const cloudData = device?.data?.[0];
        const registers = cloudData?.data;
        if (!device?.serialnumber || !registers) {
            throw new Error(`Cloud device index ${deviceIndex} is unavailable`);
        }

        let result;
        this.cloudSerialNumber = String(device.serialnumber);
        await this.setState('SerialNumber', this.cloudSerialNumber, true);
        this.log.debug('-> SerialNumber');

        await this.setState('SoftwareVersion', judoConv.getInValue(registers, '1'), true);
        this.log.debug('-> SoftwareVersion');
        await this.setState('HardwareVersion', judoConv.getInValue(registers, '2'), true);
        this.log.debug('-> HardwareVersion');

        this.cloudDeviceAddress = cloudData.da;
        this.log.debug(`-> this.cloudDeviceAddress ${this.cloudDeviceAddress}`);
        this.cloudDeviceType = cloudData.dt;
        this.log.debug(`-> this.cloudDeviceType ${this.cloudDeviceType}`);

        // InstallationDate
        result = judoConv.getInValue(registers, '6');
        this.log.debug(`-> InstallationDate ${result}`);
        await this.setState('InstallationDate', Number(result), true);

        // service
        const rServiceDays = String(judoConv.getInValue(registers, '6')).split(':')[0];
        await this.setState('ServiceDays', Number(rServiceDays), true);
        this.log.debug(`-> ServiceDays ${rServiceDays}`);

        await this.setState('Connection status', device.status === 'true', true);

        //Maintenance
        const rMaintenance = String(judoConv.getInValue(registers, '7')).split(':')[0];
        await this.setState(`Maintenance`, Number(rMaintenance), true);
        this.log.debug(`-> Maintenance ${rMaintenance}`);

        //WaterTotal
        result = judoConv.getInValue(registers, '8');
        await this.setState(`WaterTotal`, result, true);

        result = judoConv.getInValue(registers, '9');
        await this.setState(`WaterTotalOut`, result, true);
        this.log.debug('-> WaterTotal');

        //SaltRange
        const saltData = String(judoConv.getInValue(registers, '94'));
        let salzstand_rounded = 0;
        let reichweite = 0;
        let salzstand = 0;

        if (saltData.includes(':')) {
            reichweite = Math.round(Number(saltData.split(':')[1]));
            salzstand = Number(saltData.split(':')[0]) / 1000;
            salzstand_rounded = 5 * Math.ceil(salzstand / 5);

            if (reichweite > 1) {
                await this.setState(`SaltRange`, Number(reichweite), true);
            } else {
                await this.setState(`SaltRange`, Number(salzstand_rounded), true);
            }
        }

        this.log.debug('-> SaltRange');

        // NaturalHardness
        //    result = parseInt(judoConv.getInValue(registers, '790_26')/2)+2;
        result = 0;
        await this.setState(`NaturalHardness`, Number(result), true);
        this.log.debug('-> NaturalHardness');

        //ResidualHardness
        result = judoConv.getInValue(registers, '790_8');
        await this.setState(`ResidualHardness`, Number(result), true);
        this.log.debug('-> ResidualHardness');

        //SaltQuantity
        let sq = (salzstand_rounded * 100) / 50;
        if (sq > 100) {
            sq = 100;
        }

        await this.setState(`SaltQuantity`, Number(sq), true);
        this.log.debug('-> SaltQuantity');

        //WaterCurrent
        result = judoConv.getInValue(registers, '790_1617');
        await this.setState(`WaterCurrent`, Number(result), true);
        this.log.debug('-> WaterCurrent');

        //StandByValue
        result = judoConv.getInValue(registers, '792_9');
        await this.setState(`StandByValue`, Number(result), true);
        this.log.debug(`-> StandByValue${result}`);

        //Battery
        result = judoConv.getInValue(registers, '93');
        if (typeof result === 'string' && result.includes(':')) {
            const batt = result.split(':');
            await this.setState(`Battery`, Number(batt[0]), true);
            this.log.debug(`-> Battery${batt[0]}`);
        }

        // Cloud Register 137 mirrors local REST command 4300 on this i-dos eco.
        const statusDataHexCloud = registers[137]?.data;
        if (typeof statusDataHexCloud === 'string') {
            const statusData = restData.decodeStatusData(statusDataHexCloud);
            if (statusData) {
                await this.setState('StatusData.RemainingAmountInTank', statusData.remainingAmountInTank, true);
                await this.setState(
                    'StatusData.RemainingAmountInTankPercent',
                    statusData.remainingAmountInTankPercent,
                    true,
                );
                await this.setState('StatusData.Raw', statusDataHexCloud, true);
            }
        }

        await this.setState('lastInfoUpdate', Date.now(), true);
        await this.setConnected(true);
    }

    /** Reads current values from the legacy local interface. */
    async getInfosLocal() {
        this.log.debug(`get Consumption data Local`);

        const stats = await this.getAxiosData(
            `${this.baseUrl}register&command=plumber%20address&msgnumber=1&token=${this.token}`,
        );
        if (stats.data.status === 'error') {
            await this.login();
        }

        let result;
        //WaterCurrent
        result = await this.getAxiosData(
            `${this.baseUrl}consumption&command=water%20current&msgnumber=1&token=${this.token}`,
        );
        const splWassCur = result.data.data.split(' ');
        await this.setState(`WaterCurrent`, Number(splWassCur[0]), true);
        await this.setState(`WaterCurrentOut`, Number(splWassCur[1]), true);
        this.log.debug('-> WaterCurrent');

        //ResidualHardness
        result = await this.getAxiosData(
            `${this.baseUrl}settings&command=residual%20hardness&msgnumber=1&token=${this.token}`,
        );
        await this.setState(`ResidualHardness`, Number(result.data.data), true);
        this.log.debug('-> ResidualHardness');

        //SaltRange
        result = await this.getAxiosData(
            `${this.baseUrl}consumption&command=salt%20range&msgnumber=1&token=${this.token}`,
        );
        await this.setState(`SaltRange`, Number(result.data.data), true);

        this.log.debug('-> SaltRange');

        //SaltQuantity
        result = await this.getAxiosData(
            `${this.baseUrl}consumption&command=salt%20quantity&msgnumber=1&token=${this.token}`,
        );
        let sq = result.data.data;
        sq = Math.round((sq / 50000) * 100);

        await this.setState(`SaltQuantity`, Number(sq), true);
        this.log.debug('-> SaltQuantity');

        //WaterAverage
        result = await this.getAxiosData(
            `${this.baseUrl}consumption&command=water%20average&msgnumber=1&token=${this.token}`,
        );
        await this.setState(`WaterAverage`, Number(result.data.data), true);
        this.log.debug('-> WaterAverage');

        //NaturalHardness
        result = await this.getAxiosData(
            `${this.baseUrl}info&command=natural%20hardness&msgnumber=1&token=${this.token}`,
        );
        await this.setState(`NaturalHardness`, Number(result.data.data), true);
        this.log.debug('-> NaturalHardness');

        //FlowRate
        result = await this.getAxiosData(
            `${this.baseUrl}waterstop&command=flow%20rate&msgnumber=1&token=${this.token}`,
        );
        await this.setState(`FlowRate`, Number(result.data.data), true);
        this.log.debug('-> FlowRate');

        //Quantity
        result = await this.getAxiosData(`${this.baseUrl}waterstop&command=quantity&msgnumber=1&token=${this.token}`);
        await this.setState(`Quantity`, Number(result.data.data), true);
        this.log.debug('-> Quantity');

        //WaterTotal
        result = await this.getAxiosData(
            `${this.baseUrl}consumption&command=water%20total&msgnumber=1&token=${this.token}`,
        );

        const splWassTot = result.data.data.split(' ');
        await this.setState(`WaterTotal`, splWassTot[1] / 1000, true);
        await this.setState(`WaterTotalOut`, splWassTot[2] / 1000, true);
        this.log.debug(`-> WaterTotaal ${result.data.data}`);

        //WaterYearly
        result = await this.getAxiosData(
            `${this.baseUrl}consumption&command=water%20yearly&msgnumber=1&token=${this.token}`,
        );
        const splWassJahr = result.data.data.split(' ');
        for (let b = 1; b < 13; b++) {
            const a = String(b).padStart(2, '0');

            let monat = splWassJahr[b];

            this.log.debug(`WaterYearly.${a} ${monat} ${splWassJahr[b]}`);

            if (monat > 0) {
                monat = monat / 1000;
            } else {
                monat = 0;
            }

            await this.setState(`WaterYearly.${a}`, monat, true);
        }
        this.log.debug('-> WaterYearly');

        if (!this.pauseStandBy) {
            //StandBy
            result = await this.getAxiosData(
                `${this.baseUrl}waterstop&command=standby&msgnumber=1&token=${this.token}`,
            );
            await this.setState(`StandByValue`, Number(result.data.data), true);
            this.log.debug('-> StandBy');
        }

        if (!this.pauseValveState) {
            //ValveState
            result = await this.getAxiosData(`${this.baseUrl}waterstop&command=valve&msgnumber=1&token=${this.token}`);
            await this.setState(`WaterStopStatus`, result.data.data, true);

            if (result.data.data == 'opened') {
                await this.setState(`WaterStop`, false, true);
            } else {
                await this.setState(`WaterStop`, true, true);
            }

            this.log.debug('-> ValveState');
        }
        await this.setState('lastInfoUpdate', Date.now(), true);
        await this.setConnected(true);
    }

    /**
     * Issues a command on the connectivity module.
     *
     * @param {string} commandHex - Command code in hexadecimal.
     * @param {string} [dataHex] - Optional command payload in hexadecimal.
     */
    async callRestApi(commandHex, dataHex = '') {
        const command = restData.normalizeHexString(commandHex);
        const data = restData.normalizeHexString(dataHex);
        const response = await this.getAxiosData(`${this.baseUrl}${command}${data}`);
        return response;
    }

    /** @param {string} commandHex - Register read command in hexadecimal. */
    async getRestData(commandHex) {
        try {
            const response = await this.callRestApi(commandHex);
            return restData.getRestPayloadData(response.data);
        } catch (error) {
            if (axios.isAxiosError(error) && [400, 404].includes(error.response?.status ?? 0)) {
                // Some models do not support every register.
                return null;
            }
            throw error;
        }
    }

    /** Reads model and version details from the connectivity module. */
    async getInfoStaticLocalRest() {
        this.log.debug(`get Information Static Local REST`);

        const deviceTypeHex = await this.getRestData('FF00');
        const deviceType = restData.decodeWtuType(deviceTypeHex);
        this.localDeviceType = deviceType.num;
        this.log.debug(`-> deviceType ${JSON.stringify(deviceType)} (${deviceTypeHex})`);
        await this.setState('wtuType', deviceType.text, true);

        const serialNumberHex = await this.getRestData('0600');
        const serialNumber = restData.decodeSerialNumber(serialNumberHex);
        this.log.debug(`-> serialNumber ${serialNumber} (${serialNumberHex})`);
        await this.setState('SerialNumber', serialNumber, true);

        const softwareVersionHex = await this.getRestData('0100');
        const softwareVersion = restData.decodeSoftwareVersion(softwareVersionHex);
        this.log.debug(`-> softwareVersion ${softwareVersion} (${softwareVersionHex})`);
        await this.setState('SoftwareVersion', softwareVersion, true);

        const instDateHex = await this.getRestData('0E00');
        const instDate = restData.decodeCommissioningDate(instDateHex);
        this.log.debug(`-> InstallationDate: ${instDate} (${instDateHex})`);
        await this.setState('InstallationDate', instDate, true);

        if (this.localDeviceType === 0x41) {
            await this.createIdosEcoStates();
        }
        this.staticInfoLoaded = !!deviceTypeHex;
    }

    /** Creates additional objects for i-dos eco devices. */
    async createIdosEcoStates() {
        /*
            Statusdaten abfragen
         */

        await this.extendObjectAsync(`StatusData`, {
            type: 'channel',
            common: {
                name: `WaterYearly`,
            },
            native: {},
        });

        // provide the full response of /api/rest/4300 as expert object. no real docs what all those values actually mean ...
        await this.extendObjectAsync(`StatusData.Raw`, {
            type: 'state',
            common: {
                name: `Raw value of status StatusData query`,
                type: 'string',
                read: true,
                write: false,
                expert: true,
            },
            native: {},
        });

        await this.extendObjectAsync(`StatusData.CircuitType`, {
            type: 'state',
            common: {
                name: `Schaltungstyp`,
                type: 'string',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.extendObjectAsync(`StatusData.OperatingMode`, {
            type: 'state',
            common: {
                name: `Betriebsmodus`,
                type: 'string',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.extendObjectAsync(`StatusData.Concentration`, {
            type: 'state',
            common: {
                name: `Konzentration (min, Norm, max)`,
                type: 'string',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.extendObjectAsync(`StatusData.ErrorCode`, {
            type: 'state',
            common: {
                name: `Fehlercode`,
                type: 'string',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.extendObjectAsync(`StatusData.Warnings`, {
            type: 'state',
            common: {
                name: `Warnmeldungen`,
                type: 'string',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.extendObjectAsync(`StatusData.DosingAmount`, {
            type: 'state',
            common: {
                name: `Dosiermenge`,
                type: 'string',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.extendObjectAsync(`StatusData.DosingAmount`, {
            type: 'state',
            common: {
                name: `Dosiermenge`,
                type: 'string',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.extendObjectAsync(`StatusData.CurrentWaterFlow`, {
            type: 'state',
            common: {
                name: `Wasserdurchfluss`,
                type: 'string',
                read: true,
                write: false,
                unit: 'l/h',
            },
            native: {},
        });

        await this.extendObjectAsync(`StatusData.RemainingAmountInTank`, {
            type: 'state',
            common: {
                name: `Restmenge im Behälter`,
                type: 'number',
                read: true,
                write: false,
                unit: 'l',
            },
            native: {},
        });

        await this.extendObjectAsync(`StatusData.RemainingAmountInTankPercent`, {
            type: 'state',
            common: {
                name: `Restmenge im Behälter (%)`,
                type: 'number',
                read: true,
                write: false,
                unit: '%',
            },
            native: {},
        });

        await this.extendObjectAsync(`StatusData.WaterConsumption`, {
            type: 'state',
            common: {
                name: `Wasserverbrauch`,
                type: 'string',
                read: true,
                write: false,
                unit: 'l',
            },
            native: {},
        });

        /*
            Dosierung lesen
         */

        await this.extendObjectAsync(`Dosage`, {
            type: 'channel',
            common: {
                name: `Dosierung`,
            },
            native: {},
        });

        // provide the full response of /api/rest/6300 as expert object. no real docs what all those values actually mean ...
        await this.extendObjectAsync(`Dosage.Raw`, {
            type: 'state',
            common: {
                name: `Raw value of status DosData query`,
                type: 'string',
                read: true,
                write: false,
                expert: true,
            },
            native: {},
        });
    }

    /** Polls current registers from the connectivity module. */
    async getInfosLocalRest() {
        this.log.debug('get Consumption data Local REST');
        let connected = false;

        const read = async commandHex => {
            const data = await this.getRestData(commandHex);
            if (data) {
                connected = true;
            }
            return data;
        };

        /*
            tested with own devices
         */

        const runtimeHex = await read('2500');
        const runtimeHours = restData.decodeRuntimeCounter(runtimeHex);
        this.log.debug(`-> OperatingHours ${runtimeHours} (${runtimeHex})`);
        await this.setState('OperatingHours', runtimeHours, true);

        const softWaterHex = await read('2900');
        const softWater = restData.decodeSoftWaterAmount(softWaterHex);
        this.log.debug(`-> SoftWater ${softWater} (${softWaterHex})`);
        await this.setState('WaterTotalOut', softWater, true);

        const yearHex = restData.formatYearToHex(new Date().getFullYear());
        const yearlyWaterHex = await read(`FE00${yearHex}`);
        const yearlyWater = restData.decodeYearlyStatistics(yearlyWaterHex);
        this.log.debug(`-> WaterYearly ${JSON.stringify(yearlyWater)} (${yearlyWaterHex})`);
        if (yearlyWater) {
            for (const [month, monthValue] of Object.entries(yearlyWater)) {
                const id = month.toString().padStart(2, '0');
                await this.setState(`WaterYearly.${id}`, monthValue, true);
            }
        }

        const totalWaterHex = await read('2800');
        const totalWater = restData.decodeTotalWaterAmount(totalWaterHex);
        this.log.debug(`-> WaterTotal ${totalWater} (${totalWaterHex})`);
        await this.setState('WaterTotal', totalWater, true);

        const dateTimeHex = await read('6100');
        const dateTime = restData.decodeDateTime(dateTimeHex);
        this.log.debug(`-> Date ${dateTime} (${dateTimeHex})`);
        await this.setState('Date', dateTime, true);

        if (this.localDeviceType === 0x41) {
            const statusDataHex = await read('4300'); // data that must be fetched only on i-dos eco device as connectivity module would return 400 error on other devices
            const statusData = restData.decodeStatusData(statusDataHex);
            this.log.debug(`-> StatusData ${JSON.stringify(statusData)} (${statusDataHex})`);
            if (statusDataHex) {
                await this.setState('StatusData.Raw', statusDataHex, true);
            }
            // TODO: figure out what all those values actually mean -> possibly provide better type / role (and add corresponding test)
            // one response got from device: 0200010300000000010000000000000000f3001c0000000000825f0000
            if (statusData) {
                await this.setState('StatusData.CircuitType', statusData.circuitType, true);
                await this.setState('StatusData.OperatingMode', statusData.operatingMode, true);
                await this.setState('StatusData.Concentration', statusData.concentration, true);
                await this.setState('StatusData.ErrorCode', statusData.errorCode, true);
                await this.setState('StatusData.Warnings', statusData.warnings, true);
                await this.setState('StatusData.DosingAmount', statusData.dosingAmount, true);
                await this.setState('StatusData.CurrentWaterFlow', statusData.currentWaterFlow, true);
                await this.setState('StatusData.RemainingAmountInTank', statusData.remainingAmountInTank, true);
                await this.setState(
                    'StatusData.RemainingAmountInTankPercent',
                    statusData.remainingAmountInTankPercent,
                    true,
                );
                await this.setState('StatusData.WaterConsumption', statusData.waterConsumption, true);
            }

            const dosageHex = await read('6300');
            const dosage = restData.decodeDosage(dosageHex);
            // TODO: figure out what all those values actually mean (and add corresponding test)
            // one response got from device: 0102
            this.log.debug(`-> Dosage ${JSON.stringify(dosage)} (${dosageHex})`);
            if (dosageHex) {
                await this.setState('Dosage.Raw', dosageHex, true);
            }
        }

        /*
            based on docs:
         */

        const residualHardnessHex = await read('5100');
        if (residualHardnessHex) {
            const residualHardness = restData.hexLeToNumber(residualHardnessHex);
            if (residualHardness !== null) {
                await this.setState('ResidualHardness', residualHardness, true);
            }
        }

        const saltHex = await read('5600');
        if (saltHex && saltHex.length >= 8) {
            const saltGramm = restData.hexLeToNumber(saltHex.slice(0, 4));
            const saltRangeDays = restData.hexLeToNumber(saltHex.slice(4, 8));
            if (saltRangeDays !== null) {
                await this.setState('SaltRange', saltRangeDays, true);
            }
            if (saltGramm !== null) {
                const saltPercent = Math.min(100, Math.round((saltGramm / 50000) * 100));
                await this.setState('SaltQuantity', saltPercent, true);
            }
        }

        if (connected) {
            await this.setState('lastInfoUpdate', Date.now(), true);
        }
        await this.setConnected(connected);
    }

    /**
     * Sends a command to the connectivity module.
     *
     * @param {string} command - Name of the writable state.
     * @param {ioBroker.StateValue} state - Requested state value.
     */
    async setCommandStateLocalRest(command, state) {
        try {
            switch (command) {
                case 'Regeneration':
                    this.log.debug(`set Regeneration Local REST ${state}`);
                    if (state) {
                        await this.callRestApi('350000');
                    }
                    break;
                case 'WaterStop':
                    this.log.debug(`set WaterStop Local REST ${state}`);
                    this.pauseValveState = true;
                    if (state) {
                        await this.callRestApi('3C00');
                        await this.setState('WaterStopStatus', 'closed', true);
                    } else {
                        await this.callRestApi('3D00');
                        await this.setState('WaterStopStatus', 'opened', true);
                    }
                    this.pauseValveState = false;
                    break;
                case 'ResidualHardness':
                    this.log.debug(`set ResidualHardness Local REST ${state}`);
                    await this.callRestApi(`3000${restData.toHexByte(state)}`);
                    break;
                default:
                    break;
            }
        } catch {
            this.pauseValveState = false;
            this.pauseStandBy = false;
            this.log.error(`setCommandStateLocalRest ${command} ERROR`);
        }
    }

    /**
     * Sends a command for the selected cloud device.
     *
     * @param {string} command - Name of the writable state.
     * @param {ioBroker.StateValue} state - Requested state value.
     */
    async setCommandStateCloud(command, state) {
        switch (command) {
            case 'Regeneration':
                this.log.debug(`set Regeneration Cloud ${state}`);
                await this.getAxiosData(
                    `${this.baseUrl}?token=${this.token}&group=register&command=write%20data&serial_number=${
                        this.cloudSerialNumber
                    }&dt=${this.cloudDeviceType}&index=65&data=&da=${this.cloudDeviceAddress}&role=customer`,
                );
                break;
            case 'WaterStop':
                this.log.debug(`set WaterStop Cloud${state}`);
                this.pauseValveState = true; // fÃ¼r getInfo

                if (state) {
                    const val = await this.getAxiosData(
                        `${this.baseUrl}?token=${this.token}&group=register&command=write%20data&serial_number=${
                            this.cloudSerialNumber
                        }&dt=${this.cloudDeviceType}&index=72&data=&da=${this.cloudDeviceAddress}&role=customer`,
                    );
                    await this.setState('WaterStopStatus', val.data.status, true);
                } else {
                    const val = await this.getAxiosData(
                        `${this.baseUrl}?token=${this.token}&group=register&command=write%20data&serial_number=${
                            this.cloudSerialNumber
                        }&dt=${this.cloudDeviceType}&index=73&data=&da=${this.cloudDeviceAddress}&role=customer`,
                    );
                    await this.setState('WaterStopStatus', val.data.status, true);
                }
                this.pauseValveState = false;

                break;
            case 'StandBy':
                this.log.debug(`set StandBy Cloud${state}`);
                this.pauseStandBy = true; // fÃ¼r getInfo
                if (state) {
                    await this.getAxiosData(
                        `${this.baseUrl}?token=${this.token}&group=register&command=write%20data&serial_number=${
                            this.cloudSerialNumber
                        }&dt=${this.cloudDeviceType}&index=171&data=&da=${this.cloudDeviceAddress}&role=customer`,
                    );
                } else {
                    await this.getAxiosData(
                        `${this.baseUrl}?token=${this.token}&group=register&command=write%20data&serial_number=${
                            this.cloudSerialNumber
                        }&dt=${this.cloudDeviceType}&index=73&data=&da=${this.cloudDeviceAddress}&role=customer`,
                    );
                }
                this.pauseStandBy = false;

                break;
            case 'ResidualHardness':
                this.log.debug(`set ResidualHardness Cloud ${state}`);
                await this.getAxiosData(
                    `${this.baseUrl}?token=${this.token}&group=register&command=write%20data&serial_number=${
                        this.cloudSerialNumber
                    }&dt=${this.cloudDeviceType}&index=60&data=${state}&da=${this.cloudDeviceAddress}&role=customer`,
                );
                break;
            default:
        }
    }

    /**
     * Sends a command to the legacy local interface.
     *
     * @param {string} command - Name of the writable state.
     * @param {ioBroker.StateValue} state - Requested state value.
     */
    async setCommandStateLocal(command, state) {
        switch (command) {
            case 'Regeneration':
                this.log.debug(`set Regeneration Local ${state}`);
                try {
                    await this.getAxiosData(
                        `${this.baseUrl}settings&command=regeneration&msgnumber=1&token=${this.token}&parameter=start`,
                    );
                } catch {
                    this.log.error('set Regeneration Local ERROR');
                }
                break;
            case 'WaterStop':
                this.log.debug(`set WaterStop Local${state}`);
                this.pauseValveState = true; // fÃ¼r getInfo
                if (state) {
                    try {
                        const val = await this.getAxiosData(
                            `${this.baseUrl}waterstop&command=valve&msgnumber=1&token=${this.token}&parameter=close`,
                        );
                        await this.setState('WaterStopStatus', val.data.parameter, true);
                    } catch {
                        await this.setState('WaterStopStatus', 'close', true);
                        this.log.error('set WaterStopStatus close ERROR');
                    }
                } else {
                    try {
                        const val = await this.getAxiosData(
                            `${this.baseUrl}waterstop&command=valve&msgnumber=1&token=${this.token}&parameter=open`,
                        );
                        await this.setState('WaterStopStatus', val.data.parameter, true);
                    } catch {
                        await this.setState('WaterStopStatus', 'open', true);
                        this.log.error('set WaterStopStatus open ERROR');
                    }
                }
                this.pauseValveState = false;

                break;
            case 'StandBy':
                this.log.debug(`set StandBy Local${state}`);
                this.pauseStandBy = true; // fÃ¼r getInfo
                if (state) {
                    try {
                        await this.getAxiosData(
                            `${this.baseUrl}waterstop&command=standby&msgnumber=1&token=${this.token}&parameter=start`,
                        );
                    } catch {
                        this.log.error('set StandBy Local start ERROR');
                    }
                } else {
                    try {
                        await this.getAxiosData(
                            `${this.baseUrl}waterstop&command=standby&msgnumber=1&token=${this.token}&parameter=stop`,
                        );
                    } catch {
                        this.log.error('set StandBy Local stop ERROR');
                    }
                }
                //StandByValue
                {
                    const valSt = await this.getAxiosData(
                        `${this.baseUrl}waterstop&command=standby&msgnumber=1&token=${this.token}`,
                    );
                    await this.setState(`StandByValue`, Number(valSt.data.data), true);
                }
                this.pauseStandBy = false;

                break;
            case 'ResidualHardness':
                this.log.debug(`set ResidualHardness Local${state}`);
                try {
                    await this.getAxiosData(
                        `${this.baseUrl}settings&command=residual%20hardness&msgnumber=1&token=${this.token}&parameter=${
                            state
                        }`,
                    );
                } catch {
                    this.log.error('set ResidualHardness Local ERROR');
                }
                break;
            default:
        }
    }

    /** @param {{ status?: string } | null} data - Response from the JUDO API. */
    isLoggedIn(data) {
        return data?.status === 'online' || data?.status === 'ok';
    }

    /** Obtains the token and selects the device for a legacy local session. */
    async login() {
        const cloud = this.isCloudMode();
        const user = encodeURIComponent(this.config.user);
        const password = encodeURIComponent(cloud ? md5(this.config.password) : this.config.password);
        const endpoint = cloud ? '?group=' : '';
        const cloudParameter = cloud ? '&nohash=Service' : '';
        const { data } = await this.getAxiosData(
            `${this.baseUrl}${endpoint}register&command=login&msgnumber=1&name=login&user=${user}&password=${password}${cloudParameter}&role=customer`,
        );

        if (!this.isLoggedIn(data) || !data.token) {
            await this.setState('Connection status', false, true);
            throw new Error('Login failed');
        }
        const token = data.token;
        if (!cloud) {
            const { data: result } = await this.getAxiosData(
                `${this.baseUrl}register&command=show&msgnumber=2&token=${token}`,
            );
            const device = result.data[0];
            const deviceType = device.wtuType;
            const serialNumber = device['serial number'];
            const { data: connection } = await this.getAxiosData(
                `${this.baseUrl}register&command=connect&msgnumber=1&token=${token}&parameter=${deviceType}&serial%20number=${serialNumber}`,
            );
            await this.setState('wtuType', deviceType, true);
            await this.setState('SerialNumber', serialNumber, true);
            await this.setState('Connection status', connection.status === 'true', true);
        }
        this.token = token;
        await this.setState('token', token, true);
    }

    /** @param {string} url - URL for the cancellable device request. */
    async getAxiosData(url) {
        this.controller.signal.throwIfAborted();
        return axios({
            url,
            method: 'GET',
            timeout: REQUEST_TIMEOUT,
            signal: this.controller.signal,
            headers: { 'User-Agent': 'Mozilla' },
            ...(this.isRestApiMode()
                ? { auth: { username: this.config.user, password: this.config.password } }
                : this.isCloudMode()
                  ? {}
                  : { httpsAgent: localAgent }),
        });
    }

    /** Creates the existing state layout for the configured connection mode. */
    async createStates() {
        this.log.debug(`create state`);

        if (!this.isRestApiMode()) {
            await this.extendObjectAsync(`token`, {
                type: 'state',
                common: {
                    name: `token`,
                    type: 'string',
                    read: true,
                    write: false,
                    role: 'info',
                },
                native: {},
            });
        }

        await this.extendObjectAsync(`lastInfoUpdate`, {
            type: 'state',
            common: {
                name: 'Date/Time of last information update',
                type: 'number',
                role: 'value.time',
                read: true,
                write: false,
            },
            native: {},
        });

        if (!this.isRestApiMode()) {
            if (this.isCloudMode()) {
                await this.extendObjectAsync(`ServiceDays`, {
                    type: 'state',
                    common: {
                        name: `ServiceDays`,
                        type: 'number',
                        role: 'info',
                        read: true,
                        write: false,
                    },
                    native: {},
                });
            } else {
                await this.extendObjectAsync(`ServiceDate`, {
                    type: 'state',
                    common: {
                        name: `ServiceDate`,
                        type: 'number',
                        role: 'value.time',
                        read: true,
                        write: false,
                    },
                    native: {},
                });
            }
        }

        await this.extendObjectAsync(`InstallationDate`, {
            type: 'state',
            common: {
                name: `InstallationDate`,
                type: 'number',
                role: 'value.time',
                read: true,
                write: false,
            },
            native: {},
        });

        if (this.isRestApiMode()) {
            await this.extendObjectAsync(`OperatingHours`, {
                type: 'state',
                common: {
                    name: `OperatingHours`,
                    type: 'number',
                    role: 'info',
                    unit: 'h',
                    read: true,
                    write: false,
                },
                native: {},
            });
        }

        if (this.isCloudMode()) {
            await this.extendObjectAsync(`Battery`, {
                type: 'state',
                common: {
                    name: `Battery`,
                    type: 'number',
                    read: true,
                    write: false,
                    def: 0,
                    role: 'info',
                    unit: '%',
                },
                native: {},
            });

            // Cloud register 137 contains i-dos eco status payload.
            await this.extendObjectAsync(`StatusData`, {
                type: 'channel',
                common: {
                    name: `StatusData`,
                },
                native: {},
            });

            await this.extendObjectAsync(`StatusData.Raw`, {
                type: 'state',
                common: {
                    name: `Raw value of cloud status data`,
                    type: 'string',
                    read: true,
                    write: false,
                    expert: true,
                },
                native: {},
            });

            await this.extendObjectAsync(`StatusData.RemainingAmountInTank`, {
                type: 'state',
                common: {
                    name: `Restmenge im Behälter`,
                    type: 'number',
                    read: true,
                    write: false,
                    unit: 'l',
                },
                native: {},
            });

            await this.extendObjectAsync(`StatusData.RemainingAmountInTankPercent`, {
                type: 'state',
                common: {
                    name: `Restmenge im Behälter (%)`,
                    type: 'number',
                    read: true,
                    write: false,
                    unit: '%',
                },
                native: {},
            });
        }

        if (this.isCloudMode()) {
            await this.extendObjectAsync(`WaterCurrent`, {
                type: 'state',
                common: {
                    name: `WaterCurrent`,
                    type: 'number',
                    read: true,
                    write: false,
                    def: 0,
                    role: 'info',
                    unit: 'l/h',
                },
                native: {},
            });
            await this.extendObjectAsync(`WaterCurrentOut`, {
                type: 'state',
                common: {
                    name: `WaterCurrentOut`,
                    type: 'number',
                    read: true,
                    write: false,
                    def: 0,
                    role: 'info',
                    unit: 'l/h',
                },
                native: {},
            });
        } else {
            await this.extendObjectAsync(`WaterCurrent`, {
                type: 'state',
                common: {
                    name: `WaterCurrent`,
                    type: 'number',
                    read: true,
                    write: false,
                    def: 0,
                    role: 'info',
                    unit: 'l',
                },
                native: {},
            });
            await this.extendObjectAsync(`WaterCurrentOut`, {
                type: 'state',
                common: {
                    name: `WaterCurrentOut`,
                    type: 'number',
                    read: true,
                    write: false,
                    def: 0,
                    role: 'info',
                    unit: 'l',
                },
                native: {},
            });
        }

        // not in the cloud
        if (!this.isCloudMode()) {
            await this.extendObjectAsync(`WaterYearly`, {
                type: 'channel',
                common: {
                    name: `WaterYearly`,
                },
                native: {},
            });

            for (let b = 1; b < 13; b++) {
                const month = String(b).padStart(2, '0');
                await this.extendObjectAsync(`WaterYearly.${month}`, {
                    type: 'state',
                    common: {
                        name: month,
                        type: 'number',
                        read: true,
                        write: false,
                        def: 0,
                        role: 'info',
                        unit: 'm3',
                    },
                    native: {},
                });
            }
        }

        await this.extendObjectAsync(`SaltRange`, {
            type: 'state',
            common: {
                name: `SaltRange`,
                type: 'number',
                read: true,
                write: false,
                def: 0,
                role: 'info',
                unit: 'Tage',
            },
            native: {},
        });

        if (!this.isRestApiMode()) {
            await this.extendObjectAsync(`Maintenance`, {
                type: 'state',
                common: {
                    name: `Maintenance`,
                    type: 'number',
                    read: true,
                    write: false,
                    def: 0,
                    role: 'info',
                    unit: 'Tage',
                },
                native: {},
            });
        }

        await this.extendObjectAsync(`SaltQuantity`, {
            type: 'state',
            common: {
                name: `SaltQuantity`,
                type: 'number',
                read: true,
                write: false,
                def: 0,
                role: 'info',
                unit: '%',
            },
            native: {},
        });

        await this.extendObjectAsync(`ResidualHardness`, {
            type: 'state',
            common: {
                name: `ResidualHardness`,
                type: 'number',
                read: true,
                write: true,
                def: 0,
                role: 'info',
                unit: '°dH',
                min: 0,
                max: 12,
            },
            native: {},
        });

        await this.extendObjectAsync(`NaturalHardness`, {
            type: 'state',
            common: {
                name: `NaturalHardness`,
                type: 'number',
                read: true,
                write: false,
                def: 0,
                role: 'info',
                unit: '°dH',
            },
            native: {},
        });

        await this.extendObjectAsync(`FlowRate`, {
            type: 'state',
            common: {
                name: `max flow rate per h`,
                type: 'number',
                read: true,
                write: false,
                def: 0,
                role: 'info',
                unit: 'l/h',
            },
            native: {},
        });
        await this.extendObjectAsync(`SoftwareVersion`, {
            type: 'state',
            common: {
                name: `SoftwareVersion`,
                type: 'string',
                read: true,
                write: false,
                role: 'info',
            },
            native: {},
        });
        if (!this.isRestApiMode()) {
            await this.extendObjectAsync(`HardwareVersion`, {
                type: 'state',
                common: {
                    name: `HardwareVersion`,
                    type: 'string',
                    read: true,
                    write: false,
                    role: 'info',
                },
                native: {},
            });
        }
        if (this.isCloudMode()) {
            await this.extendObjectAsync(`WaterTotal`, {
                type: 'state',
                common: {
                    name: `WaterTotal`,
                    type: 'number',
                    read: true,
                    write: false,
                    def: 0,
                    role: 'info',
                    unit: 'l',
                },
                native: {},
            });
            await this.extendObjectAsync(`WaterTotalOut`, {
                type: 'state',
                common: {
                    name: `WaterTotalOut`,
                    type: 'number',
                    read: true,
                    write: false,
                    def: 0,
                    role: 'info',
                    unit: 'l',
                },
                native: {},
            });
        } else {
            await this.extendObjectAsync(`WaterTotal`, {
                type: 'state',
                common: {
                    name: `WaterTotal`,
                    type: 'number',
                    read: true,
                    write: false,
                    def: 0,
                    role: 'info',
                    unit: 'm3',
                },
                native: {},
            });

            await this.extendObjectAsync(`WaterTotalOut`, {
                type: 'state',
                common: {
                    name: `WaterTotalOut`,
                    type: 'number',
                    read: true,
                    write: false,
                    def: 0,
                    role: 'info',
                    unit: 'm3',
                },
                native: {},
            });

            await this.extendObjectAsync(`wtuType`, {
                type: 'state',
                common: {
                    name: `wtuType`,
                    type: 'string',
                    read: true,
                    write: false,
                    role: 'info',
                },
                native: {},
            });
        }

        await this.extendObjectAsync(`WaterAverage`, {
            type: 'state',
            common: {
                name: `WaterAverage`,
                type: 'number',
                read: true,
                write: false,
                def: 0,
                role: 'info',
                unit: 'l',
            },
            native: {},
        });

        await this.extendObjectAsync(`Quantity`, {
            type: 'state',
            common: {
                name: `withdrawal quantity`,
                type: 'number',
                read: true,
                write: false,
                def: 0,
                role: 'info',
                unit: 'l',
            },
            native: {},
        });

        await this.extendObjectAsync(`SerialNumber`, {
            type: 'state',
            common: {
                name: `SerialNumber`,
                type: 'string',
                read: true,
                write: false,
                role: 'info',
            },
            native: {},
        });

        if (!this.isRestApiMode()) {
            await this.extendObjectAsync(`Connection status`, {
                type: 'state',
                common: {
                    name: `Connection status`,
                    type: 'boolean',
                    read: true,
                    write: false,
                    def: false,
                    role: 'info',
                },
                native: {},
            });

            await this.extendObjectAsync(`StandByValue`, {
                type: 'state',
                common: {
                    name: `StandByValue`,
                    type: 'number',
                    read: true,
                    write: false,
                    def: 0,
                    role: 'info',
                    unit: 'h',
                },
                native: {},
            });

            await this.extendObjectAsync(`StandBy`, {
                type: 'state',
                common: {
                    name: `StandBy`,
                    type: 'boolean',
                    role: 'info',
                    def: false,
                    read: true,
                    write: true,
                },
                native: {},
            });
        }

        await this.extendObjectAsync(`Regeneration`, {
            type: 'state',
            common: {
                name: `Regeneration`,
                type: 'boolean',
                role: 'button',
                def: false,
                read: true,
                write: true,
            },
            native: {},
        });

        await this.extendObjectAsync(`WaterStopStatus`, {
            type: 'state',
            common: {
                name: `WaterStopStatus`,
                type: 'string',
                read: true,
                write: false,
                role: 'info',
            },
            native: {},
        });

        await this.extendObjectAsync(`WaterStop`, {
            type: 'state',
            common: {
                name: `WaterStop`,
                type: 'boolean',
                role: 'state',
                def: false,
                read: true,
                write: true,
            },
            native: {},
        });

        if (this.isRestApiMode()) {
            await this.extendObjectAsync(`Date`, {
                type: 'state',
                common: {
                    name: `Date/Time on device`,
                    type: 'number',
                    role: 'value.time',
                    read: true,
                    write: false,
                },
                native: {},
            });
        }
    }
}

module.exports = { COMMANDS, DEFAULT_DEVICE_ID, JudoDevice };
