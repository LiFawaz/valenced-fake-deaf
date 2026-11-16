/// <reference types="@valenced/types" />

import { Stores, getStore, onAnyFluxEventDispatched } from "@valenced/discord/flux";
import { before } from "@valenced/patcher";
import { ToastActionCreators } from "@valenced/discord/actions";

type AnyRecord = Record<string, any>;
type VoiceState = {
  userId: string; channelId: string | null; guildId: string | null;
  selfDeaf: boolean; selfMute: boolean | undefined; deafSince: number; updatedAt: number;
};
type Detection = {
  userId: string; displayName: string; username: string; channelId: string;
  guildId: string | null; firstSeen: number; lastSeen: number;
  evidenceCount: number; evidence: string;
};

const voiceStates = new Map<string, VoiceState>();
const detections = new Map<string, Detection>();
const alertedUsers = new Set<string>();
const pendingChecks = new Map<string, ReturnType<typeof setTimeout>>();
const settingsListeners = new Set<() => void>();
const lastEvidenceAt = new Map<string, number>();
let stopListening: (() => void) | null = null;
let stopWaitingForMediaEngine: (() => void) | null = null;
let unpatchNativeSpeaking: (() => void) | null = null;
let notificationsEnabled = true;

const CONFIRM_DELAY_MS = 2200;
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
    deafSince: selfDeaf
      ? (previous?.selfDeaf && previous.channelId === channelId ? previous.deafSince : now)
      : 0,
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
    const store = safeStore("VoiceStateStore");
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

function addOrUpdateDetection(userId: string, state: VoiceState): Detection {
  const now = Date.now();
  const details = getUserDetails(userId, state.guildId);
  const old = detections.get(userId);
  const detection: Detection = old ? {
    ...old, displayName: details.displayName, username: details.username,
    channelId: state.channelId!, guildId: state.guildId, lastSeen: now,
    evidenceCount: old.evidenceCount + 1,
  } : {
    userId, displayName: details.displayName, username: details.username,
    channelId: state.channelId!, guildId: state.guildId, firstSeen: now,
    lastSeen: now, evidenceCount: 1,
    evidence: "Discord reported speaking activity while self_deaf was true in the same voice channel.",
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
  const text = "Possible Fake Deafen detected\n" + detection.displayName + "\n" +
    username + "\nDiscord reported speaking while this user was self-deafened.";
  try {
    ToastActionCreators.open("fake-deafen-detected-" + detection.userId, { text, variant: "critical" });
  } catch (error) { log("Toast failed", String(error), detection.userId); }
}

function evaluateSpeaker(userId: string, eventData: AnyRecord): void {
  const ownId = currentUserId();
  if (!ownId || userId === ownId) return;
  const ownState = getOwnVoiceState();
  const memberState = getVoiceState(userId);
  if (!ownState?.channelId || !memberState?.channelId) return;
  if (memberState.channelId !== ownState.channelId) return;
  const eventChannelId = toStringOrNull(eventData.channelId ?? eventData.channel_id);
  if (eventChannelId && eventChannelId !== ownState.channelId) return;
  if (!memberState.selfDeaf) return;

  const now = Date.now();
  const lastEvidence = lastEvidenceAt.get(userId) ?? 0;
  if (now - lastEvidence < 1400) return;
  lastEvidenceAt.set(userId, now);

  const stableFor = Date.now() - memberState.deafSince;
  const confirm = () => {
    const latestOwn = getOwnVoiceState();
    const latestMember = getVoiceState(userId);
    if (!latestOwn?.channelId || latestMember?.channelId !== latestOwn.channelId || !latestMember.selfDeaf) return;
    if (Date.now() - latestMember.deafSince < CONFIRM_DELAY_MS) return;
    const detection = addOrUpdateDetection(userId, latestMember);
    if (!alertedUsers.has(userId)) {
      alertedUsers.add(userId);
      showDetectionToast(detection);
    }
    log("STRONG_FAKE_DEAFEN_SIGNAL", detection);
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
    if (!state.selfDeaf) {
      alertedUsers.delete(state.userId);
      const timer = pendingChecks.get(state.userId);
      if (timer) clearTimeout(timer);
      pendingChecks.delete(state.userId);
    }
  }
  if (found.length) log("Voice state update", type, found.length);
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
      "Strong signals only: Discord reported this member speaking while their self-deafen state was active in your voice channel. This is not absolute proof of what their device played or heard."
    ),
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
      "No suspicious speaking/deafen mismatches detected in this session."
    ));
  } else {
    for (const item of ordered) {
      const time = new Date(item.lastSeen).toLocaleTimeString();
      children.push(h(RN.View, { key: item.userId, style: rowStyle },
        h(RN.Text, { style: nameStyle }, item.displayName),
        h(RN.Text, { style: detailStyle }, "@" + item.username.replace(/^@/, "")),
        h(RN.Text, { style: detailStyle }, "User ID: " + item.userId),
        h(RN.Text, { style: detailStyle }, "Evidence signals: " + item.evidenceCount + " · Last seen: " + time),
        h(RN.Text, { style: detailStyle }, "Strong signal — not 100% proof")
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
    try {
      installNativeSpeakingHook();
      stopWaitingForMediaEngine = getStore<AnyRecord>("MediaEngineStore", store => installNativeSpeakingHook(store as AnyRecord));
      stopListening = onAnyFluxEventDispatched((event: AnyRecord) => handleEvent(event));
      cleanup(() => {
        try { stopListening?.(); } catch {}
        stopListening = null;
        try { stopWaitingForMediaEngine?.(); } catch {}
        stopWaitingForMediaEngine = null;
        try { unpatchNativeSpeaking?.(); } catch {}
        unpatchNativeSpeaking = null;
        for (const timer of pendingChecks.values()) clearTimeout(timer);
        pendingChecks.clear(); voiceStates.clear(); detections.clear(); alertedUsers.clear(); lastEvidenceAt.clear();
        settingsListeners.clear();
      });
      log("Started. Watching for speaking signals that conflict with self-deafen state.");
    } catch (error) { log("Could not subscribe to Flux events", String(error)); }
  },
  stop() {
    try { stopListening?.(); } catch {}
    stopListening = null;
    try { stopWaitingForMediaEngine?.(); } catch {}
    stopWaitingForMediaEngine = null;
    try { unpatchNativeSpeaking?.(); } catch {}
    unpatchNativeSpeaking = null;
    for (const timer of pendingChecks.values()) clearTimeout(timer);
    pendingChecks.clear(); voiceStates.clear(); detections.clear(); alertedUsers.clear(); lastEvidenceAt.clear();
    settingsListeners.clear();
  },
  SettingsComponent: settingsComponent,
});
