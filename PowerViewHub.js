let InitialRequestDelayMs = 100;
let RequestIntervalMs = 100;

let Position = {
	BOTTOM: 1,
	TOP: 2,
	VANES: 3
}
exports.Position = Position;


function PowerViewHub(log, host) {
	this.log = log;
	this.host = host;

	this.queue = [];
}
exports.PowerViewHub = PowerViewHub;

// Performs an HTTP request against the hub and parses the JSON response.
// Preserves the callback(err, parsedBody) contract the rest of the plugin
// expects, so callers stay synchronous-looking. Replaces the deprecated
// `request` library with the native global fetch (Node 18+/22+).
PowerViewHub.prototype.httpJson = function (path, options, callback) {
	options = options || {};

	var url = "http://" + this.host + path;
	if (options.qs) {
		var params = new URLSearchParams(options.qs);
		url += "?" + params.toString();
	}

	var init = { method: options.method || 'GET' };
	if (options.json !== undefined) {
		init.headers = { 'Content-Type': 'application/json' };
		init.body = JSON.stringify(options.json);
	}

	// Parse errors (network, non-200, bad JSON) are routed to callback(err)
	// via the final onRejected handler. Delivery (callback(null, json)) lives
	// in onFulfilled of that same .then, so a throw from the callback itself
	// does NOT loop back into the error path and fire the callback twice.
	fetch(url, init).then(function (response) {
		if (response.status != 200) {
			throw new Error("HTTP Error " + response.status);
		}
		return response.text();
	}).then(function (text) {
		return text ? JSON.parse(text) : {};
	}).then(function (json) {
		callback(null, json);
	}, function (err) {
		callback(err);
	});
}

// Queue a shades API request.
PowerViewHub.prototype.queueRequest = function(queued) {
	if (!this.queue.length)
		this.scheduleRequest(InitialRequestDelayMs);

	this.queue.push(queued);
}

// Schedules a shades API PUT request.
PowerViewHub.prototype.scheduleRequest = function(delay) {
	setTimeout(function() {
		// Take the first queue item, and remove the data so that future requests don't try and modify it.
		// Leave an object in the queue though so queueRequest() doesnt schedule this method while the
		// request is in-flight, since we re-schedule ourselves if the queue has items.
		var queued = this.queue[0];
		this.queue[0] = {};

		var options = {};
		if (queued.data) {
			options.method = 'PUT';
			options.json = { 'shade': queued.data };

			this.log("Put for", queued.shadeId, queued.data);
		}

		if (queued.qs) {
			options.qs = queued.qs;
		}

		this.httpJson("/api/shades/" + queued.shadeId, options, function(err, json) {
			if (!err) {
				for (var callback of queued.callbacks) {
					callback(null, json.shade);
				}
			} else {
				this.log("Error setting position: %s", err);
				for (var callback of queued.callbacks) {
					callback(err);
				}
			}

			this.queue.shift();
			if (this.queue.length > 0) {
				this.scheduleRequest(RequestIntervalMs);
			}
		}.bind(this));
	}.bind(this), delay);
}


// Makes a userdata API request.
PowerViewHub.prototype.getUserData = function(callback) {
	this.httpJson("/api/userdata", {}, function(err, json) {
		if (!err) {
			if (callback) callback(null, json.userData);
		} else {
			this.log("Error getting userdata: %s", err);
			if (callback) callback(err);
		}
	}.bind(this));
}

// Makes a shades API request.
PowerViewHub.prototype.getShades = function(callback) {
	this.httpJson("/api/shades", {}, function(err, json) {
		if (!err) {
			if (callback) callback(null, json.shadeData);
		} else {
			this.log("Error getting shades: %s", err);
			if (callback) callback(err);
		}
	}.bind(this));
}

// Makes a scenes API request to list all scenes defined on the hub.
PowerViewHub.prototype.getScenes = function(callback) {
	this.httpJson("/api/scenes", {}, function(err, json) {
		if (!err) {
			if (callback) callback(null, json.sceneData || []);
		} else {
			this.log("Error getting scenes: %s", err);
			if (callback) callback(err);
		}
	}.bind(this));
}

// Activates a scene by id. This is a single hub call — the hub then drives
// every shade in the scene near-simultaneously over RF, which is far faster
// than issuing per-shade position PUTs (those serialize through the queue at
// ~2s each). Deliberately bypasses the shade queue: it's a distinct GET and
// carries no /api/shades payload, so it can't collide with in-flight PUTs.
PowerViewHub.prototype.activateScene = function(sceneId, callback) {
	this.log("Activate scene", sceneId);
	this.httpJson("/api/scenes", { qs: { sceneId: sceneId } }, function(err, json) {
		if (!err) {
			if (callback) callback(null, json);
		} else {
			this.log("Error activating scene %s: %s", sceneId, err);
			if (callback) callback(err);
		}
	}.bind(this));
}

// Makes a shades API request for a single shade.
PowerViewHub.prototype.getShade = function(shadeId, refresh = false, callback) {
	// Refresh is handled through queued requests, because the PowerView hub likes to
	// crash if we send too many of these at once.
	if (refresh) {
		for (var queued of this.queue) {
			if (queued.shadeId == shadeId && queued.qs) {
				queued.callbacks.push(callback);
				return;
			}
		}

		var queued = {
			'shadeId': shadeId,
			'qs': { 'refresh': 'true' },
			'callbacks': [callback]
		}
		this.queueRequest(queued);
		return;
	}

	this.httpJson("/api/shades/" + shadeId, {}, function(err, json) {
		if (!err) {
			if (callback) callback(null, json.shade);
		} else {
			this.log("Error getting shade: %s", err);
			if (callback) callback(err);
		}
	}.bind(this));
}

// Makes a shades API request to change the position of a single shade.
// Requests are queued so only one is in flight at a time, and they are smart merged.
PowerViewHub.prototype.putShade = function(shadeId, position, value, userValue,callback) {
	for (var queued of this.queue) {
		if (queued.shadeId == shadeId && queued.data && queued.data.positions) {
			// Parse out the positions data back into a list of position to value.
			var positions = [];
			for (var i = 1; queued.data.positions['posKind'+i]; ++i) {
				positions[queued.data.positions['posKind'+i]] = queued.data.positions['position'+i];
			}

			// Set the new position.
			positions[position] = value;

			if (position == Position.VANES && userValue) {
				// Setting a non-zero vanes position overrides any bottom position since
				// this will close the shades.
				delete positions[Position.BOTTOM];
			} else if (position == Position.VANES && positions[Position.BOTTOM] != null) {
				// Otherwise don't set a zero vanes position if there's a bottom position.
				delete positions[Position.VANES];
			} else if (position == Position.BOTTOM && userValue) {
				// Setting a non-zero bottom position overrides any vanes position since
				// this will open the shades.
				delete positions[Position.VANES];
			} else if (position == Position.BOTTOM && positions[Position.VANES] != null) {
				// Otherwise don't set a zero bottom position if there's a vanes position.
				delete position[Position.BOTTOM];
			}

			// Reconstruct the data again, this places it back in position order.
			i = 1;
			queued.data.positions = {};
			for (var position in positions) {
				queued.data.positions['posKind'+i] = parseInt(position);
				queued.data.positions['position'+i] = positions[position];
				++i;
			}

			queued.callbacks.push(callback);
			return;
		}
	}

	var queued = {
		'shadeId': shadeId,
		'data': {
			'positions': {
				'posKind1': position,
				'position1': value
			}
		},
		'callbacks': [callback]
	}


	this.queueRequest(queued);
}

// Makes a shades API request to jog a shade.
PowerViewHub.prototype.jogShade = function(shadeId, callback) {
	for (var queued of this.queue) {
		if (queued.shadeId == shadeId && queued.data && queued.data.motion == 'jog') {
			queued.callbacks.push(callback);
			return;
		}
	}

	var queued = {
		'shadeId': shadeId,
		'data': { 'motion': 'jog' },
		'callbacks': [callback]
	}
	this.queueRequest(queued);
}

// Makes a shades API request to calibrate a shade.
PowerViewHub.prototype.calibrateShade = function(shadeId, callback) {
	for (var queued of this.queue) {
		if (queued.shadeId == shadeId && queued.data && queued.data.motion == 'calibrate') {
			queued.callbacks.push(callback);
			return;
		}
	}

	var queued = {
		'shadeId': shadeId,
		'data': { 'motion': 'calibrate' },
		'callbacks': [callback]
	}
	this.queueRequest(queued);
}
