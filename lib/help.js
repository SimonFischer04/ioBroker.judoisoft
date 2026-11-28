'use strict';

const modes = {
    cloud: {
        name: 'JUDO Cloud',
        telemetry: `- WaterTotal and WaterTotalOut report total and treated water in liters. WaterCurrent is in liters per hour.
- Connection status reports the selected device's online status in the cloud. ServiceDays and Maintenance are in days.
- Battery reports charge in percent where available. On supported i-dos eco devices, StatusData.RemainingAmountInTank
  and StatusData.RemainingAmountInTankPercent report the remaining solution in liters and percent.`,
        controls: `
- StandBy (boolean) requests standby with true. Writing false sends the command to open the shutoff valve.
  StandByValue reports standby duration in hours.`,
    },
    rest: {
        name: 'local REST API (connectivity module)',
        telemetry: `- WaterTotal and WaterTotalOut report total and treated water in cubic meters. WaterYearly.01 through
  WaterYearly.12 report monthly volumes in cubic meters.
- OperatingHours reports runtime in hours, and Date reports the device clock.
- On i-dos eco, StatusData includes operating mode, errors, warnings, water flow (liters per hour), consumption
  (liters), and remaining solution (liters and percent). StatusData.Raw and Dosage.Raw hold raw diagnostic data.`,
        controls: '',
    },
    local: {
        name: 'legacy local API',
        telemetry: `- WaterTotal and WaterTotalOut report total and treated water in cubic meters. WaterYearly.01 through
  WaterYearly.12 report monthly volumes in cubic meters.
- WaterCurrent, WaterCurrentOut and WaterAverage are in liters. NaturalHardness is in °dH.
- FlowRate and Quantity report the water stop flow limit in liters per hour and withdrawal limit in liters.
- ServiceDate reports the device service date.`,
        controls: `
- StandBy (boolean) starts water stop standby with true and ends it with false. StandByValue reports standby
  duration in hours.`,
    },
};

/**
 * Builds the read-only ioBroker help reply for an adapter instance.
 *
 * @param {string} namespace - Full instance name, for example judoisoft.0.
 * @param {keyof typeof modes} mode - Active connection mode.
 */
function getAdapterHelp(namespace, mode) {
    const { name, telemetry, controls } = modes[mode];
    return {
        commands: [{ command: 'help', write: false }],
        help: `ioBroker.judoisoft monitors and controls supported JUDO water treatment devices.
This instance uses the ${name} connection mode. State availability and values depend on the connected model.

Message command
- Send sendTo('${namespace}', 'help', {}, callback). The payload is empty. The reply contains an English help string
  and a commands array with { command: 'help', write: false }. Use ioBroker states for device operations.

States under ${namespace}
- ${namespace}.info.connection indicates communication in the configured mode. ${namespace}.lastInfoUpdate
  contains the last successful information update in Unix milliseconds.
- SerialNumber identifies the device. SoftwareVersion and InstallationDate describe its firmware and installation.
- SaltQuantity is the remaining salt in percent, and SaltRange is the estimated supply in days where available.
- WaterStopStatus reports valve status or the command response, depending on mode.
${telemetry}

Writable states (write with ack false)
- ResidualHardness (number, 0–12 °dH) sets the target hardness of treated water. Use a whole number in local REST mode.
- WaterStop (boolean) closes the shutoff valve with true and opens it with false on supported devices.
- Regeneration (boolean button) starts a regeneration cycle. Write true to trigger it. In JUDO Cloud and legacy
  local modes, any unacknowledged write to this state triggers the command, including false.${controls}

How to act
- Confirm the target instance and SerialNumber if several devices match. Check info.connection, lastInfoUpdate,
  and the relevant state's timestamp before relying on a reading.
- Make changes only when requested. Check the device supports the control and the state exists with common.write
  set to true. Confirm the intended action before changing the water supply, standby, or water treatment settings.
- Check fresh device telemetry to verify the result. If WaterStopStatus reports a command response or current
  feedback is unavailable, verify the physical outcome on the device before reporting success.
`,
    };
}

module.exports = { getAdapterHelp };
