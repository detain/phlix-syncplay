//#region src/messages.ts
var e = {
	GROUP_CREATE: "syncplay_group_create",
	GROUP_JOIN: "syncplay_group_join",
	GROUP_LEAVE: "syncplay_group_leave",
	GROUP_STATE: "syncplay_group_state",
	GROUP_LIST: "syncplay_group_list",
	PLAYBACK_PLAY: "syncplay_playback_play",
	PLAYBACK_PAUSE: "syncplay_playback_pause",
	PLAYBACK_SEEK: "syncplay_playback_seek",
	PLAYBACK_QUEUE: "syncplay_playback_queue",
	PLAYBACK_SYNC: "syncplay_playback_sync",
	CHAT: "syncplay_chat",
	TYPING: "syncplay_typing",
	HOST_TRANSFER: "syncplay_host_transfer",
	HOST_ELECT: "syncplay_host_elect",
	TIME_PING: "syncplay_time_ping",
	TIME_PONG: "syncplay_time_pong",
	TIME_SYNC: "syncplay_time_sync",
	ERROR: "syncplay_error",
	INFO: "syncplay_info"
}, t = 1, n = Object.freeze([
	e.GROUP_CREATE,
	e.GROUP_JOIN,
	e.GROUP_LEAVE,
	e.GROUP_STATE,
	e.GROUP_LIST,
	e.PLAYBACK_PLAY,
	e.PLAYBACK_PAUSE,
	e.PLAYBACK_SEEK,
	e.PLAYBACK_QUEUE,
	e.PLAYBACK_SYNC,
	e.CHAT,
	e.TYPING,
	e.HOST_TRANSFER,
	e.HOST_ELECT,
	e.TIME_PING,
	e.TIME_PONG,
	e.TIME_SYNC,
	e.ERROR,
	e.INFO
]);
function r(e) {
	return n.includes(e);
}
//#endregion
//#region \0@oxc-project+runtime@0.154.0/helpers/esm/typeof.js
function i(e) {
	"@babel/helpers - typeof";
	return i = typeof Symbol == "function" && typeof Symbol.iterator == "symbol" ? function(e) {
		return typeof e;
	} : function(e) {
		return e && typeof Symbol == "function" && e.constructor === Symbol && e !== Symbol.prototype ? "symbol" : typeof e;
	}, i(e);
}
//#endregion
//#region \0@oxc-project+runtime@0.154.0/helpers/esm/toPrimitive.js
function a(e, t) {
	if (i(e) != "object" || !e) return e;
	var n = e[Symbol.toPrimitive];
	if (n !== void 0) {
		var r = n.call(e, t || "default");
		if (i(r) != "object") return r;
		throw TypeError("@@toPrimitive must return a primitive value.");
	}
	return (t === "string" ? String : Number)(e);
}
//#endregion
//#region \0@oxc-project+runtime@0.154.0/helpers/esm/toPropertyKey.js
function o(e) {
	var t = a(e, "string");
	return i(t) == "symbol" ? t : t + "";
}
//#endregion
//#region \0@oxc-project+runtime@0.154.0/helpers/esm/defineProperty.js
function s(e, t, n) {
	return (t = o(t)) in e ? Object.defineProperty(e, t, {
		value: n,
		enumerable: !0,
		configurable: !0,
		writable: !0
	}) : e[t] = n, e;
}
//#endregion
//#region \0@oxc-project+runtime@0.154.0/helpers/esm/objectSpread2.js
function c(e, t) {
	var n = Object.keys(e);
	if (Object.getOwnPropertySymbols) {
		var r = Object.getOwnPropertySymbols(e);
		t && (r = r.filter(function(t) {
			return Object.getOwnPropertyDescriptor(e, t).enumerable;
		})), n.push.apply(n, r);
	}
	return n;
}
function l(e) {
	for (var t = 1; t < arguments.length; t++) {
		var n = arguments[t] == null ? {} : arguments[t];
		t % 2 ? c(Object(n), !0).forEach(function(t) {
			s(e, t, n[t]);
		}) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(n)) : c(Object(n)).forEach(function(t) {
			Object.defineProperty(e, t, Object.getOwnPropertyDescriptor(n, t));
		});
	}
	return e;
}
//#endregion
//#region src/framing.ts
function u(e, t, n) {
	return l(l({}, t), {}, {
		type: e,
		protocol_version: 1,
		timestamp: n()
	});
}
function d(e) {
	let t = e;
	if (typeof e == "string") try {
		t = JSON.parse(e);
	} catch (e) {
		return null;
	}
	if (typeof t != "object" || !t || Array.isArray(t)) return null;
	let n = t;
	if (typeof n.type != "string") return null;
	let i = n.data, a = !("protocol_version" in n) && typeof i == "object" && i && !Array.isArray(i) ? (() => {
		let e = {};
		for (let t of Object.keys(n)) t !== "data" && (e[t] = n[t]);
		return l(l({}, i), e);
	})() : n;
	return r(n.type), a;
}
function f(e) {
	return JSON.stringify(e);
}
//#endregion
//#region src/time-sync.ts
var p = 5, m = 1e3, h = 50, g = .1, _ = .99, v = 1.01, y = 1, b = class {
	constructor(e) {
		s(this, "samples", []), s(this, "driftRate", 1), s(this, "now", void 0), s(this, "samplesVersion", 0), s(this, "cacheVersion", -1), s(this, "cachedOffset", 0), s(this, "cachedLatency", 0), s(this, "cachedIsStable", !1), this.now = e;
	}
	addSample(e, t, n, r) {
		let i = r - e - (n - t);
		if (i < 0 || i > 1e3) return !1;
		let a = i / 2, o = t - e + Math.trunc(a);
		return this.samples.push({
			offset: o,
			rtt: i,
			timestamp: this.now() / 1e3
		}), this.samples.length > 10 && this.samples.shift(), this.samplesVersion++, this.updateDriftRate(), !0;
	}
	ensureWindowCache() {
		this.cacheVersion !== this.samplesVersion && (this.cachedOffset = this.computeOffset(), this.cachedLatency = this.computeLatency(), this.cachedIsStable = this.computeIsStable(), this.cacheVersion = this.samplesVersion);
	}
	getOffset() {
		return this.ensureWindowCache(), this.cachedOffset;
	}
	computeOffset() {
		if (this.samples.length === 0) return 0;
		let e = this.samples.slice(-5), t = 0, n = 0;
		for (let r of e) {
			let e = 1 / Math.max(1, r.rtt);
			t += r.offset * e, n += e;
		}
		return n === 0 ? 0 : Math.round(t / n);
	}
	getLatency() {
		return this.ensureWindowCache(), this.cachedLatency;
	}
	computeLatency() {
		if (this.samples.length === 0) return 0;
		let e = this.samples.slice(-5), t = 0;
		for (let n of e) t += n.rtt / 2;
		return Math.trunc(t / Math.max(1, e.length));
	}
	isStable() {
		return this.ensureWindowCache(), this.cachedIsStable;
	}
	computeIsStable() {
		if (this.samples.length < 5) return !1;
		let e = this.samples.slice(-5).map((e) => e.offset), t = e.reduce((e, t) => e + t, 0) / e.length, n = 0;
		for (let r of e) {
			let e = r - t;
			n += e * e;
		}
		return n / e.length < 50;
	}
	updateDriftRate() {
		if (this.samples.length < 2) return;
		let e = this.samples.slice(-5);
		if (e.length < 2) return;
		let t = e[0], n = e[e.length - 1], r = n.timestamp - t.timestamp;
		if (r <= 0) return;
		let i = (n.offset - t.offset) / r;
		this.driftRate = 1 + g * i / 1e3, this.driftRate = Math.min(v, Math.max(_, this.driftRate));
	}
	getDriftRate() {
		return this.driftRate;
	}
	getSampleCount() {
		return this.samples.length;
	}
	getSynchronizedTime(e) {
		return e + this.getOffset();
	}
	getAdjustedPosition(e, t, n) {
		return e + (this.getSynchronizedTime(n) - t) * this.driftRate;
	}
	reset() {
		this.samples = [], this.driftRate = 1, this.samplesVersion++;
	}
	getSampleAgeMs() {
		let e = this.samples[this.samples.length - 1];
		return e === void 0 ? null : Math.max(0, this.now() - e.timestamp * 1e3);
	}
	getStatus() {
		return {
			offset: this.getOffset(),
			latency: this.getLatency(),
			driftRate: this.driftRate,
			isStable: this.isStable(),
			sampleCount: this.samples.length
		};
	}
}, x = 250, S = class t {
	constructor(e) {
		var n;
		s(this, "send", void 0), s(this, "now", void 0), s(this, "memberId", void 0), s(this, "memberName", void 0), s(this, "options", void 0), s(this, "timeSync", void 0), s(this, "seekThrottleMs", void 0), s(this, "seekWindowOpen", !1), s(this, "pendingSeek", null), s(this, "seekFlushTimer", null), s(this, "group", null), s(this, "destroyed", !1), s(this, "lastPingSendTime", null), s(this, "connectionEpoch", 0), s(this, "pingEpoch", 0), s(this, "consecutiveSyncRejections", 0), this.options = e, this.send = e.send, this.now = e.now, this.memberId = e.memberId, this.memberName = (n = e.memberName) == null ? "User" : n, this.timeSync = new b(e.now), this.seekThrottleMs = t.parseSeekThrottleMs(e.seekThrottleMs);
	}
	static parseSeekThrottleMs(e) {
		if (e === void 0) return x;
		if (typeof e != "number" || !Number.isFinite(e) || e < 0) throw TypeError(`SyncPlayClient: seekThrottleMs must be a finite number >= 0 (0 disables the seek coalescing throttle), got ${String(e)}`);
		return e;
	}
	static parsePasswordHash(e) {
		if (e !== void 0) {
			if (typeof e != "string" || !/^([0-9a-f]{64})$/.test(e)) {
				let t = typeof e == "string" ? ` of length ${e.length}` : "";
				throw TypeError(`SyncPlayClient: passwordHash must be undefined or 64 lowercase hex characters (unsalted SHA-256 hex; SPEC §4/§8.2, canonical form of the server gate SyncPlayManager::groupPasswordGate) — this library ships canonical form only: a present-but-malformed value is refused as a local fail-fast (stricter than the server, whose gate case-folds before matching) and is never shipped or coerced. Got a ${typeof e}${t}.`);
			}
			return e;
		}
	}
	getTimeSync() {
		return this.timeSync;
	}
	getGroup() {
		return this.group;
	}
	getMemberId() {
		return this.memberId;
	}
	isHost() {
		return this.group !== null && this.group.host_id === this.memberId;
	}
	getSynchronizedTime() {
		return this.timeSync.getSynchronizedTime(this.now());
	}
	createGroup(n, r) {
		let i = t.parsePasswordHash(r);
		if (this.destroyed) return;
		let a = {
			group_name: n,
			member_id: this.memberId,
			member_name: this.memberName
		};
		i !== void 0 && (a.password_hash = i), this.dispatch(e.GROUP_CREATE, a);
	}
	joinGroup(n, r) {
		let i = t.parsePasswordHash(r);
		if (this.destroyed) return;
		let a = {
			group_id: n,
			member_id: this.memberId,
			member_name: this.memberName
		};
		i !== void 0 && (a.password_hash = i), this.dispatch(e.GROUP_JOIN, a);
	}
	leaveGroup() {
		if (this.group === null) return !1;
		this.cancelSeekCoalescing();
		let t = this.group.group_id;
		return this.group = null, this.dispatch(e.GROUP_LEAVE, {
			group_id: t,
			member_id: this.memberId
		}), !0;
	}
	sendPlay(t) {
		return this.group !== null && (this.dispatch(e.PLAYBACK_PLAY, {
			group_id: this.group.group_id,
			member_id: this.memberId,
			position: t,
			server_time: this.getSynchronizedTime()
		}), !0);
	}
	sendPause(t) {
		return this.group !== null && (this.dispatch(e.PLAYBACK_PAUSE, {
			group_id: this.group.group_id,
			member_id: this.memberId,
			position: t,
			server_time: this.getSynchronizedTime()
		}), !0);
	}
	sendSeek(e, t) {
		return this.group === null ? !1 : this.seekWindowOpen ? (this.pendingSeek = {
			from: e,
			to: t
		}, !0) : (this.dispatchSeek(e, t), this.seekThrottleMs > 0 && !this.seekWindowOpen && this.openSeekWindow(), !0);
	}
	dispatchSeek(t, n) {
		this.group !== null && this.dispatch(e.PLAYBACK_SEEK, {
			group_id: this.group.group_id,
			member_id: this.memberId,
			from_position: t,
			to_position: n,
			server_time: this.getSynchronizedTime()
		});
	}
	openSeekWindow() {
		this.seekWindowOpen = !0, this.seekFlushTimer = setTimeout(() => {
			try {
				this.closeSeekWindow();
			} catch (n) {
				var e, t;
				(e = (t = this.options).onFrameDropped) == null || e.call(t, "send-failed", null);
			}
		}, this.seekThrottleMs);
	}
	closeSeekWindow() {
		this.seekWindowOpen = !1, this.seekFlushTimer = null;
		let e = this.pendingSeek;
		e !== null && (this.pendingSeek = null, this.group !== null && (this.dispatchSeek(e.from, e.to), !this.destroyed && this.group !== null && this.seekThrottleMs > 0 && !this.seekWindowOpen && this.openSeekWindow()));
	}
	cancelSeekCoalescing() {
		this.pendingSeek = null, this.seekFlushTimer !== null && (clearTimeout(this.seekFlushTimer), this.seekFlushTimer = null), this.seekWindowOpen = !1;
	}
	reportPosition(t, n) {
		return this.group !== null && (this.dispatch(e.PLAYBACK_SYNC, {
			group_id: this.group.group_id,
			member_id: this.memberId,
			position: t,
			is_playing: n,
			server_time: this.getSynchronizedTime()
		}), !0);
	}
	sendChat(t) {
		return this.group !== null && (this.dispatch(e.CHAT, {
			group_id: this.group.group_id,
			member_id: this.memberId,
			message: t
		}), !0);
	}
	sendTyping(t) {
		return this.group !== null && (this.dispatch(e.TYPING, {
			group_id: this.group.group_id,
			member_id: this.memberId,
			is_typing: t
		}), !0);
	}
	pingTime() {
		if (this.destroyed) return;
		let t = Math.trunc(this.now()), n = this.lastPingSendTime;
		if (n !== null) {
			let e = t - n;
			if (e >= 0 && e <= 1e3) return;
		}
		this.lastPingSendTime = t, this.pingEpoch = this.connectionEpoch, this.dispatch(e.TIME_PING, { client_time: t });
	}
	onDisconnect() {
		var e, t;
		this.destroyed || (this.cancelSeekCoalescing(), this.connectionEpoch += 1, this.timeSync.reset(), this.consecutiveSyncRejections = 0, this.group = null, this.lastPingSendTime = null, (e = (t = this.options).onDisconnect) == null || e.call(t));
	}
	destroy() {
		this.destroyed = !0, this.cancelSeekCoalescing(), this.timeSync.reset(), this.group = null, this.lastPingSendTime = null;
	}
	handleIncoming(t) {
		if (this.destroyed) return;
		let n = d(t);
		if (n === null) {
			var i, a;
			(i = (a = this.options).onFrameDropped) == null || i.call(a, "undecodable", t);
			return;
		}
		if (!r(n.type)) {
			var o, s;
			(o = (s = this.options).onUnknownFrame) == null || o.call(s, n);
			return;
		}
		let c = n;
		if ("protocol_version" in c) {
			let e = c.protocol_version;
			if (typeof e != "number" || !Number.isInteger(e) || e > 1) {
				var l, u;
				(l = (u = this.options).onFrameDropped) == null || l.call(u, "malformed", c);
				return;
			}
		}
		switch (c.type) {
			case e.TIME_PONG:
				this.handleTimePong(c);
				break;
			case e.GROUP_STATE:
				this.handleGroupState(c);
				break;
			case e.PLAYBACK_PLAY:
				this.handlePlayback("play", c);
				break;
			case e.PLAYBACK_PAUSE:
				this.handlePlayback("pause", c);
				break;
			case e.PLAYBACK_SEEK:
				this.handleSeek(c);
				break;
			case e.HOST_ELECT:
				this.handleHostElect(c);
				break;
			case e.INFO:
				this.handleInfo(c);
				break;
			case e.ERROR:
				this.handleError(c);
				break;
			case e.TYPING:
				this.handleTyping(c);
				break;
			case e.HOST_TRANSFER:
				this.handleHostTransfer(c);
				break;
			case e.PLAYBACK_SYNC:
				this.handlePlaybackSync(c);
				break;
			case e.TIME_SYNC:
				this.handleTimeSync(c);
				break;
			case e.GROUP_LIST:
				this.handleGroupList(c);
				break;
			case e.CHAT:
				this.handleChat(c);
				break;
			case e.PLAYBACK_QUEUE:
				this.handlePlaybackQueueBroadcast(c);
				break;
			default:
				var f, p;
				(f = (p = this.options).onUnknownFrame) == null || f.call(p, c);
		}
	}
	handleTimePong(e) {
		let t = this.lastPingSendTime;
		if (t === null) return;
		let n = e, r = typeof n.client_time == "number" && Number.isFinite(n.client_time) ? n.client_time : null;
		if (r !== null && r !== t || r === null && this.pingEpoch !== this.connectionEpoch) return;
		let i = Math.trunc(this.now()), a = r == null ? t : r;
		this.lastPingSendTime = null;
		let o = typeof n.server_time == "number" && Number.isFinite(n.server_time) ? n.server_time : null;
		if (o === null) {
			var s, c;
			this.consecutiveSyncRejections += 1, (s = (c = this.options).onSyncDegraded) == null || s.call(c, this.consecutiveSyncRejections);
		} else if (this.timeSync.addSample(a, o, o, i)) {
			var l, u;
			this.consecutiveSyncRejections = 0, (l = (u = this.options).onSync) == null || l.call(u, {
				offset: this.timeSync.getOffset(),
				latency: this.timeSync.getLatency(),
				isStable: this.timeSync.isStable()
			});
		} else {
			var d, f;
			this.consecutiveSyncRejections += 1, (d = (f = this.options).onSyncDegraded) == null || d.call(f, this.consecutiveSyncRejections);
		}
	}
	static normalizeMembers(e, t) {
		let n;
		return n = Array.isArray(e) ? e.filter((e) => typeof e == "object" && !!e) : e && typeof e == "object" ? Object.entries(e).filter(([, e]) => typeof e == "object" && !!e).map(([e, t]) => l(l({}, t), {}, { id: e })) : [], n.map((e) => ({
			id: typeof e.id == "string" ? e.id : "",
			name: typeof e.name == "string" ? e.name : "",
			is_host: e.id === t,
			joined_at: typeof e.joined_at == "number" && Number.isFinite(e.joined_at) ? e.joined_at : 0
		}));
	}
	static foldHostId(e, t) {
		return l(l({}, e), {}, {
			host_id: t,
			members: e.members.map((e) => l(l({}, e), {}, { is_host: e.id === t }))
		});
	}
	static serverTimeToMs(e) {
		return e < 0xe8d4a51000 ? e * 1e3 : e;
	}
	static serverTimeOrNow(e, n) {
		return typeof e != "number" || !Number.isFinite(e) || e < 1e3 ? n() : e >= 0xe8d4a51000 || e >= 1e9 && e < 4e9 ? t.serverTimeToMs(e) : n();
	}
	static normalizeQueue(e) {
		if (Array.isArray(e)) return e.filter((e) => typeof e == "object" && !!e).map((e) => ({
			media_id: typeof e.media_id == "string" ? e.media_id : "",
			media_info: typeof e.media_info == "object" && e.media_info !== null ? e.media_info : void 0,
			added_at: typeof e.added_at == "number" && Number.isFinite(e.added_at) ? e.added_at : void 0,
			added_by: typeof e.added_by == "string" || e.added_by === null ? e.added_by : void 0
		}));
	}
	static normalizeNudge(e) {
		if (typeof e != "object" || !e) return;
		let n = e;
		return {
			drift_ms: t.finiteOrUndefined(n.drift_ms),
			direction: n.direction === "behind" || n.direction === "ahead" ? n.direction : void 0,
			suggested_rate: t.nudgeRateOrUndefined(n.suggested_rate),
			tolerance_ms: t.nonnegOrUndefined(n.tolerance_ms),
			cooldown_ms: t.nonnegOrUndefined(n.cooldown_ms)
		};
	}
	static strOr(e, t) {
		return typeof e == "string" ? e : t;
	}
	static strOrNull(e) {
		return typeof e == "string" ? e : null;
	}
	static finiteOr(e, t) {
		return typeof e == "number" && Number.isFinite(e) ? e : t;
	}
	static finiteOrNull(e) {
		return typeof e == "number" && Number.isFinite(e) ? e : null;
	}
	static finiteOrUndefined(e) {
		return typeof e == "number" && Number.isFinite(e) ? e : void 0;
	}
	static nudgeRateOrUndefined(e) {
		if (!(typeof e != "number" || !Number.isFinite(e) || e < .9 || e > 1.1)) return e;
	}
	static nonnegOrUndefined(e) {
		if (!(typeof e != "number" || !Number.isFinite(e) || e < 0)) return e;
	}
	positionOrDrop(e) {
		var t;
		if (typeof e != "number" || !Number.isFinite(e) || e < 0) return null;
		let n = (t = this.group) == null ? void 0 : t.current_media_duration;
		return typeof n == "number" && Number.isFinite(n) && n > 0 && e > n ? n : e;
	}
	static clampedPosition(e, n) {
		let r = t.finiteOr(e, 0);
		return r < 0 ? 0 : n !== null && n > 0 && r > n ? n : r;
	}
	static playbackState(e) {
		return e === "playing" || e === "paused" || e === "buffering" || e === "stopped" ? e : "stopped";
	}
	handleGroupState(e) {
		var n, r;
		let i = e, a = i.group;
		if (typeof a != "object" || !a) {
			var o, s;
			(o = (s = this.options).onFrameDropped) == null || o.call(s, "malformed", e);
			return;
		}
		if (typeof a.group_id != "string") {
			var c, l;
			(c = (l = this.options).onFrameDropped) == null || c.call(l, "malformed", e);
			return;
		}
		let u = a.group_id, d = t.strOrNull(a.host_id);
		this.group !== null && this.group.group_id !== u && this.cancelSeekCoalescing();
		let f = this.group, p = t.normalizeMembers(a.members, d), m = t.finiteOrNull(a.current_media_duration);
		if (this.group = {
			group_id: u,
			group_name: t.strOr(a.group_name, ""),
			members: p,
			member_count: t.finiteOrUndefined(a.member_count),
			host_id: d,
			current_media_id: t.strOrNull(a.current_media_id),
			current_media_duration: m,
			playback_position: t.clampedPosition(a.playback_position, m),
			playback_state: t.playbackState(a.playback_state),
			queue: t.normalizeQueue(a.queue),
			created_at: t.finiteOrUndefined(a.created_at),
			last_activity_at: t.finiteOrUndefined(a.last_activity_at)
		}, f !== null && f.group_id === u) {
			let e = new Set(p.map((e) => e.id));
			for (let t of f.members) if (!e.has(t.id)) {
				var h, g;
				(h = (g = this.options).onMemberLeft) == null || h.call(g, {
					id: t.id,
					name: t.name
				});
			}
		}
		(n = (r = this.options).onState) == null || n.call(r, this.group, i.your_id);
	}
	handlePlayback(e, n) {
		var r, i;
		if (this.group === null) {
			var a, o;
			(a = (o = this.options).onFrameDropped) == null || a.call(o, "malformed", n);
			return;
		}
		if ((typeof n.member_id == "string" ? n.member_id : void 0) === this.memberId) return;
		let s = this.positionOrDrop(n.position);
		if (s === null) {
			var c, l;
			(c = (l = this.options).onFrameDropped) == null || c.call(l, "malformed", n);
			return;
		}
		let u = t.serverTimeOrNow(n.server_time, () => this.getSynchronizedTime());
		(r = (i = this.options).onPlaybackCommand) == null || r.call(i, {
			type: e,
			position: s,
			serverTime: u
		});
	}
	handleSeek(e) {
		var n, r;
		if (this.group === null) {
			var i, a;
			(i = (a = this.options).onFrameDropped) == null || i.call(a, "malformed", e);
			return;
		}
		if ((typeof e.member_id == "string" ? e.member_id : void 0) === this.memberId) return;
		let o = this.positionOrDrop(e.to_position);
		if (o === null) {
			var s, c;
			(s = (c = this.options).onFrameDropped) == null || s.call(c, "malformed", e);
			return;
		}
		let l = t.serverTimeOrNow(e.server_time, () => this.getSynchronizedTime());
		(n = (r = this.options).onPlaybackCommand) == null || n.call(r, {
			type: "seek",
			position: o,
			serverTime: l
		});
	}
	handleHostElect(e) {
		var n, r;
		let i = e, a = t.strOrNull(i.elected_id);
		if (this.group !== null) {
			let e = typeof i.elected_by == "string" && i.elected_by !== "" ? i.elected_by : null, n = this.group, r = e !== null && e !== this.memberId ? n.members.filter((t) => t.id !== e) : n.members;
			if (r.length !== n.members.length) {
				var o, s;
				let i = n.members.find((t) => t.id === e);
				if (n = l(l({}, n), {}, { members: r }), this.group = t.foldHostId(n, a), i !== void 0) {
					var c, u;
					(c = (u = this.options).onMemberLeft) == null || c.call(u, {
						id: i.id,
						name: i.name
					});
				}
				(o = (s = this.options).onHostChanged) == null || o.call(s, a);
				return;
			}
			this.group = t.foldHostId(n, a);
		}
		(n = (r = this.options).onHostChanged) == null || n.call(r, a);
	}
	handleInfo(e) {
		let t = e;
		if (this.group !== null && typeof t.member_id == "string" && typeof t.member_name == "string") {
			var n, r;
			(n = (r = this.options).onMemberJoined) == null || n.call(r, {
				id: t.member_id,
				name: t.member_name
			});
		}
		if (typeof t.message == "string") {
			var i, a;
			(i = (a = this.options).onInfo) == null || i.call(a, t.message);
		}
	}
	handleError(e) {
		var t, n;
		let r = e, i = typeof r.error_code == "string" ? r.error_code : typeof r.code == "string" ? r.code : "UNKNOWN", a = typeof r.message == "string" ? r.message : "Unknown error", o = typeof r.details == "object" && r.details !== null && !Array.isArray(r.details) ? r.details : void 0;
		(t = (n = this.options).onError) == null || t.call(n, i, a, o);
	}
	handleTyping(e) {
		var t, n;
		let r = e;
		if (typeof r.member_id != "string") {
			var i, a;
			(i = (a = this.options).onFrameDropped) == null || i.call(a, "malformed", e);
			return;
		}
		let o = typeof r.is_typing == "boolean" && r.is_typing;
		(t = (n = this.options).onMemberTyping) == null || t.call(n, r.member_id, o);
	}
	handleChat(e) {
		var t, n;
		let r = e;
		if (typeof r.member_id != "string" || typeof r.message != "string") {
			var i, a;
			(i = (a = this.options).onFrameDropped) == null || i.call(a, "malformed", e);
			return;
		}
		let o = typeof r.member_name == "string" ? r.member_name : "", s = typeof e.timestamp == "number" && Number.isFinite(e.timestamp) ? e.timestamp : void 0;
		(t = (n = this.options).onChat) == null || t.call(n, r.member_id, o, r.message, s);
	}
	handlePlaybackQueueBroadcast(e) {
		var n, r;
		let i = this.group;
		if (i === null) {
			var a, o;
			(a = (o = this.options).onFrameDropped) == null || a.call(o, "malformed", e);
			return;
		}
		let s = e, c = t.normalizeQueue(s.queue);
		if (c === void 0) {
			var u, d;
			(u = (d = this.options).onFrameDropped) == null || u.call(d, "malformed", e);
		} else this.group = l(l({}, i), {}, { queue: c }), (n = (r = this.options).onQueueChanged) == null || n.call(r, c);
	}
	handleHostTransfer(e) {
		var n, r;
		let i = e;
		if (typeof i.current_host_id != "string" || typeof i.new_host_id != "string") {
			var a, o;
			(a = (o = this.options).onFrameDropped) == null || a.call(o, "malformed", e);
		} else this.group !== null && (this.group = t.foldHostId(this.group, i.new_host_id)), (n = (r = this.options).onHostTransfer) == null || n.call(r, i.current_host_id, i.new_host_id);
	}
	handlePlaybackSync(e) {
		var n, r;
		if (this.group === null) {
			var i, a;
			(i = (a = this.options).onFrameDropped) == null || i.call(a, "malformed", e);
			return;
		}
		if (typeof e.member_id != "string") {
			var o, s;
			(o = (s = this.options).onFrameDropped) == null || o.call(s, "malformed", e);
			return;
		}
		let c = e.member_id, l = this.positionOrDrop(e.position);
		if (l === null) {
			var u, d;
			(u = (d = this.options).onFrameDropped) == null || u.call(d, "malformed", e);
			return;
		}
		let f = typeof e.is_playing == "boolean" && e.is_playing, p = t.serverTimeOrNow(e.server_time, () => this.getSynchronizedTime()), m = t.normalizeNudge(e.nudge);
		(n = (r = this.options).onPlaybackSync) == null || n.call(r, c, l, f, p, m);
	}
	handleTimeSync(e) {
		var t, n;
		let r = e;
		if (typeof r.member_id != "string" || typeof r.group_id != "string" || !(typeof r.server_time == "number" && Number.isFinite(r.server_time)) || !(typeof r.offset_ms == "number" && Number.isFinite(r.offset_ms)) || !(typeof r.latency_ms == "number" && Number.isFinite(r.latency_ms)) || !(typeof r.drift_rate == "number" && Number.isFinite(r.drift_rate)) || typeof r.is_stable != "boolean") {
			var i, a;
			(i = (a = this.options).onFrameDropped) == null || i.call(a, "malformed", e);
		} else (t = (n = this.options).onTimeSync) == null || t.call(n, {
			memberId: r.member_id,
			groupId: r.group_id,
			serverTimeSec: r.server_time,
			offsetMs: r.offset_ms,
			latencyMs: r.latency_ms,
			driftRate: r.drift_rate,
			isStable: r.is_stable
		});
	}
	handleGroupList(e) {
		var n, r;
		let i = e.groups;
		if (!Array.isArray(i)) {
			var a, o;
			(a = (o = this.options).onFrameDropped) == null || a.call(o, "malformed", e);
			return;
		}
		let s = i.filter((e) => typeof e == "object" && !!e).map((e) => ({
			id: typeof e.id == "string" ? e.id : "",
			name: typeof e.name == "string" ? e.name : "",
			member_count: t.finiteOr(e.member_count, 0),
			has_password: typeof e.has_password == "boolean" && e.has_password,
			current_media: typeof e.current_media == "string" ? e.current_media : null,
			is_playing: typeof e.is_playing == "boolean" && e.is_playing
		}));
		(n = (r = this.options).onGroupList) == null || n.call(r, s);
	}
	dispatch(e, t) {
		this.send(u(e, t, this.now));
	}
};
//#endregion
export { n as ALL_MESSAGE_TYPES, g as DRIFT_CORRECTION_FACTOR, v as DRIFT_RATE_MAX, _ as DRIFT_RATE_MIN, m as MAX_ACCEPTABLE_RTT, p as OFFSET_SAMPLE_COUNT, t as PROTOCOL_VERSION, h as STABILITY_VARIANCE_THRESHOLD, e as SYNCPLAY_MESSAGE_TYPES, S as SyncPlayClient, y as TIME_SYNC_PROTOCOL_VERSION, b as TimeSync, d as decodeMessage, u as encodeMessage, r as isValidMessageType, f as serializeMessage };

//# sourceMappingURL=phlix-syncplay.js.map