'use strict';
// Motion guard: commands to an idle shade go straight out, commands to a
// moving shade are deduped or preceded by a stop, and RF queries wait.
const test = require('node:test');
const assert = require('node:assert');

let Platform;
require('../index.js')({
	platformAccessory: function () {},
	hap: { Service: {}, Characteristic: {}, uuid: { generate: String } },
	registerPlatform: function (_a, _b, ctor) { Platform = ctor; },
});

const BOTTOM = 1;
const SHADE = 55357;

function makePlatform(t, extra) {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
	const log = function () { log.lines.push(Array.from(arguments).join(' ')); };
	log.lines = [];
	log.debug = function () {};
	const config = Object.assign({
		platform: 'PowerView',
		enablePostMoveVerify: false,
		healSweepIntervalMinutes: 0,
		slowShades: [SHADE],
		slowVerifyDelay: 45000,
		setPositionDebounceMs: 0,
	}, extra);
	const p = new Platform(log, config, { on: function () {} });
	p.accessories[SHADE] = { context: { shadeType: 1 } };
	p.updateShadeValues = function () { return {}; };
	const calls = [];
	p.hub = {
		putShade: function (id, pos, hubValue, value, cb) { calls.push(['put', id, value]); cb(null, { id: id }); },
		stopShade: function (id, cb) { calls.push(['stop', id]); cb(null, { id: id }); },
		getShade: function (id, refresh, cb) {
			calls.push(['get', id, refresh]);
			cb(null, { id: id, positions: { posKind1: 1, position1: 0 } });
		},
		getSceneMembers: function (sceneId, cb) {
			cb(null, [{ sceneId: sceneId, shadeId: SHADE, positions: { posKind1: 1, position1: 65535 } }]);
		},
		activateScene: function (sceneId, cb) { calls.push(['scene', sceneId]); cb(null, {}); },
	};
	return { p, calls, log };
}

function set(p, value) {
	p.setPosition(SHADE, BOTTOM, value, function (err) { assert.ifError(err); });
}

test('a command to an idle shade is sent immediately with no stop', (t) => {
	const { p, calls } = makePlatform(t);
	set(p, 100);
	assert.deepStrictEqual(calls, [['put', SHADE, 100]]);
});

test('repeating the same target while moving is dropped', (t) => {
	const { p, calls } = makePlatform(t);
	set(p, 0);
	t.mock.timers.tick(8000);
	set(p, 0);
	assert.deepStrictEqual(calls, [['put', SHADE, 0]]);
});

test('a new target while moving stops first, then moves after the settle', (t) => {
	const { p, calls } = makePlatform(t);
	set(p, 100);
	t.mock.timers.tick(7000);
	set(p, 0);
	assert.deepStrictEqual(calls, [['put', SHADE, 100], ['stop', SHADE]]);
	t.mock.timers.tick(1999);
	assert.strictEqual(calls.length, 2);
	t.mock.timers.tick(1);
	assert.deepStrictEqual(calls[2], ['put', SHADE, 0]);
});

test('commands during the stop settle collapse to the latest target', (t) => {
	const { p, calls } = makePlatform(t);
	set(p, 100);
	t.mock.timers.tick(5000);
	set(p, 0);
	set(p, 40);
	t.mock.timers.tick(2000);
	assert.deepStrictEqual(calls, [['put', SHADE, 100], ['stop', SHADE], ['put', SHADE, 40]]);
});

test('once travel time has passed the next command goes straight out', (t) => {
	const { p, calls } = makePlatform(t);
	set(p, 100);
	t.mock.timers.tick(45001);
	set(p, 0);
	assert.deepStrictEqual(calls, [['put', SHADE, 100], ['put', SHADE, 0]]);
});

test('a short move from a known position only blocks for the scaled window', (t) => {
	const { p, calls } = makePlatform(t);
	p.updateShade(SHADE, true);   // RF read: shade at 0
	set(p, 10);                   // 10% of 45s = 4.5s, floored to minMoveMs 5s
	t.mock.timers.tick(5001);
	set(p, 0);
	assert.deepStrictEqual(calls.filter((c) => c[0] !== 'get'), [['put', SHADE, 10], ['put', SHADE, 0]]);
});

test('after a stop the halt point is unknown, so the next move assumes full travel', (t) => {
	const { p, calls } = makePlatform(t);
	p.updateShade(SHADE, true);
	set(p, 100);
	t.mock.timers.tick(5000);
	set(p, 90);                   // stop, then move to 90
	t.mock.timers.tick(2000);
	t.mock.timers.tick(10000);    // a 10% move would be done, a full one would not
	set(p, 0);
	assert.deepStrictEqual(calls.filter((c) => c[0] !== 'get').map((c) => c[0]), ['put', 'stop', 'put', 'stop']);
});

test('RF refresh is downgraded to a cached read while the shade moves', (t) => {
	const { p, calls } = makePlatform(t);
	set(p, 100);
	p.updateShade(SHADE, true);
	assert.deepStrictEqual(calls[1], ['get', SHADE, false]);
	t.mock.timers.tick(45001);
	p.updateShade(SHADE, true);
	assert.deepStrictEqual(calls[2], ['get', SHADE, true]);
});

test('post-move verify waits for a move that started after it was scheduled', (t) => {
	const { p, calls } = makePlatform(t, { enablePostMoveVerify: true });
	set(p, 100);                  // verify due at +45s
	t.mock.timers.tick(30000);
	p.markMoving(SHADE, BOTTOM, 0, 0); // e.g. a Pico-driven move recorded elsewhere
	t.mock.timers.tick(15000);
	assert.ok(!calls.some((c) => c[0] === 'get'), 'no RF query mid-travel');
	t.mock.timers.tick(45000);
	assert.deepStrictEqual(calls.filter((c) => c[0] === 'get'), [['get', SHADE, true]]);
});

test('a scene activation marks member shades as moving', (t) => {
	const { p, calls } = makePlatform(t);
	const service = { updateCharacteristic: function () {} };
	p.setScene({ context: { sceneId: 7 }, displayName: 'Open', getService: () => service }, true, function () {});
	set(p, 0);
	assert.deepStrictEqual(calls, [['scene', 7], ['stop', SHADE]]);
});

test('the guard can be turned off', (t) => {
	const { p, calls } = makePlatform(t, { enableMotionGuard: false });
	set(p, 100);
	t.mock.timers.tick(1000);
	set(p, 0);
	assert.deepStrictEqual(calls, [['put', SHADE, 100], ['put', SHADE, 0]]);
});
