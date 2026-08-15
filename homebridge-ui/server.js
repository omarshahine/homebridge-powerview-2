'use strict';

// Homebridge UI custom-page server for the PowerView plugin.
//
// Spawned by Homebridge Config UI X when the plugin's settings modal opens and
// killed when it closes. It gives the page in public/index.html a small set of
// hub endpoints (shade list, real RF refresh, jog, calibrate, scenes) so shades
// can be recalibrated from the Homebridge UI without the PowerView app.
//
// The hub host comes from the plugin's own platform block in config.json, never
// from the browser, so the page can't be pointed at an arbitrary host.
//
// @homebridge/plugin-ui-utils 2.x is ESM-only; this plugin is CommonJS, so the
// server is bootstrapped through a dynamic import().

const fs = require('fs');

const HUB_TIMEOUT_MS = 8000;      // cached reads
const RF_TIMEOUT_MS = 40000;      // ?refresh=true is a real radio round-trip; slow shades ~3-30s
const MOTIONS = { jog: true, calibrate: true };

function decodeName(b64) {
	try { return Buffer.from(b64 || '', 'base64').toString(); } catch (e) { return String(b64 || ''); }
}

function toPercent(raw) {
	if (typeof raw !== 'number' || !isFinite(raw)) return null;
	return Math.round((raw / 65535) * 100);
}

function shapeShade(s) {
	var positions = [];
	var p = s.positions || {};
	for (var i = 1; p['posKind' + i] !== undefined; i++) {
		positions.push({ kind: p['posKind' + i], raw: p['position' + i], percent: toPercent(p['position' + i]) });
	}
	return {
		id: s.id,
		name: decodeName(s.name),
		type: s.type,
		roomId: s.roomId,
		batteryStatus: s.batteryStatus,
		batteryStrength: s.batteryStrength,
		batteryKind: s.batteryKind,
		signalStrength: s.signalStrength,
		firmware: s.firmware ? [s.firmware.revision, s.firmware.subRevision, s.firmware.build].join('.') : null,
		timedOut: s.timedOut === true,
		positions: positions
	};
}

(async function main() {
	const { HomebridgePluginUiServer, RequestError } = await import('@homebridge/plugin-ui-utils');

	class PowerViewUiServer extends HomebridgePluginUiServer {
		constructor() {
			super();
			this.onRequest('/shades', this.getShades.bind(this));
			this.onRequest('/refresh', this.refreshShade.bind(this));
			this.onRequest('/motion', this.motion.bind(this));
			this.onRequest('/scenes', this.getScenes.bind(this));
			this.onRequest('/activateScene', this.activateScene.bind(this));
			this.onRequest('/hubinfo', this.hubInfo.bind(this));
			this.ready();
		}

		// Resolve the hub host from the PowerView platform block in config.json.
		hubBase() {
			var host = 'powerview-hub.local';
			try {
				var cfg = JSON.parse(fs.readFileSync(this.homebridgeConfigPath, 'utf8'));
				var platforms = cfg.platforms || [];
				for (var i = 0; i < platforms.length; i++) {
					if (platforms[i].platform === 'PowerView' && platforms[i].host) {
						host = platforms[i].host;
						break;
					}
				}
			} catch (e) {
				console.log('PowerView UI: could not read config.json (%s); using %s', e.message, host);
			}
			return 'http://' + host;
		}

		async hub(path, options, timeoutMs) {
			options = options || {};
			var controller = new AbortController();
			var timer = setTimeout(function () { controller.abort(); }, timeoutMs || HUB_TIMEOUT_MS);
			var init = { method: options.method || 'GET', signal: controller.signal, headers: {} };
			if (options.json !== undefined) {
				init.headers['Content-Type'] = 'application/json';
				init.body = JSON.stringify(options.json);
			}
			var url = this.hubBase() + path;
			try {
				var res = await fetch(url, init);
				if (!res.ok) {
					var msg = 'Hub returned HTTP ' + res.status;
					if (res.status === 423) msg += ' (hub busy / locked — wait a minute and retry)';
					throw new RequestError(msg, { status: res.status });
				}
				return await res.json();
			} catch (e) {
				if (e instanceof RequestError) throw e;
				var reason = e && e.name === 'AbortError'
					? 'Hub did not answer within ' + Math.round((timeoutMs || HUB_TIMEOUT_MS) / 1000) + 's (shade radio may be unresponsive)'
					: (e && e.message) || String(e);
				throw new RequestError(reason, { status: 502 });
			} finally {
				clearTimeout(timer);
			}
		}

		requireId(payload) {
			var id = payload && parseInt(payload.id, 10);
			if (!id || id < 0) throw new RequestError('Missing or invalid shade id', { status: 400 });
			return id;
		}

		async hubInfo() {
			var json = await this.hub('/api/userdata');
			var u = json.userData || {};
			return {
				host: this.hubBase(),
				hubName: decodeName(u.hubName),
				serialNumber: u.serialNumber,
				firmware: u.firmware && u.firmware.mainProcessor ? u.firmware.mainProcessor.name : null
			};
		}

		async getShades() {
			var json = await this.hub('/api/shades');
			return (json.shadeData || []).map(shapeShade).sort(function (a, b) { return a.name.localeCompare(b.name); });
		}

		// Real RF round-trip to one shade. This is what tells you whether the
		// shade's radio is alive and where the motor actually is.
		async refreshShade(payload) {
			var id = this.requireId(payload);
			var json = await this.hub('/api/shades/' + id + '?refresh=true&updateBatteryLevel=true', {}, RF_TIMEOUT_MS);
			return shapeShade(json.shade || {});
		}

		// jog: small wiggle to prove the radio + motor respond.
		// calibrate: full up/down travel to relearn limits (same as the app's
		// "Calibrate Shade"). Do not interrupt once started.
		async motion(payload) {
			var id = this.requireId(payload);
			var motion = payload && payload.motion;
			if (!MOTIONS[motion]) throw new RequestError('Unsupported motion: ' + motion, { status: 400 });
			console.log('PowerView UI: %s shade %d', motion, id);
			var json = await this.hub('/api/shades/' + id, { method: 'PUT', json: { shade: { motion: motion } } }, RF_TIMEOUT_MS);
			return shapeShade(json.shade || {});
		}

		async getScenes() {
			var scenes = await this.hub('/api/scenes');
			var members = await this.hub('/api/scenemembers');
			var byScene = {};
			(members.sceneMemberData || []).forEach(function (m) {
				(byScene[m.sceneId] = byScene[m.sceneId] || []).push({
					shadeId: m.shadeId,
					raw: m.positions && m.positions.position1,
					kind: m.positions && m.positions.posKind1,
					percent: toPercent(m.positions && m.positions.position1)
				});
			});
			return (scenes.sceneData || []).map(function (s) {
				return { id: s.id, name: decodeName(s.name), roomId: s.roomId, members: byScene[s.id] || [] };
			}).sort(function (a, b) { return a.name.localeCompare(b.name); });
		}

		async activateScene(payload) {
			var id = this.requireId(payload);
			console.log('PowerView UI: activate scene %d', id);
			return await this.hub('/api/scenes?sceneId=' + id);
		}
	}

	return new PowerViewUiServer();
})().catch(function (e) {
	console.error('PowerView UI server failed to start:', e && e.stack || e);
	process.exit(1);
});
