/// <reference types="@valenced/types" />

import { Stores, getStore, onAnyFluxEventDispatched } from "@valenced/discord/flux";
import { before } from "@valenced/patcher";
import { ToastActionCreators } from "@valenced/discord/actions";

type AnyRecord = Record<string, any>;
type VoiceState = {
  userId: string; channelId: string | null; guildId: string | null;
  selfDeaf: boolean; selfMute: boolean | undefined; flagsSince: number; updatedAt: number;
};
type Detection = {
  userId: string; displayName: string; username: string; channelId: string;
  guildId: string | null; firstSeen: number; lastSeen: number;
  evidenceCount: number; evidence: string;
  kind: "self-fake-mute" | "self-fake-deafen" | "self-fake-mute-and-deafen" | "remote-speaking-mismatch";
};
type LocalVoiceFlags = {
  selfMute: boolean | null;
  selfDeaf: boolean | null;
  connectionId: string | null;
  connectionState: string | null;
  ready: boolean;
};

const voiceStates = new Map<string, VoiceState>();
const detections = new Map<string, Detection>();
const alertedUsers = new Set<string>();
const pendingChecks = new Map<string, ReturnType<typeof setTimeout>>();
const settingsListeners = new Set<() => void>();
const lastEvidenceAt = new Map<string, number>();
let stopListening: (() => void) | null = null;
let stopWaitingForMediaEngine: (() => void) | null = null;
let stopWaitingForVoiceState: (() => void) | null = null;
let unpatchNativeSpeaking: (() => void) | null = null;
let notificationsEnabled = true;
let localVoiceControlStore: AnyRecord | null = null;
let voiceStateStore: AnyRecord | null = null;
let selfProbeTimer: ReturnType<typeof setInterval> | null = null;
let selfMismatchSince = 0;
let selfMismatchKey = "";
let selfReadySince = 0;
let selfReadyKey = "";
let selfProbeStatus = "Waiting for Discord voice stores...";

const JOIN_SETTLE_MS = 3000;
const CONFIRM_DELAY_MS = 1600;
const MAX_DETECTIONS = 100;

function log(...args: unknown[]) {
  try { console.log("[fake-deafen-detector]", ...args); } catch {}
}

function safeStore(name: string): AnyRecord | null {
  try { return (Stores as AnyRecord)[name] ?? null; } catch { return null; }
}

function currentUserId(): string | null {
  try { return safeStore("UserStore")?.getCurrentUser?.()?.id ?? null; } catch { return null; }
}

function findLocalVoiceControlStore(): AnyRecord | null {
  if (localVoiceControlStore) return localVoiceControlStore;
  const direct = safeStore("MediaEngineStore");
  if (direct) {
    localVoiceControlStore = direct;
    return direct;
  }
  return null;
}

function getDefaultRtcConnection(userId: string): AnyRecord | null {
  const store = findLocalVoiceControlStore();
  try {
    const engine = store?.getMediaEngine?.();
    const rawConnections = engine?.connections;
    const connections: AnyRecord[] = rawConnections instanceof Set
      ? [...rawConnections] : Array.isArray(rawConnections) ? rawConnections : [];
    const owned = connections.filter(connection =>
      connection && connection.context === "default" &&
      connection.userId === userId && connection.destroyed !== true
    );
    const connected = owned.filter(connection => connection.connectionState === "CONNECTED");
    return connected[connected.length - 1] ?? null;
  } catch (error) {
    log("Could not read active RTC connection", String(error));
    return null;
  }
}

function readConnectionBoolean(connection: AnyRecord, method: string, property: string): boolean | null {
  try {
    const getter = connection?.[method];
    if (typeof getter === "function") {
      const value = getter.call(connection);
      return typeof value === "boolean" ? value : null;
    }
    const value = connection?.[property];
    return typeof value === "boolean" ? value : null;
  } catch (error) {
    log("RTC state getter failed", method, String(error));
    return null;
  }
}

function getLocalVoiceFlags(userId: string): LocalVoiceFlags {
  const connection = getDefaultRtcConnection(userId);
  if (!connection) {
    return {
      selfMute: null,
      selfDeaf: null,
      connectionId: null,
      connectionState: null,
      ready: false,
    };
  }

  const selfMute = readConnectionBoolean(connection, "getSelfMute", "selfMute");
  const selfDeaf = readConnectionBoolean(connection, "getSelfDeaf", "selfDeaf");
  return {
    selfMute,
    selfDeaf,
    connectionId: toStringOrNull(connection.mediaEngineConnectionId),
    connectionState: toStringOrNull(connection.connectionState),
    ready: selfMute !== null && selfDeaf !== null,
  };
}

function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && /^\d{15,22}$/.test(value);
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function normalizeVoiceState(userId: string, raw: AnyRecord): VoiceState | null {
  if (!raw || typeof raw !== "object") return null;
  const selfDeaf = raw.self_deaf ?? raw.selfDeaf;
  if (typeof selfDeaf !== "boolean") return null;
  const previous = voiceStates.get(userId);
  const now = Date.now();
  const channelId = toStringOrNull(raw.channelId ?? raw.channel_id) ?? previous?.channelId ?? null;
  const guildId = toStringOrNull(raw.guildId ?? raw.guild_id) ?? previous?.guildId ?? null;
  return {
    userId, channelId, guildId, selfDeaf,
    selfMute: typeof (raw.self_mute ?? raw.selfMute) === "boolean"
      ? Boolean(raw.self_mute ?? raw.selfMute) : previous?.selfMute,
    flagsSince: previous &&
      previous.selfDeaf === selfDeaf &&
      previous.selfMute === (typeof (raw.self_mute ?? raw.selfMute) === "boolean" ? Boolean(raw.self_mute ?? raw.selfMute) : previous.selfMute) &&
      previous.channelId === channelId
        ? previous.flagsSince : now,
    updatedAt: now,
  };
}

function collectVoiceStates(value: unknown, output: VoiceState[], parentKey = "", depth = 0): void {
  if (!value || typeof value !== "object" || depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) collectVoiceStates(item, output, parentKey, depth + 1);
    return;
  }
  const obj = value as AnyRecord;
  const id = obj.userId ?? obj.user_id ?? obj.id ?? (isSnowflake(parentKey) ? parentKey : null);
  const state = isSnowflake(id) ? normalizeVoiceState(id, obj) : null;
  if (state) output.push(state);
  for (const [key, child] of Object.entries(obj)) {
    if (child && typeof child === "object") collectVoiceStates(child, output, key, depth + 1);
  }
}

function getVoiceState(userId: string): VoiceState | null {
  try {
    const store = voiceStateStore ?? safeStore("VoiceStateStore");
    const raw = store?.getVoiceStateForUser?.(userId) ?? store?.getVoiceState?.(null, userId) ?? null;
    if (raw && typeof raw === "object") {
      const normalized = normalizeVoiceState(userId, raw as AnyRecord);
      if (normalized) {
        voiceStates.set(userId, normalized);
        return normalized;
      }
    }
  } catch (error) { log("VoiceStateStore lookup failed", String(error)); }
  return voiceStates.get(userId) ?? null;
}

function getUserDetails(userId: string, guildId: string | null): { displayName: string; username: string } {
  let user: AnyRecord | null = null;
  let nickname: string | null = null;
  try {
    const userStore = safeStore("UserStore");
    user = userStore?.getUser?.(userId) ?? userStore?.getUserById?.(userId) ?? null;
  } catch {}
  if (guildId) {
    try {
      const memberStore = safeStore("GuildMemberStore");
      const member = memberStore?.getMember?.(guildId, userId);
      nickname = toStringOrNull(member?.nick) ?? toStringOrNull(memberStore?.getNick?.(guildId, userId));
    } catch {}
  }
  const username = toStringOrNull(user?.username) ?? userId;
  const displayName = nickname ?? toStringOrNull(user?.globalName) ??
    toStringOrNull(user?.global_name) ?? toStringOrNull(user?.displayName) ?? username;
  return { displayName, username };
}

function emitSettingsUpdate(): void {
  for (const listener of [...settingsListeners]) {
    try { listener(); } catch {}
  }
}

function getOwnVoiceState(): VoiceState | null {
  const ownId = currentUserId();
  return ownId ? getVoiceState(ownId) : null;
}

function setSelfProbeStatus(value: string): void {
  if (selfProbeStatus === value) return;
  selfProbeStatus = value;
  emitSettingsUpdate();
}

function evaluateSelfMismatch(): void {
  const ownId = currentUserId();
  if (!ownId) {
    selfMismatchSince = 0;
    selfMismatchKey = "";
    setSelfProbeStatus("Unable to read the current account.");
    return;
  }

  const ownState = getVoiceState(ownId);
  if (!ownState?.channelId) {
    selfMismatchSince = 0;
    selfMismatchKey = "";
    selfReadySince = 0;
    selfReadyKey = "";
    alertedUsers.delete(ownId);
    setSelfProbeStatus("Join a voice channel. Waiting for your VoiceStateStore entry.");
    return;
  }

  const local = getLocalVoiceFlags(ownId);
  if (!local.ready || !local.connectionId || local.connectionState !== "CONNECTED") {
    selfMismatchSince = 0;
    selfMismatchKey = "";
    selfReadySince = 0;
    selfReadyKey = "";
    alertedUsers.delete(ownId);
    setSelfProbeStatus("Waiting for a connected default RTC media connection. Server state is not judged yet.");
    return;
  }

  const readyKey = ownState.channelId + ":" + local.connectionId;
  if (selfReadyKey !== readyKey) {
    selfReadyKey = readyKey;
    selfReadySince = Date.now();
    selfMismatchSince = 0;
    selfMismatchKey = "";
    setSelfProbeStatus("RTC connected. Letting voice state settle before checking.");
    return;
  }
  const readyFor = Date.now() - selfReadySince;
  if (readyFor < JOIN_SETTLE_MS) {
    setSelfProbeStatus("Voice connection settling (" +
      Math.ceil((JOIN_SETTLE_MS - readyFor) / 1000) + "s). No detection during join.");
    return;
  }

  const serverMute = ownState.selfMute;
  const serverDeaf = ownState.selfDeaf;
  const muteMismatch = typeof serverMute === "boolean" && local.selfMute !== null &&
    serverMute && !local.selfMute;
  const deafMismatch = typeof serverDeaf === "boolean" && local.selfDeaf !== null &&
    serverDeaf && !local.selfDeaf;

  const show = (value: boolean | undefined | null) =>
    value === null || value === undefined ? "unavailable" : value ? "ON" : "OFF";
  const baseStatus = "Server mute " + show(serverMute) + " / RTC mute " + show(local.selfMute) +
    " · Server deafen " + show(serverDeaf) + " / RTC deafen " + show(local.selfDeaf) +
    " · RTC " + (local.connectionState ?? "unavailable");

  if (!muteMismatch && !deafMismatch) {
    selfMismatchSince = 0;
    selfMismatchKey = "";
    alertedUsers.delete(ownId);
    setSelfProbeStatus("No fake-state mismatch. " + baseStatus);
    return;
  }

  const mismatchKey = (muteMismatch ? "mute" : "") + (deafMismatch ? "+deafen" : "");
  if (selfMismatchKey !== mismatchKey) {
    selfMismatchKey = mismatchKey;
    selfMismatchSince = Date.now();
  }
  const elapsed = Date.now() - selfMismatchSince;
  if (elapsed < CONFIRM_DELAY_MS) {
    setSelfProbeStatus("Checking " + mismatchKey + " mismatch (" +
      Math.ceil((CONFIRM_DELAY_MS - elapsed) / 1000) + "s). " + baseStatus);
    return;
  }

  const kind: Detection["kind"] = muteMismatch && deafMismatch
    ? "self-fake-mute-and-deafen"
    : muteMismatch ? "self-fake-mute" : "self-fake-deafen";
  const label = muteMismatch && deafMismatch ? "FAKE MUTE + FAKE DEAFEN"
    : muteMismatch ? "FAKE MUTE" : "FAKE DEAFEN";
  setSelfProbeStatus("DETECTED " + label + ". " + baseStatus);

  if (!alertedUsers.has(ownId)) {
    const evidence = "Server flags: self_mute=" + show(serverMute) + ", self_deaf=" + show(serverDeaf) +
      "; active RTC connection flags: getSelfMute=" + show(local.selfMute) +
      ", getSelfDeaf=" + show(local.selfDeaf) + "; connection=" + String(local.connectionId) +
      "; mismatch persisted over " + CONFIRM_DELAY_MS + "ms after join settling.";
    const detection = addOrUpdateDetection(ownId, ownState, kind, evidence);
    alertedUsers.add(ownId);
    showDetectionToast(detection);
    log("SELF_FAKE_VOICE_STATE_MISMATCH", detection);
  }
}

function isSpeakingStartEvent(type: string, data: AnyRecord): boolean {
  if (type.includes("SPEAKING_STOP") || type.includes("SPEAKING_END")) return false;
  if (type.includes("SPEAKING_START")) return true;
  if (type.includes("SPEAKING") || type.includes("VOICE_ACTIVITY")) {
    const speaking = data.speaking ?? data.isSpeaking ?? data.is_speaking;
    return speaking === undefined || speaking === true || speaking === 1 ||
      (typeof speaking === "number" && speaking > 0);
  }
  return false;
}

function extractSpeakerId(data: AnyRecord): string | null {
  const direct = data.userId ?? data.user_id ?? data.ssrcUserId ?? data.ssrc_user_id;
  if (isSnowflake(direct)) return direct;
  const nested = data.user?.id ?? data.member?.user?.id ?? data.speaker?.id;
  return isSnowflake(nested) ? nested : null;
}

function addOrUpdateDetection(userId: string, state: VoiceState, kind: Detection["kind"], evidence: string): Detection {
  const now = Date.now();
  const details = getUserDetails(userId, state.guildId);
  const old = detections.get(userId);
  const detection: Detection = old ? {
    ...old, displayName: details.displayName, username: details.username,
    channelId: state.channelId!, guildId: state.guildId, lastSeen: now,
    evidenceCount: old.evidenceCount + 1, kind, evidence,
  } : {
    userId, displayName: details.displayName, username: details.username,
    channelId: state.channelId!, guildId: state.guildId, firstSeen: now,
    lastSeen: now, evidenceCount: 1, kind, evidence,
  };
  detections.set(userId, detection);
  while (detections.size > MAX_DETECTIONS) {
    const oldest = [...detections.values()].sort((a, b) => a.firstSeen - b.firstSeen)[0];
    if (!oldest) break;
    detections.delete(oldest.userId);
  }
  emitSettingsUpdate();
  return detection;
}

function showDetectionToast(detection: Detection): void {
  if (!notificationsEnabled) return;
  const username = detection.username.startsWith("@") ? detection.username : "@" + detection.username;
  const reason = detection.kind === "self-fake-mute-and-deafen"
    ? "Your server state says Muted + Deafened, but your local media state disagrees."
    : detection.kind === "self-fake-mute"
      ? "Your server state says Muted, but your local media state says unmuted."
      : detection.kind === "self-fake-deafen"
        ? "Your server state says Deafened, but your local media state says undeafened."
        : "Discord reported speaking while this user was server-marked Muted or Deafened.";
  const text = "Possible Fake Voice State detected\n" + detection.displayName + "\n" +
    username + "\n" + reason;
  try {
    ToastActionCreators.open("fake-voice-state-detected-" + detection.userId, { text, variant: "critical" });
  } catch (error) { log("Toast failed", String(error), detection.userId); }
}

function evaluateSpeaker(userId: string, eventData: AnyRecord): void {
  const ownId = currentUserId();
  if (!ownId) return;
  const ownState = getOwnVoiceState();
  const memberState = getVoiceState(userId);
  if (!ownState?.channelId || !memberState?.channelId) return;
  if (memberState.channelId !== ownState.channelId) return;
  const eventChannelId = toStringOrNull(eventData.channelId ?? eventData.channel_id);
  if (eventChannelId && eventChannelId !== ownState.channelId) return;
  if (!memberState.selfDeaf && !memberState.selfMute) return;

  const now = Date.now();
  const lastEvidence = lastEvidenceAt.get(userId) ?? 0;
  if (now - lastEvidence < 1400) return;
  lastEvidenceAt.set(userId, now);

  const stableFor = Date.now() - memberState.flagsSince;
  const confirm = () => {
    const latestOwn = getOwnVoiceState();
    const latestMember = getVoiceState(userId);
    if (!latestOwn?.channelId || latestMember?.channelId !== latestOwn.channelId ||
        (!latestMember.selfDeaf && !latestMember.selfMute)) return;
    if (Date.now() - latestMember.flagsSince < CONFIRM_DELAY_MS) return;
    const detection = addOrUpdateDetection(
      userId,
      latestMember,
      "remote-speaking-mismatch",
      "Discord reported speaking activity while self_mute=" + latestMember.selfMute +
        " or self_deaf=" + latestMember.selfDeaf + " in the same voice channel."
    );
    if (!alertedUsers.has(userId)) {
      alertedUsers.add(userId);
      showDetectionToast(detection);
    }
    log("STRONG_FAKE_VOICE_STATE_SIGNAL", detection);
  };

  if (stableFor < CONFIRM_DELAY_MS) {
    const oldTimer = pendingChecks.get(userId);
    if (oldTimer) clearTimeout(oldTimer);
    const timer = setTimeout(() => {
      pendingChecks.delete(userId);
      confirm();
    }, CONFIRM_DELAY_MS - stableFor);
    pendingChecks.set(userId, timer);
    return;
  }
  confirm();
}

function handleVoiceStateEvents(type: string, data: AnyRecord): void {
  if (!type.includes("VOICE_STATE")) return;
  const found: VoiceState[] = [];
  collectVoiceStates(data, found);
  for (const state of found) {
    voiceStates.set(state.userId, state);
    if (!state.selfDeaf && !state.selfMute) {
      alertedUsers.delete(state.userId);
      const timer = pendingChecks.get(state.userId);
      if (timer) clearTimeout(timer);
      pendingChecks.delete(state.userId);
    }
  }
  if (found.length) log("Voice state update", type, found.length);
  evaluateSelfMismatch();
}

function handleEvent(event: AnyRecord): AnyRecord {
  try {
    const type = String(event?.type ?? "").toUpperCase();
    const data = event?.data && typeof event.data === "object" ? event.data as AnyRecord
      : event?.payload && typeof event.payload === "object" ? event.payload as AnyRecord
      : event;
    handleVoiceStateEvents(type, data);
    if (isSpeakingStartEvent(type, data)) {
      const userId = extractSpeakerId(data);
      if (userId) evaluateSpeaker(userId, data);
    }
    const nestedId = data.speaking?.userId ?? data.speaking?.user_id;
    if (type.includes("SPEAKING") && !type.includes("STOP") && !type.includes("END") && isSnowflake(nestedId)) {
      evaluateSpeaker(nestedId, data);
    }
    if (voiceStates.size > 400) {
      const cutoff = Date.now() - 15 * 60 * 1000;
      for (const [id, state] of voiceStates) if (state.updatedAt < cutoff) voiceStates.delete(id);
    }
  } catch (error) { log("Event handler error", String(error)); }
  return event;
}

function installNativeSpeakingHook(store?: AnyRecord): void {
  if (unpatchNativeSpeaking) return;
  const target = store ?? safeStore("MediaEngineStore");
  if (!target || typeof target.handleSpeakingNative !== "function") {
    log("MediaEngineStore.handleSpeakingNative is not available on this build; Flux speaking events remain enabled.");
    return;
  }

  try {
    unpatchNativeSpeaking = before(target, "handleSpeakingNative", (args: unknown[]) => {
      const userId = args[0];
      const speaking = args[1];
      const isActive = speaking === true || (typeof speaking === "number" && speaking !== 0);
      if (isActive && isSnowflake(userId)) {
        evaluateSpeaker(userId, { source: "MediaEngineStore.handleSpeakingNative" });
      }
      return args;
    });
    log("Native speaking hook installed.");
  } catch (error) {
    log("Could not hook native speaking handler", String(error));
  }
}

function clearDetections(): void {
  detections.clear();
  emitSettingsUpdate();
}

function settingsComponent({ api }: { api: any }): any {
  const React = api?.unscoped?.react?.React ?? api?.unscoped?.react;
  const RN = api?.unscoped?.react?.native?.ReactNative ?? api?.unscoped?.react?.native;
  const FormSwitch = api?.unscoped?.components?.FormSwitch ?? api?.components?.FormSwitch;
  if (!React?.createElement || !RN?.View || !RN?.Text) return null;

  const useState = React.useState?.bind(React);
  const useEffect = React.useEffect?.bind(React);
  const [revision, setRevision] = useState ? useState(0) : [0, () => {}];
  void revision;

  if (useEffect) {
    useEffect(() => {
      const listener = () => setRevision((value: number) => value + 1);
      settingsListeners.add(listener);
      return () => { settingsListeners.delete(listener); };
    }, []);
  }

  const h = React.createElement;
  const titleStyle = { fontSize: 16, fontWeight: "700", marginBottom: 6 };
  const subStyle = { fontSize: 13, opacity: 0.72, marginBottom: 12 };
  const rowStyle = { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "rgba(128,128,128,0.25)" };
  const nameStyle = { fontSize: 15, fontWeight: "600" };
  const detailStyle = { fontSize: 12, opacity: 0.75, marginTop: 3 };
  const ordered = [...detections.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  const children: any[] = [
    h(RN.Text, { key: "title", style: titleStyle }, "Fake Deafen detections"),
    h(RN.Text, { key: "description", style: subStyle },
      "Checks your own account by comparing server VoiceStateStore flags with local MediaEngineStore flags for Fake Mute, Fake Deafen, or both. Other members are flagged when Discord reports speaking while their server state says Muted or Deafened."
    ),
    h(RN.Text, { key: "self-test", style: detailStyle }, "Self-test: " + selfProbeStatus),
  ];

  if (FormSwitch) {
    children.push(h(FormSwitch, {
      key: "notifications", value: notificationsEnabled,
      onValueChange: (value: boolean) => { notificationsEnabled = value; emitSettingsUpdate(); },
      label: "Show detection notifications",
      subLabel: "Display a toast with the member name and username.",
    }));
  }

  if (ordered.length === 0) {
    children.push(h(RN.Text, { key: "empty", style: detailStyle },
      "No suspicious mute/deafen mismatches detected in this session."
    ));
  } else {
    for (const item of ordered) {
      const time = new Date(item.lastSeen).toLocaleTimeString();
      children.push(h(RN.View, { key: item.userId, style: rowStyle },
        h(RN.Text, { style: nameStyle }, item.displayName),
        h(RN.Text, { style: detailStyle }, "@" + item.username.replace(/^@/, "")),
        h(RN.Text, { style: detailStyle }, "User ID: " + item.userId),
        h(RN.Text, { style: detailStyle }, "Evidence signals: " + item.evidenceCount + " · Last seen: " + time),
        h(RN.Text, { style: detailStyle }, item.kind === "self-fake-mute" ? "Evidence: server says muted, local client says unmuted"
          : item.kind === "self-fake-deafen" ? "Evidence: server says deafened, local client says undeafened"
          : item.kind === "self-fake-mute-and-deafen" ? "Evidence: server says muted + deafened, local client disagrees"
          : "Evidence: speaking event while server-marked muted/deafened"),
        h(RN.Text, { style: detailStyle }, item.evidence)
      ));
    }
  }

  const Pressable = RN.Pressable ?? RN.TouchableOpacity;
  if (ordered.length > 0 && Pressable) {
    children.push(h(Pressable, {
      key: "clear", onPress: clearDetections,
      style: { alignSelf: "flex-start", marginTop: 12, padding: 10, borderRadius: 8, backgroundColor: "rgba(128,128,128,0.16)" },
    }, h(RN.Text, { style: { fontSize: 14, fontWeight: "600" } }, "Clear detection history")));
  }
  return h(RN.View, { style: { padding: 16, gap: 8 } }, ...children);
}

export default plugin({
  start({ cleanup }: any) {
    voiceStates.clear(); detections.clear(); alertedUsers.clear(); pendingChecks.clear();
    settingsListeners.clear();
    lastEvidenceAt.clear();
    localVoiceControlStore = null;
    selfMismatchSince = 0;
    selfMismatchKey = "";
    selfReadySince = 0;
    selfReadyKey = "";
    selfProbeStatus = "Waiting for Discord voice stores...";
    localVoiceControlStore = safeStore("MediaEngineStore");
    voiceStateStore = safeStore("VoiceStateStore");
    try {
      installNativeSpeakingHook(localVoiceControlStore ?? undefined);
      if (selfProbeTimer) clearInterval(selfProbeTimer);
      selfProbeTimer = setInterval(evaluateSelfMismatch, 500);
      evaluateSelfMismatch();
      stopWaitingForMediaEngine = getStore<AnyRecord>("MediaEngineStore", store => {
        localVoiceControlStore = store as AnyRecord;
        installNativeSpeakingHook(localVoiceControlStore);
        evaluateSelfMismatch();
        emitSettingsUpdate();
      });
      stopWaitingForVoiceState = getStore<AnyRecord>("VoiceStateStore", store => {
        voiceStateStore = store as AnyRecord;
        evaluateSelfMismatch();
        emitSettingsUpdate();
      });
      stopListening = onAnyFluxEventDispatched((event: AnyRecord) => handleEvent(event));
      cleanup(() => {
        try { stopListening?.(); } catch {}
        stopListening = null;
        try { stopWaitingForMediaEngine?.(); } catch {}
        stopWaitingForMediaEngine = null;
        try { stopWaitingForVoiceState?.(); } catch {}
        stopWaitingForVoiceState = null;
        try { unpatchNativeSpeaking?.(); } catch {}
        unpatchNativeSpeaking = null;
        if (selfProbeTimer) clearInterval(selfProbeTimer);
        selfProbeTimer = null;
        localVoiceControlStore = null;
        voiceStateStore = null;
        selfMismatchSince = 0;
        selfMismatchKey = "";
        selfReadySince = 0;
        selfReadyKey = "";
        for (const timer of pendingChecks.values()) clearTimeout(timer);
        pendingChecks.clear(); voiceStates.clear(); detections.clear(); alertedUsers.clear(); lastEvidenceAt.clear();
        settingsListeners.clear();
      });
      log("Started. Comparing local/server self-mute and self-deafen flags, plus remote speaking events.");
    } catch (error) { log("Could not subscribe to Flux events", String(error)); }
  },
  stop() {
    try { stopListening?.(); } catch {}
    stopListening = null;
    try { stopWaitingForMediaEngine?.(); } catch {}
    stopWaitingForMediaEngine = null;
    try { unpatchNativeSpeaking?.(); } catch {}
    unpatchNativeSpeaking = null;
    if (selfProbeTimer) clearInterval(selfProbeTimer);
    selfProbeTimer = null;
    localVoiceControlStore = null;
    voiceStateStore = null;
    selfMismatchSince = 0;
    selfMismatchKey = "";
    selfReadySince = 0;
    selfReadyKey = "";
    try { stopWaitingForVoiceState?.(); } catch {}
    stopWaitingForVoiceState = null;
    for (const timer of pendingChecks.values()) clearTimeout(timer);
    pendingChecks.clear(); voiceStates.clear(); detections.clear(); alertedUsers.clear(); lastEvidenceAt.clear();
    settingsListeners.clear();
  },
  SettingsComponent: settingsComponent,
});
