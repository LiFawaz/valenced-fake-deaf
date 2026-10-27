/// <reference types="@valenced/types" />

import { lookupModules, waitForModules } from "@valenced/modules/finders";
import { withProps } from "@valenced/modules/finders/filters";
import * as discordFinders from "@valenced/discord/utils/modules/finders";

type AnyRecord = Record<string, any>;
type CommandArg = { name: string; value: unknown };

const BUILT_INS_PATH = "modules/application_commands/ApplicationCommandBuiltIns.tsx";
const state = { enabled: false, fakeMute: true, fakeDeafen: true };
let apiRef: any = null;
let patchedSocket: any = null;
let originalSend: ((...args: any[]) => any) | null = null;
let commandRegistry: AnyRecord[] | null = null;
const queuedCommands = new Map<string, AnyRecord>();
const cleanups: Array<() => void> = [];
let commandWatchers: Array<() => void> = [];
let commandWatching = false;

function log(...args: unknown[]) {
  try { console.log("[fake-deaf]", ...args); } catch {}
}

function findModule(candidates: string[][]): AnyRecord | null {
  for (const props of candidates) {
    try {
      for (const [mod] of lookupModules(withProps(...props) as any)) {
        if (mod && typeof mod === "object") return mod as AnyRecord;
      }
    } catch {}
  }
  return null;
}

function getGateway(): AnyRecord | null {
  return findModule([["getSocket"], ["getSocketProxy"], ["gatewaySocket"], ["socket", "send"]]);
}

function getSocket(): AnyRecord | null {
  const gateway = getGateway();
  try {
    const socket = gateway?.getSocket?.() ?? gateway?.getSocketProxy?.() ?? gateway?.gatewaySocket ?? gateway?.socket;
    return socket && typeof socket.send === "function" ? socket : null;
  } catch {
    return null;
  }
}

function voiceChannelStore(): AnyRecord | null {
  return findModule([["getVoiceChannelId"], ["getCurrentVoiceChannelId"], ["getSelectedVoiceChannelId"]]);
}

function getCurrentChannelId(): string | null {
  const store = voiceChannelStore();
  try {
    return store?.getVoiceChannelId?.() ?? store?.getCurrentVoiceChannelId?.() ?? store?.getSelectedVoiceChannelId?.() ?? null;
  } catch {
    return null;
  }
}

function patchGateway(): void {
  const socket = getSocket();
  if (!socket) {
    log("Gateway socket not found yet; will retry when modules load");
    return;
  }
  if (socket === patchedSocket) return;
  restoreGateway();
  patchedSocket = socket;
  originalSend = socket.send;
  socket.send = function (op: number, data: any, ...args: any[]) {
    if (op === 4 && state.enabled && data && typeof data === "object") {
      data = {
        ...data,
        ...(state.fakeMute ? { self_mute: true } : {}),
        ...(state.fakeDeafen ? { self_deaf: true } : {}),
      };
    }
    return originalSend!.apply(this, [op, data, ...args]);
  };
  log("Gateway send hook installed");
}

function restoreGateway(): void {
  if (patchedSocket && originalSend) {
    try { patchedSocket.send = originalSend; } catch {}
  }
  patchedSocket = null;
  originalSend = null;
}

function pushVoiceState(): string {
  const socket = getSocket();
  const channelId = getCurrentChannelId();
  if (!socket || !channelId) {
    log("Join a voice channel first; /fake needs an active call");
    return "Join a voice channel first, then run /fake.";
  }

  const channelStore = findModule([["getChannel", "getDMFromUserId"], ["getChannel"]]);
  const mediaStore = findModule([["isSelfMute", "isSelfDeaf"], ["isMute", "isDeaf"], ["isLocalMute", "isLocalDeaf"]]);
  const channel = channelStore?.getChannel?.(channelId);
  const realMute = mediaStore?.isSelfMute?.() ?? mediaStore?.isMute?.() ?? mediaStore?.isLocalMute?.() ?? false;
  const realDeaf = mediaStore?.isSelfDeaf?.() ?? mediaStore?.isDeaf?.() ?? mediaStore?.isLocalDeaf?.() ?? false;

  socket.send(4, {
    guild_id: channel?.guild_id ?? null,
    channel_id: channelId,
    self_mute: (state.enabled && state.fakeMute) || realMute,
    self_deaf: (state.enabled && state.fakeDeafen) || realDeaf,
    self_video: false,
    flags: 0,
  });
  log("Voice state pushed", { enabled: state.enabled, fakeMute: state.fakeMute, fakeDeafen: state.fakeDeafen });
  return state.enabled
    ? "Fake deafen ON — Discord is being told you're muted/deafened. Your local mic/audio may remain active."
    : "Fake deafen OFF — normal voice status restored.";
}

function setEnabled(enabled: boolean): string {
  state.enabled = enabled;
  return pushVoiceState();
}

function toggleFake(): string {
  return setEnabled(!state.enabled);
}

function commandEntry() {
  return {
    id: "lifawaz-fake-deaf-fake",
    applicationId: "-1",
    type: 1,
    inputType: 0,
    name: "fake",
    displayName: "fake",
    untranslatedName: "fake",
    description: "Toggle fake mute/deafen status",
    displayDescription: "Toggle fake mute/deafen status",
    untranslatedDescription: "Toggle fake mute/deafen status",
    options: [],
    execute(_args: CommandArg[]) {
      const result = toggleFake();
      log(result);
    },
  };
}

function extractBuiltIns(mod: AnyRecord): AnyRecord[] | null {
  if (Array.isArray(mod?.BUILT_IN_COMMANDS)) return mod.BUILT_IN_COMMANDS;
  if (Array.isArray(mod?.default?.BUILT_IN_COMMANDS)) return mod.default.BUILT_IN_COMMANDS;
  return null;
}

function stopCommandWatchers(): void {
  for (const stop of commandWatchers.splice(0)) {
    try { stop(); } catch {}
  }
  commandWatching = false;
}

function adoptCommandRegistry(value: unknown): boolean {
  if (commandRegistry || !Array.isArray(value)) return false;
  commandRegistry = value as AnyRecord[];
  for (const [id, entry] of queuedCommands) {
    const index = commandRegistry.findIndex(command => command?.id === id);
    if (index >= 0) commandRegistry.splice(index, 1);
    commandRegistry.push(entry);
    log("Registered /fake command");
  }
  queuedCommands.clear();
  stopCommandWatchers();
  return true;
}

function watchCommandRegistry(): void {
  if (commandWatching || commandRegistry) return;
  commandWatching = true;
  try {
    const finder = discordFinders as AnyRecord;
    if (typeof finder.getModuleWithImportedPath === "function") {
      const unsubscribe = finder.getModuleWithImportedPath(BUILT_INS_PATH, (exports: AnyRecord) => adoptCommandRegistry(extractBuiltIns(exports)));
      if (typeof unsubscribe === "function") commandWatchers.push(unsubscribe);
    }
  } catch (error) { log("Command path lookup failed", String(error)); }

  if (commandRegistry) return stopCommandWatchers();
  try {
    const filter = withProps("BUILT_IN_COMMANDS");
    for (const [exports] of lookupModules(filter as any)) {
      if (adoptCommandRegistry(extractBuiltIns(exports as AnyRecord))) return;
    }
    const unsubscribe = waitForModules(filter as any, (exports: AnyRecord) => adoptCommandRegistry(extractBuiltIns(exports)));
    if (typeof unsubscribe === "function") commandWatchers.push(() => unsubscribe());
  } catch (error) { log("Command registry watcher failed", String(error)); }
}

function registerCommand(): () => void {
  const entry = commandEntry();
  const id = String(entry.id);
  if (commandRegistry) {
    const index = commandRegistry.findIndex(command => command?.id === id);
    if (index >= 0) commandRegistry.splice(index, 1);
    commandRegistry.push(entry);
    log("Registered /fake command");
  } else {
    queuedCommands.set(id, entry);
    watchCommandRegistry();
  }
  return () => {
    queuedCommands.delete(id);
    if (commandRegistry) {
      const index = commandRegistry.findIndex(command => command?.id === id);
      if (index >= 0) commandRegistry.splice(index, 1);
    }
    if (!queuedCommands.size) stopCommandWatchers();
  };
}

function settingsComponent({ api }: { api: any }): any {
  const React = api?.unscoped?.react?.React ?? api?.unscoped?.react;
  const FormSwitch = api?.unscoped?.components?.FormSwitch ?? api?.components?.FormSwitch;
  const RN = api?.unscoped?.react?.native?.ReactNative ?? api?.unscoped?.react?.native;
  if (!React?.createElement || !FormSwitch || !RN?.View) {
    return null;
  }
  return React.createElement(
    RN.View,
    { style: { padding: 16, gap: 12 } },
    React.createElement(FormSwitch, {
      label: "Fake Deafen Active",
      subLabel: "Toggle the status reported to Discord. Local microphone/audio behavior can vary by client version.",
      value: state.enabled,
      onValueChange: (value: boolean) => { const result = setEnabled(value); log(result); },
    }),
    React.createElement(FormSwitch, {
      label: "Broadcast as Muted",
      value: state.fakeMute,
      onValueChange: (value: boolean) => { state.fakeMute = value; if (state.enabled) pushVoiceState(); },
    }),
    React.createElement(FormSwitch, {
      label: "Broadcast as Deafened",
      value: state.fakeDeafen,
      onValueChange: (value: boolean) => { state.fakeDeafen = value; if (state.enabled) pushVoiceState(); },
    }),
  );
}

export default plugin({
  start(api: any) {
    apiRef = api;
    state.enabled = false;
    patchGateway();
    cleanups.push(registerCommand());

    try {
      const subscribe = api.unscoped.discord.utils.modules.metro.subscriptions.onModuleFinishedImporting;
      if (typeof subscribe === "function") {
        const unsubscribe = subscribe(() => {
          patchGateway();
          if (!commandRegistry) watchCommandRegistry();
        });
        if (typeof unsubscribe === "function") cleanups.push(unsubscribe);
      }
    } catch (error) { log("Module import subscription unavailable", String(error)); }

    api.cleanup(() => {
      for (const cleanup of cleanups.splice(0)) {
        try { cleanup(); } catch {}
      }
      restoreGateway();
      stopCommandWatchers();
      commandRegistry = null;
      queuedCommands.clear();
      state.enabled = false;
      apiRef = null;
    });
    log("Loaded. Use /fake in Discord to toggle.");
  },
  stop() {
    for (const cleanup of cleanups.splice(0)) {
      try { cleanup(); } catch {}
    }
    restoreGateway();
    stopCommandWatchers();
    commandRegistry = null;
    queuedCommands.clear();
    state.enabled = false;
    apiRef = null;
  },
  SettingsComponent: settingsComponent,
});
