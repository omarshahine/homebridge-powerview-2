var hub = require('./PowerViewHub'),
	PowerViewHub = hub.PowerViewHub,
	Position = hub.Position;
var Accessory, Service, Characteristic, UUIDGen;

let Shade = {
	ROLLER: 1,
	TOP_BOTTOM: 2,
	HORIZONTAL: 3,
	VERTICAL: 4
}

let ShadeTypes = {
	ROLLER: [1, 5, 6, 42],
	TOP_BOTTOM: [8],
	HORIZONTAL: [18, 23],
	VERTICAL: [16]
}

let SubType = {
	BOTTOM: 'bottom',
	TOP: 'top'
}


// TODO:
// - battery status in shadeData:
//   "batteryStatus": 3,
//   "batteryStrength": 182,
// - signal strength in shadeData (not always - maybe not if via repeater?):
//   "signalStrength": 4,


module.exports = function (homebridge) {
	Accessory = homebridge.platformAccessory;

	Service = homebridge.hap.Service;
	Characteristic = homebridge.hap.Characteristic;
	UUIDGen = homebridge.hap.uuid;

	homebridge.registerPlatform("homebridge-powerview", "PowerView", PowerViewPlatform, true);
}

function PowerViewPlatform(log, config, api) {
	log("PowerView init");
	this.log = log;
	this.config = config;
	this.api = api;

	this.accessories = [];

	if (config) {
		var host = config["host"] || 'powerview-hub.local';
		this.hub = new PowerViewHub(log, host);
		// Lets the hub queue re-check motion just before it sends a queued RF
		// query, since a scene may have started the shade after it was queued.
		this.hub.isBusy = function (shadeId) {
			return this.enableMotionGuard && this.isMoving(shadeId);
		}.bind(this);

		this.refreshShades = config["refreshShades"] ? true : false;
		this.pollShadesForUpdate = config["pollShadesForUpdate"] ? true : false;

		// Scenes: expose each hub-defined scene as a momentary Switch. Activating
		// it fires a single /api/scenes?sceneId=X call and the hub coordinates all
		// shades at once — the fast path vs. a HomeKit scene that pokes each shade
		// individually. Momentary (auto-resets off) so a HomeKit automation can
		// trigger it: automations can set a Switch on, but cannot activate a
		// StatelessProgrammableSwitch. sceneAccessories is keyed by hub scene id
		// and kept separate from `accessories` (shades) so the two reconciliation
		// passes never clobber each other.
		this.exposeScenes = config["exposeScenes"] ? true : false;
		this.sceneNamePrefix = config["sceneNamePrefix"] !== undefined ? config["sceneNamePrefix"] : "";
		this.sceneResetMs = config["sceneResetMs"] || 1000;
		this.sceneAccessories = {};

		// Scenes listed here are never exposed as switches, and any switch already
		// exposed for them is removed on the next reconcile. Match is case-insensitive
		// on the trimmed scene name; a numeric entry also matches the hub scene id
		// (handy when two scenes share a name). Useful to hide hub scenes that exist
		// only for physical remotes / the PowerView app and have no HomeKit purpose.
		this.excludeSceneNames = {};
		this.excludeSceneIds = {};
		var excludeScenes = config["excludeScenes"] || [];
		for (var ei = 0; ei < excludeScenes.length; ei++) {
			var entry = excludeScenes[ei];
			if (entry === undefined || entry === null) continue;
			if (typeof entry === "number") {
				this.excludeSceneIds[entry] = true;
				continue;
			}
			var trimmed = String(entry).trim();
			if (/^[0-9]+$/.test(trimmed)) this.excludeSceneIds[parseInt(trimmed, 10)] = true;
			this.excludeSceneNames[trimmed.toLowerCase()] = true;
		}

		this.forceRollerShades = config["forceRollerShades"] || [];
		this.forceTopBottomShades = config["forceTopBottomShades"] || [];
		this.forceHorizontalShades = config["forceHorizontalShades"] || [];
		this.forceVerticalShades = config["forceVerticalShades"] || [];

		// Post-move verify: after each commanded move, RF-query the shade later
		// to catch motor stalls / drift between hub-cached and physical position.
		// Coalesced per-shade so N rapid taps collapse to 1 verify.
		this.enablePostMoveVerify = config["enablePostMoveVerify"] !== false;
		this.defaultVerifyDelay = config["defaultVerifyDelay"] || 30000;
		this.slowVerifyDelay = config["slowVerifyDelay"] || 45000;
		this.slowShades = config["slowShades"] || [];
		this._verifyTimers = {};

		// Motion guard: the Gen 2 hub never reports whether a shade is moving,
		// so a shade counts as moving for its expected travel time (the verify
		// delay above) after each move command. While it is moving, a repeat of
		// the same target is dropped, a new target is preceded by a stop plus a
		// short settle, and RF refresh queries to it are held off. Reversing a
		// shade mid-travel and RF-querying it while it moved is what left a shade
		// stuck halfway, believing it was closed, until it was recalibrated.
		this.enableMotionGuard = config["enableMotionGuard"] !== false;
		this.stopSettleMs = config["stopSettleMs"] !== undefined ? config["stopSettleMs"] : 2000;
		this.minMoveMs = config["minMoveMs"] !== undefined ? config["minMoveMs"] : 5000;
		this.knownPositionTtlMs = config["knownPositionTtlMs"] !== undefined ? config["knownPositionTtlMs"] : 600000;
		this._motion = {};
		this._sceneMembers = null;
		// Last position we trust, on the hub's raw scale: the target of a move
		// that has run its course, or a real RF read. The hub's cached value is
		// deliberately not used, since after a stop it still holds the old
		// target rather than where the shade actually halted.
		this._knownPositions = {};

		// Slider debounce: HomeKit fires a stream of TargetPosition.set calls as
		// you drag the slider. Sending each one to the hub makes the shade chase
		// every intermediate value before you settle. Instead we ack HomeKit
		// immediately and only send the final value in a burst, so the shade
		// moves once to the target. A single tap is just delayed by this window.
		// Set to 0 to send every set immediately (legacy behavior).
		this.setPositionDebounceMs = config["setPositionDebounceMs"] !== undefined ? config["setPositionDebounceMs"] : 1500;
		this._setTimers = {};
		this._pendingPositions = {};

		// Background poll: bulk GET /api/shades to keep HomeKit tiles populated
		// from the hub's cache. 120s default — quiet logs, still fresh enough
		// since post-move verify + heal sweep cover correctness.
		this.pollIntervalMs = config["pollIntervalMs"] !== undefined ? config["pollIntervalMs"] : 120000;

		// Heal sweep: sequential ?refresh=true walk across all shades. Each
		// query is a real RF round-trip to the shade — catches drift the hub
		// cache misses. Default 720 min (twice daily). 0 disables.
		this.healSweepIntervalMinutes = config["healSweepIntervalMinutes"] !== undefined ? config["healSweepIntervalMinutes"] : 720;
		this.healSweepGapMs = config["healSweepGapMs"] || 4000;
		this._healInProgress = false;

		this.api.on('didFinishLaunching', function () {
			this.updateHubInfo();
			if (this.pollShadesForUpdate) {
				this.pollShades();
			} else {
				this.updateShades();
			}
			if (this.exposeScenes) {
				this.updateScenes();
			} else {
				this.removeAllSceneAccessories();
			}
			if (this.healSweepIntervalMinutes > 0) {
				var intervalMs = this.healSweepIntervalMinutes * 60 * 1000;
				setInterval(this.runHealSweep.bind(this), intervalMs);
			}
		}.bind(this));
	}
}

// Returns the Shade type from the given shade data.
PowerViewPlatform.prototype.shadeType = function (shade) {
	if (this.forceRollerShades.includes(shade.id))
		return Shade.ROLLER;
	if (this.forceTopBottomShades.includes(shade.id))
		return Shade.TOP_BOTTOM;
	if (this.forceHorizontalShades.includes(shade.id))
		return Shade.HORIZONTAL;
	if (this.forceVerticalShades.includes(shade.id))
		return Shade.VERTICAL;

	if (ShadeTypes.ROLLER.includes(shade.type))
		return Shade.ROLLER;
	if (ShadeTypes.TOP_BOTTOM.includes(shade.type))
		return Shade.TOP_BOTTOM;
	if (ShadeTypes.HORIZONTAL.includes(shade.type))
		return Shade.HORIZONTAL;
	if (ShadeTypes.VERTICAL.includes(shade.type))
		return Shade.VERTICAL;

	this.log("*** Shade %d has unknown type %d, assuming roller ***", shade.id, shade.type);
	return Shade.ROLLER
}


// Called when a cached accessory is loaded to set up callbacks.
PowerViewPlatform.prototype.configureAccessory = function (accessory) {
	if (accessory.context.sceneId !== undefined) {
		this.log("Cached scene %d: %s", accessory.context.sceneId, accessory.displayName);
		this.configureSceneAccessory(accessory);
		return;
	}

	this.log("Cached shade %d: %s", accessory.context.shadeId, accessory.displayName);

	if (!accessory.context.shadeType) {
		// Port over a pre-typing shade.
		var service = accessory.getServiceById(Service.WindowCovering, SubType.TOP);
		if (service) {
			accessory.context.shadeType = Shade.TOP_BOTTOM;
		} else {
			accessory.context.shadeType = Shade.ROLLER;
		}
	}

	this.configureShadeAccessory(accessory);
}

// Adds a new shade accessory.
PowerViewPlatform.prototype.addShadeAccessory = function (shade) {
	var name = Buffer.from(shade.name, 'base64').toString();
	this.log("Adding shade %d: %s", shade.id, name);

	var uuid = UUIDGen.generate(shade.id.toString());

	var accessory = new Accessory(name, uuid);
	accessory.context.shadeId = shade.id;
	accessory.context.shadeType = this.shadeType(shade);

	this.configureShadeAccessory(accessory);
	this.api.registerPlatformAccessories("homebridge-powerview", "PowerView", [accessory]);

	return accessory;
}

// Updates an existing shade accessory.
PowerViewPlatform.prototype.updateShadeAcccessory = function (shade) {
	var accessory = this.accessories[shade.id];
	this.log.debug("Updating shade %d: %s", shade.id, accessory.displayName);

	var newType = this.shadeType(shade);
	if (newType != accessory.context.shadeType) {
		this.log("Shade changed type %d -> %d", accessory.context.shadeType, newType);
		accessory.context.shadeType = newType;

		this.configureShadeAccessory(accessory);
	}

	return accessory;
}

// Removes an accessory from the platform.
PowerViewPlatform.prototype.removeShadeAccessory = function (accessory) {
	this.log("Removing shade %d: %s", accessory.context.shadeId, accessory.displayName);
	this.api.unregisterPlatformAccessories("homebridge-powerview", "PowerView", [accessory]);

	delete this.accessories[accessory.context.shadeId];
}

// Sets up callbacks for a shade accessory.
PowerViewPlatform.prototype.configureShadeAccessory = function (accessory) {
	var shadeId = accessory.context.shadeId;
	this.accessories[shadeId] = accessory;

	var service = accessory.getServiceById(Service.WindowCovering, SubType.BOTTOM);
	if (!service)
		service = accessory.addService(Service.WindowCovering, accessory.displayName, SubType.BOTTOM);

	service
		.getCharacteristic(Characteristic.CurrentPosition)
		.removeAllListeners('get')
		.on('get', this.getPosition.bind(this, accessory.context.shadeId, Position.BOTTOM));

	service
		.getCharacteristic(Characteristic.TargetPosition)
		.removeAllListeners('set')
		.on('set', this.setPosition.bind(this, accessory.context.shadeId, Position.BOTTOM));

	if (accessory.context.shadeType == Shade.HORIZONTAL) {
		service
			.getCharacteristic(Characteristic.CurrentHorizontalTiltAngle)
			.setProps({ minValue: 0 })
			.removeAllListeners('get')
			.on('get', this.getPosition.bind(this, accessory.context.shadeId, Position.VANES));

		service
			.getCharacteristic(Characteristic.TargetHorizontalTiltAngle)
			.setProps({ minValue: 0 })
			.removeAllListeners('set')
			.on('set', this.setPosition.bind(this, accessory.context.shadeId, Position.VANES));
	} else {
		if (service.testCharacteristic(Characteristic.TargetHorizontalTiltAngle)) {
			var characteristic = service.getCharacteristic(Characteristic.TargetHorizontalTiltAngle);
			service.removeCharacteristic(characteristic);
			service.addOptionalCharacteristic(Characteristic.TargetHorizontalTiltAngle);
		}

		if (service.testCharacteristic(Characteristic.CurrentHorizontalTiltAngle)) {
			var characteristic = service.getCharacteristic(Characteristic.CurrentHorizontalTiltAngle);
			service.removeCharacteristic(characteristic);
			service.addOptionalCharacteristic(Characteristic.CurrentHorizontalTiltAngle);
		}
	}

	// For vertical shades, we stick to the default "bottom" subtype even though these are left/right;
	// HomeKit doesn't make a distinction anyway.
	if (accessory.context.shadeType == Shade.VERTICAL) {
		service
			.getCharacteristic(Characteristic.CurrentVerticalTiltAngle)
			.removeAllListeners('get')
			.on('get', this.getPosition.bind(this, accessory.context.shadeId, Position.VANES));

		service
			.getCharacteristic(Characteristic.TargetVerticalTiltAngle)
			.removeAllListeners('set')
			.on('set', this.setPosition.bind(this, accessory.context.shadeId, Position.VANES));
	} else {
		if (service.testCharacteristic(Characteristic.TargetVerticalTiltAngle)) {
			var characteristic = service.getCharacteristic(Characteristic.TargetVerticalTiltAngle);
			service.removeCharacteristic(characteristic);
			service.addOptionalCharacteristic(Characteristic.TargetVerticalTiltAngle);
		}

		if (service.testCharacteristic(Characteristic.CurrentVerticalTiltAngle)) {
			var characteristic = service.getCharacteristic(Characteristic.CurrentVerticalTiltAngle);
			service.removeCharacteristic(characteristic);
			service.addOptionalCharacteristic(Characteristic.CurrentVerticalTiltAngle);
		}
	}

	service = accessory.getServiceById(Service.WindowCovering, SubType.TOP);
	if (accessory.context.shadeType == Shade.TOP_BOTTOM) {
		if (!service)
			service = accessory.addService(Service.WindowCovering, accessory.displayName, SubType.TOP);

		service
			.getCharacteristic(Characteristic.CurrentPosition)
			.removeAllListeners('get')
			.on('get', this.getPosition.bind(this, accessory.context.shadeId, Position.TOP));

		service
			.getCharacteristic(Characteristic.TargetPosition)
			.removeAllListeners('set')
			.on('set', this.setPosition.bind(this, accessory.context.shadeId, Position.TOP));
	} else {
		accessory.removeService(service);
	}
}

// Updates the values of shade accessory characteristics.
PowerViewPlatform.prototype.updateShadeValues = function (shade, current) {
	var accessory = this.accessories[shade.id];
	if (this.enableMotionGuard) this.noteObservedPositions(shade);

	var positions = null;
	if (shade.positions) {
		this.log.debug("Set for", shade.id, { 'positions': shade.positions });
		positions = {};

		for (var i = 1; shade.positions['posKind' + i]; ++i) {
			var position = shade.positions['posKind' + i];
			var hubValue = shade.positions['position' + i];

			if (position == Position.BOTTOM) {
				positions[Position.BOTTOM] = Math.round(100 * hubValue / 65535);

				var service = accessory.getServiceById(Service.WindowCovering, SubType.BOTTOM);

				if (current) {
					this.log.debug("Setting CurrentPosition to:", positions[Position.BOTTOM]);

					if (!isNaN(positions[Position.BOTTOM])) {
						service.setCharacteristic(Characteristic.CurrentPosition, positions[Position.BOTTOM]);
					} else {
						this.log("Invalid position value:", positions[Position.BOTTOM]);
					}
				}

				this.log.debug("Setting TargetPosition to:", positions[Position.BOTTOM]);

				if (!isNaN(positions[Position.BOTTOM])) {
					service.updateCharacteristic(Characteristic.TargetPosition, positions[Position.BOTTOM]);
				} else {
					this.log("Invalid position value:", positions[Position.BOTTOM]);
				}

				this.log.debug("Setting PositionState to:", Characteristic.PositionState.STOPPED);
				service.setCharacteristic(Characteristic.PositionState, Characteristic.PositionState.STOPPED);

				if (accessory.context.shadeType == Shade.HORIZONTAL) {
					if (current) {
						service.setCharacteristic(Characteristic.CurrentHorizontalTiltAngle, 0);
					}

					if (!isNaN(0)) {
						service.updateCharacteristic(Characteristic.TargetHorizontalTiltAngle, 0);
					} else {
						this.log("Invalid tilt angle value:", 0);
					}
				}

				if (accessory.context.shadeType == Shade.VERTICAL) {
					if (current) {
						service.setCharacteristic(Characteristic.CurrentVerticalTiltAngle, 0);
					}

					if (!isNaN(0)) {
						service.updateCharacteristic(Characteristic.TargetVerticalTiltAngle, 0);
					} else {
						this.log("Invalid tilt angle value:", 0);
					}
				}
			}


			if (position == Position.VANES && accessory.context.shadeType == Shade.HORIZONTAL) {
				positions[Position.VANES] = Math.round(90 * hubValue / 32767);

				var service = accessory.getServiceById(Service.WindowCovering, SubType.BOTTOM);

				// Once we have a vane position, the shade must be closed.
				if (current)
					service.setCharacteristic(Characteristic.CurrentPosition, 0);
				service.updateCharacteristic(Characteristic.TargetPosition, 0);
				service.setCharacteristic(Characteristic.PositionState, Characteristic.PositionState.STOPPED);

				if (current) {
					this.log.debug("Setting CurrentHorizontalTiltAngle to:", positions[Position.VANES]);

					if (!isNaN(positions[Position.VANES])) {
						service.setCharacteristic(Characteristic.CurrentHorizontalTiltAngle, positions[Position.VANES]);
					} else {
						this.log("Invalid vane position value:", positions[Position.VANES]);
					}
				}

				this.log.debug("Setting TargetHorizontalTiltAngle to:", positions[Position.VANES]);

				if (!isNaN(positions[Position.VANES])) {
					service.updateCharacteristic(Characteristic.TargetHorizontalTiltAngle, positions[Position.VANES]);
				} else {
					this.log("Invalid vane position value:", positions[Position.VANES]);
				}

			}

			if (position == Position.VANES && accessory.context.shadeType == Shade.VERTICAL) {
				positions[Position.VANES] = 90 - Math.round(180 * hubValue / 65535);

				var service = accessory.getServiceById(Service.WindowCovering, SubType.BOTTOM);

				// Once we have a vane position, the shade must be closed.
				if (current)
					service.setCharacteristic(Characteristic.CurrentPosition, 0);
				service.updateCharacteristic(Characteristic.TargetPosition, 0);
				service.setCharacteristic(Characteristic.PositionState, Characteristic.PositionState.STOPPED);

				if (current)
					service.setCharacteristic(Characteristic.CurrentVerticalTiltAngle, positions[Position.VANES]);
				service.updateCharacteristic(Characteristic.TargetVerticalTiltAngle, positions[Position.VANES]);
			}

			if (position == Position.TOP && accessory.context.shadeType == Shade.TOP_BOTTOM) {
				positions[Position.TOP] = Math.round(100 * hubValue / 65535);

				var service = accessory.getServiceById(Service.WindowCovering, SubType.TOP);

				if (current)
					service.setCharacteristic(Characteristic.CurrentPosition, positions[Position.TOP]);
				service.updateCharacteristic(Characteristic.TargetPosition, positions[Position.TOP]);
				service.setCharacteristic(Characteristic.PositionState, Characteristic.PositionState.STOPPED);
			}
		}
	}

	// your accessory must have an AccessoryInformation service
	this.informationService = new this.api.hap.Service.AccessoryInformation()
		.setCharacteristic(this.api.hap.Characteristic.Manufacturer, "Hunter Douglas")
		.setCharacteristic(this.api.hap.Characteristic.Model, this.hubVersion);

	return positions;
}


// Gets the current set of shades, and updates the accessories.
PowerViewPlatform.prototype.updateShades = function (callback) {
	this.hub.getShades(function (err, shadeData) {
		if (!err) {
			var newShades = [];
			for (var shade of shadeData) {
				if (!this.accessories[shade.id]) {
					newShades[shade.id] = this.addShadeAccessory(shade);
				} else {
					newShades[shade.id] = this.updateShadeAcccessory(shade);
				}

				this.updateShadeValues(shade);
			}

			for (var shadeId in this.accessories) {
				if (!newShades[shadeId]) {
					this.removeShadeAccessory(this.accessories[shadeId]);
				}
			}
		}

		if (callback) callback(err);
	}.bind(this));
}

// Regularly polls shades for changes.
PowerViewPlatform.prototype.pollShades = function () {
	this.updateShades(function () {
		setTimeout(function () {
			this.pollShades();
		}.bind(this), this.pollIntervalMs);
	}.bind(this));
}

// Gets the current set of hub scenes, and reconciles the scene switches:
// adds new ones, drops any that no longer exist on the hub.
PowerViewPlatform.prototype.updateScenes = function (callback) {
	this.hub.getScenes(function (err, sceneData) {
		if (!err) {
			if (this.enableMotionGuard) this.loadSceneMembers();
			var seen = {};
			for (var scene of sceneData) {
				// Excluded scenes are left out of `seen`, so the removal pass
				// below tears down any switch previously exposed for them.
				if (this.isSceneExcluded(scene)) {
					continue;
				}
				seen[scene.id] = true;
				if (!this.sceneAccessories[scene.id]) {
					this.addSceneAccessory(scene);
				}
			}

			for (var sceneId in this.sceneAccessories) {
				if (!seen[sceneId]) {
					this.removeSceneAccessory(this.sceneAccessories[sceneId]);
				}
			}
		} else {
			this.log("Error getting scenes: %s", (err && err.message) || err);
		}

		if (callback) callback(err);
	}.bind(this));
}

// True if a hub scene should be hidden per the excludeScenes config — matched
// by numeric hub scene id or by case-insensitive trimmed (decoded) name.
PowerViewPlatform.prototype.isSceneExcluded = function (scene) {
	if (this.excludeSceneIds[scene.id]) return true;
	var name = Buffer.from(scene.name, 'base64').toString().trim().toLowerCase();
	return this.excludeSceneNames[name] === true;
}

// Adds a new scene switch accessory.
PowerViewPlatform.prototype.addSceneAccessory = function (scene) {
	var name = this.sceneNamePrefix + Buffer.from(scene.name, 'base64').toString();
	this.log("Adding scene %d: %s", scene.id, name);

	var uuid = UUIDGen.generate("scene-" + scene.id.toString());

	var accessory = new Accessory(name, uuid);
	accessory.context.sceneId = scene.id;
	accessory.category = this.api.hap.Categories.SWITCH;

	this.configureSceneAccessory(accessory);
	this.api.registerPlatformAccessories("homebridge-powerview", "PowerView", [accessory]);

	return accessory;
}

// Removes a scene switch accessory.
PowerViewPlatform.prototype.removeSceneAccessory = function (accessory) {
	this.log("Removing scene %d: %s", accessory.context.sceneId, accessory.displayName);
	this.api.unregisterPlatformAccessories("homebridge-powerview", "PowerView", [accessory]);

	delete this.sceneAccessories[accessory.context.sceneId];
}

// Tears down every scene switch — used when exposeScenes is turned off so
// stale cached scene accessories don't linger in HomeKit.
PowerViewPlatform.prototype.removeAllSceneAccessories = function () {
	for (var sceneId in this.sceneAccessories) {
		this.removeSceneAccessory(this.sceneAccessories[sceneId]);
	}
}

// Sets up the momentary Switch for a scene accessory.
PowerViewPlatform.prototype.configureSceneAccessory = function (accessory) {
	var sceneId = accessory.context.sceneId;
	this.sceneAccessories[sceneId] = accessory;

	accessory.getService(Service.AccessoryInformation)
		.setCharacteristic(Characteristic.Manufacturer, "Hunter Douglas")
		.setCharacteristic(Characteristic.Model, "PowerView Scene");

	var service = accessory.getService(Service.Switch);
	if (!service)
		service = accessory.addService(Service.Switch, accessory.displayName);

	service
		.getCharacteristic(Characteristic.On)
		.removeAllListeners('get')
		.removeAllListeners('set')
		.on('get', function (callback) { callback(null, false); })
		.on('set', this.setScene.bind(this, accessory));
}

// Characteristic callback for a scene switch's On.set. Activating (On=true)
// fires the hub scene and then bounces the switch back off after sceneResetMs
// so it reads as a momentary trigger. An explicit off is a no-op.
PowerViewPlatform.prototype.setScene = function (accessory, value, callback) {
	var sceneId = accessory.context.sceneId;

	if (!value) {
		callback(null);
		return;
	}

	this.log("Activate scene %d: %s", sceneId, accessory.displayName);
	var since = Date.now();
	var cached = this.enableMotionGuard && this._sceneMembers ? this._sceneMembers[sceneId] : null;
	if (cached) this.markSceneMoving(sceneId, cached, since);
	this.hub.activateScene(sceneId, function (err) {
		if (err) {
			this.log("Scene %d activation failed: %s", sceneId, (err && err.message) || err);
			if (cached) this.clearSceneMoving(sceneId);
			return;
		}
		if (this.enableMotionGuard && !cached) {
			// No cached members yet: load them, without overriding any shade
			// commanded individually since the scene fired.
			this.loadSceneMembers(function (e) {
				if (!e && this._sceneMembers && this._sceneMembers[sceneId]) {
					this.markSceneMoving(sceneId, this._sceneMembers[sceneId], since);
				}
			}.bind(this));
		}
	}.bind(this));

	// Ack HomeKit immediately; don't block the tile on the hub round-trip.
	callback(null);

	var service = accessory.getService(Service.Switch);
	setTimeout(function () {
		service.updateCharacteristic(Characteristic.On, false);
	}.bind(this), this.sceneResetMs);
}

// Gets the hub information, and updates the accessories.
PowerViewPlatform.prototype.updateHubInfo = function (callback) {
	this.hub.getUserData(function (err, userData) {
		if (!err) {
			this.hubName = Buffer.from(userData.hubName, 'base64').toString();
			this.hubSerialNumber = userData.serialNumber;
			if (userData.firmware && userData.firmware.mainProcessor)
				this.hubVersion = userData.firmware.mainProcessor.name;

			this.log("Hub: %s", this.hubName);

			for (var shadeId in this.accessories) {
				this.updateShadeValues({ id: parseInt(shadeId) });
			}
		}

		if (callback) callback(err);
	}.bind(this));
}

// Gets the current shade information, and updates values.
PowerViewPlatform.prototype.updateShade = function (shadeId, refresh = false, callback) {
	// An RF query to a moving shade competes with its move; read the hub's
	// cached value instead until it has finished travelling.
	if (refresh && this.enableMotionGuard && this.isMoving(shadeId)) {
		this.log.debug("Shade %d is moving, using cached position instead of RF refresh", shadeId);
		refresh = false;
	}
	this.hub.getShade(shadeId, refresh, function (err, shade) {
		if (!err) {
			if (refresh) this.rememberRefreshed(shade);
			var positions = this.updateShadeValues(shade);
			var timedOut = refresh ? shade.timedOut : null;
			if (callback) callback(null, positions, timedOut);
		} else {
			if (callback) callback(err);
			this.log("Error getting shade %d: %s", shadeId, err);
		}
	}.bind(this));
}

// Gets a single shade position, updating values along the way.
PowerViewPlatform.prototype.updatePosition = function (shadeId, position, refresh = false, callback) {
	this.updateShade(shadeId, refresh, function (err, positions, timedOut) {
		if (!err) {
			// Treat a number of other issues as errors.
			if (refresh && timedOut) {
				this.log("Timeout for %d/%d", shadeId, position);
				if (callback) callback(new Error("Timed out"));
			} else {
				if (!positions)
					this.log("Hub did not return positions for %d/%d", shadeId, position);
				if (callback) {
					if (positions && typeof positions[position] === 'number' && isFinite(positions[position])) {
						callback(null, positions[position]);
						this.log("updatePosition %d/%d: %d", shadeId, position, positions[position]);
					} else {
						// set postion to 0
						callback(null, 0);
						this.log("Invalid position value received for %d/%d", shadeId, position);
					}
				}
			}
		} else {
			if (callback) callback(err);
			this.log("Error %d/%d: %s", shadeId, position, err);
		}
	}.bind(this));
}

// Jogs the shade to update the shade information, and updates values.
PowerViewPlatform.prototype.jogShade = function (shadeId, callback) {
	this.hub.jogShade(shadeId, function (err, shade) {
		if (!err) {
			var positions = this.updateShadeValues(shade);

			if (callback) {
				if (positions && typeof positions[position] === 'number' && isFinite(positions[position])) {
					callback(null, positions);
				}
			}
		} else {
			if (callback) callback(err);
		}
	}.bind(this));
}


// Characteristic callback for CurrentPosition.get
PowerViewPlatform.prototype.getPosition = function (shadeId, position, callback) {
	this.log("getPosition %d/%d", shadeId, position);

	this.updatePosition(shadeId, position, this.refreshShades, function (err, value) {
		if (!err) {
			// If we're not refreshing by default, try again with a refresh.
			if (!this.refreshShades && value == null) {
				this.log("refresh %d/%d", shadeId, position);
				this.updatePosition(shadeId, position, true, callback);
			} else {
				callback(null, value);
			}
		} else {
			callback(err);
		}
	}.bind(this));
}

// Characteristic callback for TargetPosition.set
PowerViewPlatform.prototype.setPosition = function (shadeId, position, value, callback) {
	this.log("setPosition %d/%d = %d", shadeId, position, value);
	// Check if value is a valid number
	if (typeof value !== "number" || isNaN(value) || !isFinite(value)) {
		callback(new Error("Invalid value: " + value));
		return;
	}

	// Debounce disabled: send straight to the hub.
	if (!this.setPositionDebounceMs) {
		this.commitPosition(shadeId, position, value, callback);
		return;
	}

	// Coalesce rapid slider updates. Ack HomeKit immediately, remember the
	// latest value, and (re)start a per-(shade,position) timer. Only the final
	// value in a burst is sent to the hub, so the shade moves once to the
	// target instead of chasing every intermediate drag value.
	var key = shadeId + '/' + position;
	this._pendingPositions[key] = value;
	if (this._setTimers[key]) {
		clearTimeout(this._setTimers[key]);
	}
	this._setTimers[key] = setTimeout(function () {
		delete this._setTimers[key];
		var pending = this._pendingPositions[key];
		delete this._pendingPositions[key];
		this.commitPosition(shadeId, position, pending, function (err) {
			if (err) this.log("Deferred setPosition failed for %s: %s", key, err.message || err);
		}.bind(this));
	}.bind(this), this.setPositionDebounceMs);

	callback(null);
}

// Converts a HomeKit position value to the hub's raw scale.
PowerViewPlatform.prototype.toHubValue = function (shadeId, position, value) {
	switch (position) {
		case Position.BOTTOM:
		case Position.TOP:
			return Math.round(65535 * value / 100);
		case Position.VANES:
			var accessory = this.accessories[shadeId];
			if (accessory.context.shadeType == Shade.VERTICAL) {
				return Math.abs(Math.round(65535 * (value - 90) / 180));
			}
			return Math.round(32767 * value / 90);
	}
}

// Sends a move, unless the motion guard says the shade is already moving.
// Deciding is a purely local check against our own record of recent moves, so
// a command to an idle shade goes straight to the hub with no added latency.
// Only a shade we believe is mid-travel pays for a stop plus stopSettleMs.
PowerViewPlatform.prototype.commitPosition = function (shadeId, position, value, callback) {
	var hubValue = this.toHubValue(shadeId, position, value);

	if (this.enableMotionGuard && this.isMoving(shadeId)) {
		var m = this._motion[shadeId];
		if (m.stopping) {
			// A stop is already on its way; the latest target wins.
			this.addPending(m, shadeId, position, value, hubValue);
			callback(null);
			return;
		}
		var current = m.targets[position];
		if (current && current.hubValue === hubValue) {
			this.log("Shade %d/%d already moving to %d, ignoring repeat", shadeId, position, value);
			callback(null);
			return;
		}
		this.log("Shade %d/%d is moving, stopping it before new target %d", shadeId, position, value);
		this.stopThenMove(shadeId, position, value, hubValue);
		callback(null);
		return;
	}

	this.sendPosition(shadeId, position, value, hubValue, callback);
}

// Top-down/bottom-up shades have two independent rails, so a stop must not
// lose the other rail's move. On every other shade the positions interact
// (a vane tilt implies closed, an open overrides the vanes), so only the
// newest command survives.
PowerViewPlatform.prototype.hasIndependentRails = function (shadeId) {
	var accessory = this.accessories[shadeId];
	return !!accessory && accessory.context.shadeType == Shade.TOP_BOTTOM;
}

PowerViewPlatform.prototype.addPending = function (m, shadeId, position, value, hubValue) {
	if (!this.hasIndependentRails(shadeId)) m.pending = {};
	m.pending[position] = { value: value, hubValue: hubValue };
}

// Stops a moving shade, waits for it to settle, then sends the pending targets.
// If the stop request fails we cannot tell the shade halted, so we wait out the
// current move instead of reversing it mid-travel.
PowerViewPlatform.prototype.stopThenMove = function (shadeId, position, value, hubValue) {
	var m = this._motion[shadeId];
	var now = Date.now();
	m.stopping = true;
	m.pending = {};
	if (this.hasIndependentRails(shadeId)) {
		for (var pos in m.targets) {
			var t = m.targets[pos];
			if (pos != position && this.targetUntil(t, now) > now) m.pending[pos] = { value: t.value, hubValue: t.hubValue };
		}
	}
	this.addPending(m, shadeId, position, value, hubValue);

	this.hub.stopShade(shadeId, function (err) {
		var wait = this.stopSettleMs;
		if (err) {
			wait = Math.max(wait, this.travelRemainingMs(m));
			this.log("Stop failed for %d (%s), waiting %dms for the current move to finish", shadeId, (err && err.message) || err, wait);
		}
		setTimeout(function () {
			var pending = m.pending;
			delete this._motion[shadeId];
			// Where it halted is unknown, so the next move assumes full travel.
			delete this._knownPositions[shadeId];
			for (let pos in pending) {
				let p = parseInt(pos);
				this.sendPosition(shadeId, p, pending[pos].value, pending[pos].hubValue, function (e) {
					if (e) this.log("Move after stop failed for %d/%d: %s", shadeId, p, (e && e.message) || e);
				}.bind(this));
			}
		}.bind(this), wait);
	}.bind(this));
}

PowerViewPlatform.prototype.sendPosition = function (shadeId, position, value, hubValue, callback) {
	// Record the move before the PUT is queued, so a command arriving while it
	// waits in the hub queue already sees the shade as busy. The travel clock
	// only starts once the hub accepts the PUT.
	var target = this.enableMotionGuard ? this.markMoving(shadeId, position, value, hubValue) : null;

	this.hub.putShade(shadeId, position, hubValue, value, function (err, shade) {
		if (!err) {
			if (target) this.startTravel(target);
			this.updateShadeValues(shade, true);
			callback(null);
			if (this.enablePostMoveVerify) {
				this.scheduleVerify(shadeId, position);
			}
		} else {
			if (target) this.clearMoving(shadeId, position, target);
			callback(err);
		}
	}.bind(this));
}

// Full-travel time for a shade, reusing the verify delays as the estimate.
PowerViewPlatform.prototype.fullTravelMs = function (shadeId) {
	return this.slowShades.includes(shadeId) ? this.slowVerifyDelay : this.defaultVerifyDelay;
}

// When a target's move should be done. A move still waiting in the hub queue
// has not started, so it is busy indefinitely until the hub accepts it.
PowerViewPlatform.prototype.targetUntil = function (t, now) {
	return t.queued ? Infinity : t.until;
}

// Best guess at where a shade is right now, on the hub's raw scale. While a
// move is in flight we interpolate along it; otherwise we use the last trusted
// position, if it is recent. Returns undefined when we have no idea.
PowerViewPlatform.prototype.estimatePosition = function (shadeId, position) {
	var now = Date.now();
	var m = this._motion[shadeId];
	var t = m && m.targets[position];
	if (t) {
		if (t.queued) return t.from;
		if (now >= t.until) return t.hubValue;
		if (t.from === undefined) return undefined;
		var frac = (now - t.start) / (t.until - t.start);
		return Math.round(t.from + (t.hubValue - t.from) * frac);
	}
	var known = this._knownPositions[shadeId];
	var k = known && known[position];
	// A remote or the PowerView app can move a shade without the hub's cache
	// noticing, so an old position is not trusted for long.
	if (!k || now - k.at > this.knownPositionTtlMs) return undefined;
	return k.hubValue;
}

// Records a move as in progress. The window scales with distance (a 10% nudge
// is a fraction of a full run) so a shade is not treated as busy longer than
// it needs to be, with minMoveMs as a floor for motor start-up and RF latency.
// Unknown start = full travel.
PowerViewPlatform.prototype.markMoving = function (shadeId, position, value, hubValue) {
	var from = this.estimatePosition(shadeId, position);
	var full = this.fullTravelMs(shadeId);
	var range = position == Position.VANES ? 32767 : 65535;
	var travel = from === undefined ? full : Math.round(full * Math.min(1, Math.abs(hubValue - from) / range));

	var m = this._motion[shadeId] || (this._motion[shadeId] = { targets: {}, pending: {}, stopping: false });
	var target = {
		value: value, hubValue: hubValue, from: from,
		duration: Math.max(this.minMoveMs, travel),
		queued: true, created: Date.now(), start: null, until: null
	};
	m.targets[position] = target;
	return target;
}

PowerViewPlatform.prototype.startTravel = function (target) {
	var now = Date.now();
	target.queued = false;
	target.start = now;
	target.until = now + target.duration;
	this.log.debug("Shade moving to %d for ~%dms", target.value, target.duration);
}

// Drops a target, but only if it is still the one we recorded (a newer move or
// a stop may have replaced it in the meantime).
PowerViewPlatform.prototype.clearMoving = function (shadeId, position, target) {
	var m = this._motion[shadeId];
	if (!m || m.stopping || m.targets[position] !== target) return;
	delete m.targets[position];
	if (Object.keys(m.targets).length === 0) delete this._motion[shadeId];
}

// True while a stop is pending or any position of the shade is in flight.
PowerViewPlatform.prototype.isMoving = function (shadeId) {
	var m = this._motion[shadeId];
	if (!m) return false;
	if (m.stopping) return true;
	var now = Date.now();
	for (var pos in m.targets) {
		if (this.targetUntil(m.targets[pos], now) > now) return true;
	}
	this.rememberPositions(shadeId, m.targets);
	delete this._motion[shadeId];
	return false;
}

// Records trusted raw positions for a shade, keyed by position kind.
PowerViewPlatform.prototype.rememberPositions = function (shadeId, targets) {
	var known = this._knownPositions[shadeId] || (this._knownPositions[shadeId] = {});
	var now = Date.now();
	for (var pos in targets) {
		if (targets[pos].hubValue !== undefined) known[pos] = { hubValue: targets[pos].hubValue, at: now };
	}
}

// Records the positions from a real RF read of the shade. Reads the hub
// downgraded to a cached read (because the shade was moving) don't count.
PowerViewPlatform.prototype.rememberRefreshed = function (shade) {
	if (!shade || !shade.positions || shade.timedOut || shade.notRefreshed) return;
	var targets = {};
	for (var i = 1; shade.positions['posKind' + i]; ++i) {
		targets[shade.positions['posKind' + i]] = { hubValue: shade.positions['position' + i] };
	}
	this.rememberPositions(shade.id, targets);
}

// If the hub reports an idle shade somewhere other than where we last trusted
// it, something outside the plugin moved it: forget the old position.
PowerViewPlatform.prototype.noteObservedPositions = function (shade) {
	if (!shade || !shade.positions || this.isMoving(shade.id)) return;
	var known = this._knownPositions[shade.id];
	if (!known) return;
	for (var i = 1; shade.positions['posKind' + i]; ++i) {
		var k = known[shade.positions['posKind' + i]];
		if (k && Math.abs(k.hubValue - shade.positions['position' + i]) > 655) {
			delete this._knownPositions[shade.id];
			return;
		}
	}
}

// Milliseconds until the in-flight moves should be done, ignoring any stop.
PowerViewPlatform.prototype.travelRemainingMs = function (m) {
	var now = Date.now(), last = now;
	for (var pos in m.targets) {
		var t = m.targets[pos];
		last = Math.max(last, t.queued ? now + t.duration : t.until);
	}
	return last - now;
}

// Milliseconds until the shade should have finished moving (0 if idle).
PowerViewPlatform.prototype.movingRemainingMs = function (shadeId) {
	if (!this.isMoving(shadeId)) return 0;
	var m = this._motion[shadeId];
	if (m.stopping) return this.stopSettleMs;
	return Math.max(this.travelRemainingMs(m), 1000);
}

// Converts a raw hub value back to the HomeKit scale for a shade.
PowerViewPlatform.prototype.fromHubValue = function (shadeId, position, hubValue) {
	if (position == Position.VANES) {
		var accessory = this.accessories[shadeId];
		if (accessory && accessory.context.shadeType == Shade.VERTICAL) return 90 - Math.round(180 * hubValue / 65535);
		return Math.round(90 * hubValue / 32767);
	}
	return Math.round(100 * hubValue / 65535);
}

// Caches which shades each hub scene moves, so activating a scene can mark
// them busy at once instead of waiting on a second hub request.
PowerViewPlatform.prototype.loadSceneMembers = function (callback) {
	this.hub.getSceneMembers(null, function (err, members) {
		if (!err) {
			var byScene = {};
			for (var member of members) {
				(byScene[member.sceneId] = byScene[member.sceneId] || []).push(member);
			}
			this._sceneMembers = byScene;
		}
		if (callback) callback(err);
	}.bind(this));
}

// Marks a scene's member shades as moving to the scene's targets. Shades that
// got a newer individual command after `since` are left alone.
PowerViewPlatform.prototype.markSceneMoving = function (sceneId, members, since) {
	var now = Date.now();
	for (var member of members) {
		var shadeId = member.shadeId;
		if (!this.accessories[shadeId]) continue;
		var m = this._motion[shadeId];
		if (m && (m.stopping || Object.keys(m.targets).some(function (p) { return m.targets[p].created > since; }))) continue;
		m = this._motion[shadeId] = { targets: {}, pending: {}, stopping: false };
		var positions = member.positions || {};
		for (var i = 1; positions['posKind' + i]; ++i) {
			var pos = positions['posKind' + i];
			var hubValue = positions['position' + i];
			var duration = Math.max(this.minMoveMs, this.fullTravelMs(shadeId));
			m.targets[pos] = {
				value: this.fromHubValue(shadeId, pos, hubValue), hubValue: hubValue, from: undefined,
				duration: duration, queued: false, created: now, start: now, until: now + duration, scene: sceneId
			};
		}
		if (Object.keys(m.targets).length === 0) delete this._motion[shadeId];
	}
}

// Undo a scene's marks after the activation failed.
PowerViewPlatform.prototype.clearSceneMoving = function (sceneId) {
	for (var shadeId in this._motion) {
		var m = this._motion[shadeId];
		for (var pos in m.targets) {
			if (m.targets[pos].scene === sceneId) delete m.targets[pos];
		}
		if (!m.stopping && Object.keys(m.targets).length === 0) delete this._motion[shadeId];
	}
}

// Schedule a coalesced post-move verify for a shade. If a prior verify is
// pending for the same shade, cancel it and reschedule — so N rapid taps
// collapse to 1 RF query.
PowerViewPlatform.prototype.scheduleVerify = function (shadeId, position) {
	if (this._verifyTimers[shadeId]) {
		clearTimeout(this._verifyTimers[shadeId]);
	}
	var run = function () {
		delete this._verifyTimers[shadeId];
		// Still moving (a later move or a stop extended it): wait until it
		// should be done, rather than RF-querying a shade mid-travel.
		var remaining = this.enableMotionGuard ? this.movingRemainingMs(shadeId) : 0;
		if (remaining > 0) {
			this._verifyTimers[shadeId] = setTimeout(run, remaining);
			return;
		}
		this.log("post-move verify %d/%d", shadeId, position);
		this.updatePosition(shadeId, position, true, function (e) {
			if (e) this.log("post-move verify failed for %d/%d: %s", shadeId, position, e.message);
		}.bind(this));
	}.bind(this);
	this._verifyTimers[shadeId] = setTimeout(run, this.fullTravelMs(shadeId));
}

// Run a sequential ?refresh=true walk across all known shades. Each call is a
// real RF round-trip to the shade — catches drift the hub cache misses. Spaced
// to avoid hub overload and HomeKit characteristic timeouts. Replaces the
// out-of-process cron sweep that previously lived in powerview-refresh.sh.
//
// Calls hub.getShade directly (rather than this.updateShade) so we can pass
// `current = true` to updateShadeValues, which pushes CurrentPosition via
// setCharacteristic and notifies HomeKit subscribers. updateShade(..) only
// touches TargetPosition, which would leave HomeKit's current value stale —
// the exact drift the heal sweep is supposed to fix.
PowerViewPlatform.prototype.runHealSweep = function () {
	if (this._healInProgress) {
		this.log("Heal sweep already in progress, skipping");
		return;
	}
	var ids = Object.keys(this.accessories).map(function (k) { return parseInt(k); });
	if (ids.length === 0) {
		return;
	}
	this._healInProgress = true;
	this.log("Heal sweep starting (%d shades, %dms gap)", ids.length, this.healSweepGapMs);
	var i = 0;
	var self = this;
	var next = function () {
		if (i >= ids.length) {
			self._healInProgress = false;
			self.log("Heal sweep complete (%d shades)", ids.length);
			return;
		}
		var id = ids[i++];
		if (self.enableMotionGuard && self.isMoving(id)) {
			self.log.debug("Heal sweep skipping %d: moving", id);
			setTimeout(next, 0);
			return;
		}
		self.hub.getShade(id, true, function (err, shade) {
			if (err) {
				self.log.debug("Heal sweep error for %d: %s", id, (err && err.message) || err);
			} else if (shade && shade.timedOut) {
				self.log.debug("Heal sweep RF timeout for %d", id);
			} else if (shade) {
				self.rememberRefreshed(shade);
				self.updateShadeValues(shade, true);
			}
			setTimeout(next, self.healSweepGapMs);
		});
	};
	next();
}
