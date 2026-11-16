/// <reference types="@valenced/types" />

import { Stores, onAnyFluxEventDispatched } from "@valenced/discord/flux";
import { ToastActionCreators } from "@valenced/discord/actions";

type AnyRecord = Record<string, any>;
type VoiceState = {
  userId: string;
  selfDeaf: boolean;
  selfMute?: boolean;
  updatedAt: number;
};
type SpeakingMark = { times: number[]; alertedAt: number };

const voiceStates = new Map<string, VoiceState>();
const speakingMarks = new Map<string, SpeakingMark>();
const recentAlerts = new Map<string, number>();
let stopListening: (() => void) | null = null;
let eventCount = 0;

function log(...args: unknown[]) {
  try { console.log("[fake-deafen-detector]", ...args); } catch {}
}

function currentUserId(): string | null {
  try {
    return Stores.UserStore.getCurrentUser()?.id ?? null;
  } catch {
    return null;
  }
}

function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && /^\d{15,22}$/.test(value);
}

function collectVoiceStates(value: unknown, output: VoiceState[], parentKey = "", depth = 0): void {
  if (!value || typeof value !== "object" || depth > 7) return;
  if (Array.isArray(value)) {
    for (const item of value) collectVoiceStates(item, output, parentKey, depth + 1);
    return;
  }

  const obj = value as AnyRecord;
  const hasDeaf = typeof obj.self_deaf === "boolean" || typeof obj.selfDeaf === "boolean";
  if (hasDeaf) {
    const userId = String(obj.userId ?? obj.user_id ?? obj.id ?? (isSnowflake(parentKey) ? parentKey : ""));
    if (isSnowflake(userId)) {
      output.push({
        userId,
        selfDeaf: Boolean(obj.self_deaf ?? obj.selfDeaf),
        selfMute: typeof obj.self_mute === "boolean" ? obj.self_mute :
          typeof obj.selfMute === "boolean" ? obj.selfMute : undefined,
        updatedAt: Date.now(),
      });
    }
  }

  for (const [key, child] of Object.entries(obj)) {
    if (child && typeof child === "object") collectVoiceStates(child, output, key, depth + 1);
  }
}

function collectUserIds(value: unknown, output: Set<string>, depth = 0): void {
  if (!value || typeof value !== "object" || depth > 6) return;
  if (Array.isArray(value)) {
    for (const item of value) collectUserIds(item, output, depth + 1);
    return;
  }
  const obj = value as AnyRecord;
  const id = obj.userId ?? obj.user_id ?? obj.ssrcUserId;
  if (isSnowflake(id)) output.add(id);
  for (const child of Object.values(obj)) {
    if (child && typeof child === "object") collectUserIds(child, output, depth + 1);
  }
}

function showPossibleFakeDeafen(userId: string): void {
  const now = Date.now();
  const lastAlert = recentAlerts.get(userId) ?? 0;
  if (now - lastAlert < 15000) return;
  recentAlerts.set(userId, now);

  const message = "Possible fake deafen: a deafened participant is still sending speaking activity. This is a clue, not proof.";
  try {
    ToastActionCreators.open("fake-deafen-detector-" + userId, {
      text: message + " User ID: " + userId,
      variant: "critical",
    });
  } catch (error) {
    log("Could not show alert", String(error), userId);
  }
  log("POSSIBLE_FAKE_DEAFEN", { userId, evidence: "speaking activity while self_deaf is true" });
}

function handleEvent(event: AnyRecord): AnyRecord {
  eventCount++;
  const type = String(event?.type ?? "").toUpperCase();
  const data = event?.data ?? event?.payload ?? event;

  if (type.includes("VOICE_STATE") || type.includes("VOICESTATE")) {
    const found: VoiceState[] = [];
    collectVoiceStates(data, found);
    for (const state of found) {
      voiceStates.set(state.userId, state);
      if (!state.selfDeaf) speakingMarks.delete(state.userId);
    }
    if (found.length) log("Voice states observed", found.length, type);
  }

  if (type.includes("SPEAK") || type.includes("VOICE_ACTIVITY")) {
    const ids = new Set<string>();
    collectUserIds(data, ids);
    const ownId = currentUserId();
    for (const userId of ids) {
      if (userId === ownId) continue;
      const state = voiceStates.get(userId);
      if (!state?.selfDeaf) continue;

      const mark = speakingMarks.get(userId) ?? { times: [], alertedAt: 0 };
      const now = Date.now();
      mark.times = mark.times.filter(time => now - time <= 8000);
      mark.times.push(now);
      speakingMarks.set(userId, mark);

      // Require repeated server-observed speaking activity to reduce stale-event false positives.
      if (mark.times.length >= 2) showPossibleFakeDeafen(userId);
    }
    if (ids.size) log("Speaking event observed", type, Array.from(ids));
  }

  // Keep memory bounded during long voice sessions.
  if (voiceStates.size > 300) {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, state] of voiceStates) if (state.updatedAt < cutoff) voiceStates.delete(id);
  }
  if (speakingMarks.size > 300) speakingMarks.clear();
  if (recentAlerts.size > 300) recentAlerts.clear();

  return event;
}

export default plugin({
  start({ cleanup }: any) {
    voiceStates.clear();
    speakingMarks.clear();
    recentAlerts.clear();
    eventCount = 0;

    try {
      stopListening = onAnyFluxEventDispatched((event: AnyRecord) => handleEvent(event));
      cleanup(() => {
        try { stopListening?.(); } catch {}
        stopListening = null;
        voiceStates.clear();
        speakingMarks.clear();
        recentAlerts.clear();
      });
      log("Started. Waiting for voice-state and speaking events.");
    } catch (error) {
      log("Could not subscribe to Flux events", String(error));
    }
  },
  stop() {
    try { stopListening?.(); } catch {}
    stopListening = null;
    voiceStates.clear();
    speakingMarks.clear();
    recentAlerts.clear();
  },
});
