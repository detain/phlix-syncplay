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
var s = 5, c = 1e3, l = 50, u = .1, d = .99, f = 1.01, p = 1, m = class {
	samples = [];
	driftRate = 1;
	now;
	samplesVersion = 0;
	cacheVersion = -1;
	cachedOffset = 0;
	cachedLatency = 0;
	cachedIsStable = !1;
	constructor(e) {
		this.now = e;
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
		this.driftRate = 1 + u * i / 1e3, this.driftRate = Math.min(f, Math.max(d, this.driftRate));
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
	getStatus() {
		return {
			offset: this.getOffset(),
			latency: this.getLatency(),
			driftRate: this.driftRate,
			isStable: this.isStable(),
			sampleCount: this.samples.length
		};
	}
}, h = 250, g = class t {
	send;
	now;
	memberId;
	memberName;
	options;
	timeSync;
	seekThrottleMs;
	seekWindowOpen = !1;
	pendingSeek = null;
	seekFlushTimer = null;
	group = null;
	lastPingSendTime = null;
	constructor(e) {
		this.options = e, this.send = e.send, this.now = e.now, this.memberId = e.memberId, this.memberName = e.memberName ?? "User", this.timeSync = new m(e.now), this.seekThrottleMs = t.parseSeekThrottleMs(e.seekThrottleMs);
	}
	static parseSeekThrottleMs(e) {
		if (e === void 0) return h;
		if (typeof e != "number" || !Number.isFinite(e) || e < 0) throw TypeError(`SyncPlayClient: seekThrottleMs must be a finite number >= 0 (0 disables the seek coalescing throttle), got ${String(e)}`);
		return e;
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
		this.group !== null && (this.cancelSeekCoalescing(), this.dispatch(e.GROUP_LEAVE, {
			group_id: this.group.group_id,
			member_id: this.memberId
		}), this.group = null);
	}
	sendPlay(t) {
		this.group !== null && this.dispatch(e.PLAYBACK_PLAY, {
			group_id: this.group.group_id,
			member_id: this.memberId,
			position: t,
			server_time: this.getSynchronizedTime()
		});
	}
	sendPause(t) {
		this.group !== null && this.dispatch(e.PLAYBACK_PAUSE, {
			group_id: this.group.group_id,
			member_id: this.memberId,
			position: t,
			server_time: this.getSynchronizedTime()
		});
	}
	sendSeek(e, t) {
		this.group !== null && (this.seekWindowOpen ? this.pendingSeek = {
			from: e,
			to: t
		} : (this.dispatchSeek(e, t), this.seekThrottleMs > 0 && this.openSeekWindow()));
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
		this.seekWindowOpen = !0, this.seekFlushTimer = setTimeout(() => this.closeSeekWindow(), this.seekThrottleMs);
	}
	closeSeekWindow() {
		this.seekWindowOpen = !1, this.seekFlushTimer = null;
		let e = this.pendingSeek;
		e !== null && (this.pendingSeek = null, this.group !== null && (this.dispatchSeek(e.from, e.to), this.openSeekWindow()));
	}
	cancelSeekCoalescing() {
		this.pendingSeek = null, this.seekFlushTimer !== null && (clearTimeout(this.seekFlushTimer), this.seekFlushTimer = null), this.seekWindowOpen = !1;
	}
	reportPosition(t, n) {
		this.group !== null && this.dispatch(e.PLAYBACK_SYNC, {
			group_id: this.group.group_id,
			member_id: this.memberId,
			position: t,
			is_playing: n,
			server_time: this.getSynchronizedTime()
		});
	}
	sendChat(t) {
		this.group !== null && this.dispatch(e.CHAT, {
			group_id: this.group.group_id,
			member_id: this.memberId,
			message: t
		});
	}
	sendTyping(t) {
		this.group !== null && this.dispatch(e.TYPING, {
			group_id: this.group.group_id,
			member_id: this.memberId,
			is_typing: t
		});
	}
	pingTime() {
		let t = this.now();
		this.lastPingSendTime = t, this.dispatch(e.TIME_PING, { client_time: t });
	}
	onDisconnect() {
		this.cancelSeekCoalescing(), this.timeSync.reset(), this.group = null, this.lastPingSendTime = null, this.options.onDisconnect?.();
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
			case e.TYPING:
				this.handleTyping(n);
				break;
			case e.HOST_TRANSFER:
				this.handleHostTransfer(n);
				break;
			case e.PLAYBACK_SYNC:
				this.handlePlaybackSync(n);
				break;
			case e.TIME_SYNC:
				this.handleTimeSync(n);
				break;
			case e.GROUP_LIST:
				this.handleGroupList(n);
				break;
			case e.CHAT:
				this.handleChat(n);
				break;
			case e.PLAYBACK_QUEUE:
				this.handlePlaybackQueueBroadcast(n);
				break;
			default: this.options.onUnknownFrame?.(n);
		}
	}
	handleTimePong(e) {
		let t = this.lastPingSendTime;
		if (t === null) return;
		let n = e, r = typeof n.client_time == "number" ? n.client_time : null;
		if (r !== null && r !== t) return;
		let i = this.now(), a = r ?? t, o = typeof n.server_time == "number" ? n.server_time : null;
		if (o === null) return;
		let s = this.timeSync.addSample(a, o, o, i);
		this.lastPingSendTime = null, s && this.options.onSync?.({
			offset: this.timeSync.getOffset(),
			latency: this.timeSync.getLatency(),
			isStable: this.timeSync.isStable()
		});
	}
	static normalizeMembers(e, t) {
		let n;
		return n = Array.isArray(e) ? e : e && typeof e == "object" ? Object.entries(e).map(([e, t]) => ({
			...t,
			id: e
		})) : [], n.map((e) => ({
			id: typeof e.id == "string" ? e.id : "",
			name: typeof e.name == "string" ? e.name : "",
			is_host: e.id === t,
			joined_at: typeof e.joined_at == "number" ? e.joined_at : 0
		}));
	}
	static serverTimeToMs(e) {
		return e < 0xe8d4a51000 ? e * 1e3 : e;
	}
	static normalizeQueue(e) {
		if (Array.isArray(e)) return e.map((e) => ({
			media_id: typeof e.media_id == "string" ? e.media_id : "",
			media_info: typeof e.media_info == "object" && e.media_info !== null ? e.media_info : void 0,
			added_at: typeof e.added_at == "number" ? e.added_at : void 0,
			added_by: typeof e.added_by == "string" || e.added_by === null ? e.added_by : void 0
		}));
	}
	static normalizeNudge(e) {
		if (typeof e != "object" || !e) return;
		let t = e;
		return {
			drift_ms: typeof t.drift_ms == "number" ? t.drift_ms : void 0,
			direction: t.direction === "behind" || t.direction === "ahead" ? t.direction : void 0,
			suggested_rate: typeof t.suggested_rate == "number" ? t.suggested_rate : void 0,
			tolerance_ms: typeof t.tolerance_ms == "number" ? t.tolerance_ms : void 0,
			cooldown_ms: typeof t.cooldown_ms == "number" ? t.cooldown_ms : void 0
		};
	}
	handleGroupState(e) {
		let n = e, r = n.group;
		if (typeof r != "object" || !r) return;
		this.group !== null && this.group.group_id !== (r.group_id ?? "") && this.cancelSeekCoalescing();
		let i = t.normalizeMembers(r.members, r.host_id ?? null);
		this.group = {
			group_id: r.group_id ?? "",
			group_name: r.group_name ?? "",
			members: i,
			member_count: r.member_count,
			host_id: r.host_id ?? null,
			current_media_id: r.current_media_id ?? null,
			current_media_duration: r.current_media_duration ?? null,
			playback_position: r.playback_position ?? 0,
			playback_state: r.playback_state ?? "stopped",
			queue: t.normalizeQueue(r.queue),
			created_at: r.created_at,
			last_activity_at: r.last_activity_at
		}, this.options.onState?.(this.group, n.your_id);
	}
	handlePlayback(e, n) {
		if ((typeof n.member_id == "string" ? n.member_id : void 0) === this.memberId) return;
		let r = typeof n.position == "number" ? n.position : 0, i = typeof n.server_time == "number" ? t.serverTimeToMs(n.server_time) : this.getSynchronizedTime();
		this.options.onPlaybackCommand?.({
			type: e,
			position: r,
			serverTime: i
		});
	}
	handleSeek(e) {
		if ((typeof e.member_id == "string" ? e.member_id : void 0) === this.memberId) return;
		let n = typeof e.to_position == "number" ? e.to_position : 0, r = typeof e.server_time == "number" ? t.serverTimeToMs(e.server_time) : this.getSynchronizedTime();
		this.options.onPlaybackCommand?.({
			type: "seek",
			position: n,
			serverTime: r
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
	handleTyping(e) {
		let t = e;
		typeof t.member_id == "string" && this.options.onMemberTyping?.(t.member_id, t.is_typing ?? !1);
	}
	handleChat(e) {
		let t = e;
		if (typeof t.member_id != "string" || typeof t.message != "string") return;
		let n = typeof t.member_name == "string" ? t.member_name : "", r = typeof e.timestamp == "number" ? e.timestamp : void 0;
		this.options.onChat?.(t.member_id, n, t.message, r);
	}
	handlePlaybackQueueBroadcast(e) {
		let n = e, r = t.normalizeQueue(n.queue);
		r !== void 0 && (this.group !== null && (this.group = {
			...this.group,
			queue: r
		}), this.options.onQueueChanged?.(r));
	}
	handleHostTransfer(e) {
		let t = e;
		typeof t.current_host_id == "string" && typeof t.new_host_id == "string" && (this.group !== null && (this.group = {
			...this.group,
			host_id: t.new_host_id
		}), this.options.onHostTransfer?.(t.current_host_id, t.new_host_id));
	}
	handlePlaybackSync(e) {
		let n = typeof e.member_id == "string" ? e.member_id : void 0, r = typeof e.position == "number" ? e.position : 0, i = typeof e.is_playing == "boolean" && e.is_playing, a = typeof e.server_time == "number" ? t.serverTimeToMs(e.server_time) : this.getSynchronizedTime(), o = t.normalizeNudge(e.nudge);
		this.options.onPlaybackSync?.(n ?? "", r, i, a, o);
	}
	handleTimeSync(e) {
		let t = e;
		typeof t.member_id == "string" && typeof t.group_id == "string" && typeof t.server_time == "number" && typeof t.offset_ms == "number" && typeof t.latency_ms == "number" && typeof t.drift_rate == "number" && typeof t.is_stable == "boolean" && this.options.onTimeSync?.({
			memberId: t.member_id,
			groupId: t.group_id,
			serverTimeSec: t.server_time,
			offsetMs: t.offset_ms,
			latencyMs: t.latency_ms,
			driftRate: t.drift_rate,
			isStable: t.is_stable
		});
	}
	handleGroupList(e) {
		let t = e.groups;
		if (!Array.isArray(t)) return;
		let n = t.map((e) => ({
			id: typeof e.id == "string" ? e.id : "",
			name: typeof e.name == "string" ? e.name : "",
			member_count: typeof e.member_count == "number" ? e.member_count : 0,
			has_password: typeof e.has_password == "boolean" && e.has_password,
			current_media: typeof e.current_media == "string" ? e.current_media : null,
			is_playing: typeof e.is_playing == "boolean" && e.is_playing
		}));
		this.options.onGroupList?.(n);
	}
	dispatch(e, t) {
		this.send(i(e, t, this.now));
	}
};
//#endregion
export { n as ALL_MESSAGE_TYPES, u as DRIFT_CORRECTION_FACTOR, f as DRIFT_RATE_MAX, d as DRIFT_RATE_MIN, c as MAX_ACCEPTABLE_RTT, s as OFFSET_SAMPLE_COUNT, t as PROTOCOL_VERSION, l as STABILITY_VARIANCE_THRESHOLD, e as SYNCPLAY_MESSAGE_TYPES, g as SyncPlayClient, p as TIME_SYNC_PROTOCOL_VERSION, m as TimeSync, a as decodeMessage, i as encodeMessage, r as isValidMessageType, o as serializeMessage };

//# sourceMappingURL=phlix-syncplay.js.map