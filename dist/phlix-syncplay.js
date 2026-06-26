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
}, t = 1, n = [
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
];
function r(e) {
	return n.includes(e);
}
//#endregion
//#region src/framing.ts
function i(e, t, n) {
	return {
		...t,
		type: e,
		protocol_version: 1,
		timestamp: n()
	};
}
function a(e) {
	let t = e;
	if (typeof e == "string") try {
		t = JSON.parse(e);
	} catch {
		return null;
	}
	if (typeof t != "object" || !t || Array.isArray(t)) return null;
	let n = t;
	if (typeof n.type != "string") return null;
	let r = n.data;
	if (typeof r == "object" && r && !Array.isArray(r)) {
		let e = {};
		for (let t of Object.keys(n)) t !== "data" && (e[t] = n[t]);
		return {
			...r,
			...e
		};
	}
	return n;
}
function o(e) {
	return JSON.stringify(e);
}
//#endregion
//#region src/time-sync.ts
var s = 5, c = 1e3, l = 50, u = .1, d = 1, f = class {
	samples = [];
	driftRate = 1;
	now;
	constructor(e) {
		this.now = e;
	}
	addSample(e, t, n, r) {
		let i = r - e - (n - t);
		if (i > 1e3) return !1;
		let a = i / 2, o = t - e + Math.trunc(a);
		return this.samples.push({
			offset: o,
			rtt: i,
			timestamp: this.now() / 1e3
		}), this.samples.length > 10 && this.samples.shift(), this.updateDriftRate(), !0;
	}
	getOffset() {
		if (this.samples.length === 0) return 0;
		let e = this.samples.slice(-5), t = 0, n = 0;
		for (let r of e) {
			let e = 1 / Math.max(1, r.rtt);
			t += r.offset * e, n += e;
		}
		return Math.trunc(t / Math.max(1, n));
	}
	getLatency() {
		if (this.samples.length === 0) return 0;
		let e = this.samples.slice(-5), t = 0;
		for (let n of e) t += n.rtt / 2;
		return Math.trunc(t / Math.max(1, e.length));
	}
	isStable() {
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
		this.driftRate = 1 + u * i / 1e3;
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
		this.samples = [], this.driftRate = 1;
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
}, p = class {
	send;
	now;
	memberId;
	memberName;
	options;
	timeSync;
	group = null;
	lastPingSendTime = null;
	constructor(e) {
		this.options = e, this.send = e.send, this.now = e.now, this.memberId = e.memberId, this.memberName = e.memberName ?? "User", this.timeSync = new f(e.now);
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
	createGroup(t, n) {
		let r = {
			group_name: t,
			member_id: this.memberId,
			member_name: this.memberName
		};
		n !== void 0 && (r.password_hash = n), this.dispatch(e.GROUP_CREATE, r);
	}
	joinGroup(t, n) {
		let r = {
			group_id: t,
			member_id: this.memberId,
			member_name: this.memberName
		};
		n !== void 0 && (r.password_hash = n), this.dispatch(e.GROUP_JOIN, r);
	}
	leaveGroup() {
		this.group !== null && (this.dispatch(e.GROUP_LEAVE, {
			group_id: this.group.id,
			member_id: this.memberId
		}), this.group = null);
	}
	sendPlay(t) {
		this.group !== null && this.dispatch(e.PLAYBACK_PLAY, {
			group_id: this.group.id,
			member_id: this.memberId,
			position: t,
			server_time: this.getSynchronizedTime()
		});
	}
	sendPause(t) {
		this.group !== null && this.dispatch(e.PLAYBACK_PAUSE, {
			group_id: this.group.id,
			member_id: this.memberId,
			position: t,
			server_time: this.getSynchronizedTime()
		});
	}
	sendSeek(t, n) {
		this.group !== null && this.dispatch(e.PLAYBACK_SEEK, {
			group_id: this.group.id,
			member_id: this.memberId,
			from_position: t,
			to_position: n,
			server_time: this.getSynchronizedTime()
		});
	}
	reportPosition(t, n) {
		this.group !== null && this.dispatch(e.PLAYBACK_SYNC, {
			group_id: this.group.id,
			member_id: this.memberId,
			position: t,
			is_playing: n,
			server_time: this.getSynchronizedTime()
		});
	}
	pingTime() {
		let t = this.now();
		this.lastPingSendTime = t, this.dispatch(e.TIME_PING, { client_time: t });
	}
	handleIncoming(t) {
		let n = a(t);
		if (n !== null) switch (n.type) {
			case e.TIME_PONG:
				this.handleTimePong(n);
				break;
			case e.GROUP_STATE:
				this.handleGroupState(n);
				break;
			case e.PLAYBACK_PLAY:
				this.handlePlayback("play", n);
				break;
			case e.PLAYBACK_PAUSE:
				this.handlePlayback("pause", n);
				break;
			case e.PLAYBACK_SEEK:
				this.handleSeek(n);
				break;
			case e.HOST_ELECT:
				this.handleHostElect(n);
				break;
			case e.INFO:
				this.handleInfo(n);
				break;
			case e.ERROR:
				this.handleError(n);
				break;
			default: break;
		}
	}
	handleTimePong(e) {
		let t = e, n = this.now(), r = typeof t.client_time == "number" ? t.client_time : this.lastPingSendTime, i = typeof t.server_time == "number" ? t.server_time : null;
		if (r === null || i === null) return;
		let a = this.timeSync.addSample(r, i, i, n);
		this.lastPingSendTime = null, a && this.options.onSync?.({
			offset: this.timeSync.getOffset(),
			latency: this.timeSync.getLatency(),
			isStable: this.timeSync.isStable()
		});
	}
	handleGroupState(e) {
		let t = e, n = t.group;
		if (typeof n != "object" || !n) return;
		let r = Array.isArray(n.members) ? n.members.map((e) => ({
			id: e.id,
			name: e.name,
			is_host: e.id === n.host_id,
			joined_at: typeof e.joined_at == "number" ? e.joined_at : 0
		})) : [];
		this.group = {
			id: n.id,
			name: n.name,
			members: r,
			host_id: n.host_id ?? null,
			current_media_id: n.current_media_id ?? null,
			playback_position: n.playback_position ?? 0,
			playback_state: n.playback_state ?? "stopped",
			has_password: n.has_password
		}, this.options.onState?.(this.group, t.your_id);
	}
	handlePlayback(e, t) {
		if ((typeof t.member_id == "string" ? t.member_id : void 0) === this.memberId) return;
		let n = typeof t.position == "number" ? t.position : 0, r = typeof t.server_time == "number" ? t.server_time : this.getSynchronizedTime();
		this.options.onPlaybackCommand?.({
			type: e,
			position: n,
			serverTime: r
		});
	}
	handleSeek(e) {
		if ((typeof e.member_id == "string" ? e.member_id : void 0) === this.memberId) return;
		let t = typeof e.to_position == "number" ? e.to_position : 0, n = typeof e.server_time == "number" ? e.server_time : this.getSynchronizedTime();
		this.options.onPlaybackCommand?.({
			type: "seek",
			position: t,
			serverTime: n
		});
	}
	handleHostElect(e) {
		let t = e.elected_id ?? null;
		this.group !== null && (this.group = {
			...this.group,
			host_id: t
		}), this.options.onHostChanged?.(t);
	}
	handleInfo(e) {
		let t = e;
		typeof t.member_id == "string" && typeof t.member_name == "string" && this.options.onMemberJoined?.({
			id: t.member_id,
			name: t.member_name
		}), typeof t.message == "string" && this.options.onInfo?.(t.message);
	}
	handleError(e) {
		let t = e, n = t.error_code ?? t.code ?? "UNKNOWN", r = typeof t.message == "string" ? t.message : "Unknown error";
		this.options.onError?.(n, r);
	}
	dispatch(e, t) {
		this.send(i(e, t, this.now));
	}
};
//#endregion
export { n as ALL_MESSAGE_TYPES, u as DRIFT_CORRECTION_FACTOR, c as MAX_ACCEPTABLE_RTT, s as OFFSET_SAMPLE_COUNT, t as PROTOCOL_VERSION, l as STABILITY_VARIANCE_THRESHOLD, e as SYNCPLAY_MESSAGE_TYPES, p as SyncPlayClient, d as TIME_SYNC_PROTOCOL_VERSION, f as TimeSync, a as decodeMessage, i as encodeMessage, r as isValidMessageType, o as serializeMessage };

//# sourceMappingURL=phlix-syncplay.js.map