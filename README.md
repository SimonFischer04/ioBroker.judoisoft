![Logo](admin/judo.png)

# ioBroker.judoisoft

=================

![Number of Installations](http://iobroker.live/badges/judoisoft-installed.svg) ![Number of Installations](http://iobroker.live/badges/judoisoft-stable.svg) [![NPM version](http://img.shields.io/npm/v/iobroker.judoisoft.svg)](https://www.npmjs.com/package/iobroker.judoisoft)
[![Downloads](https://img.shields.io/npm/dm/iobroker.judoisoft.svg)](https://www.npmjs.com/package/iobroker.judoisoft)

[![NPM](https://nodei.co/npm/iobroker.judoisoft.png?downloads=true)](https://nodei.co/npm/iobroker.judoisoft/)

## judoisoft Adapter for ioBroker

A small excerpt just of the command options:

![möglichkeiten](https://github.com/arteck/iobroker.judoisoft/blob/master/doku/datenpunkte.png)

### Configure devices

Existing installations keep their settings in the **Default device** tab. That device's IDs stay at the instance root, for example `judoisoft.0.Date` in REST API mode.

With the instance running, open **Devices** and choose **Add device**. Set a stable device ID, such as `workshop`, to create objects like `judoisoft.0.workshop.Date`. You can edit the device settings and display name in Device Manager. Device Manager requires ioBroker Admin 7.8.20 or newer.

Each device has its own polling interval and credentials. For a local device, enter its IP address or host name. Enable **REST API** for the new JUDO connectivity module, which uses Basic Auth at `http://<ip>/api/rest/...` and defaults to `admin` / `Connectivity`. For cloud devices, enable **Cloud login** and enter the zero-based device index in your cloud account. Cloud login takes precedence when both options are enabled.

`judoisoft.0.info.connection` follows the default device when configured. Otherwise, it reports whether any device is connected. Each additional device reports its own connection at `judoisoft.0.<device>.info.connection`.

## Changelog
### 1.1.7 (2026-09-09)
- try fix release
- Add Node.js 26 to CI test matrix - #218

### 1.1.6 (2026-09-09)
- fix #216

### 1.1.5 (2026-09-04)
- fix release

### 1.1.4 (2026-09-04)

- Add device selection for cloud connection - #194
- Fix issues detected by repository checker
- Derive `info.connection` from the active mode (local REST vs cloud) - #212
- Cloud login takes precedence over REST API when both are enabled

### 1.1.3 (2026-07-18)

- (copilot) Adapter requires node.js >= 22 now
- (iobroker-bot) Adapter requires node.js >= 20 now.
- (@SimonFischer04) support rest-api (#143). closes #32, closes #82
- (@arteck, @SimonFischer04) (dependency) bump / cleanups
- (@SimonFischer04) Migration to ESLint 9 and @iobroker/eslint-config. #114
- (@SimonFischer04) Migrate admin config to ioBroker jsonConfig. Closes #55

### Older entries
See [CHANGELOG_OLD.md](CHANGELOG_OLD.md)

## License

The MIT License (MIT)

Copyright (c) 2018-2026 Arthur Rupp arteck@outlook.com

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
