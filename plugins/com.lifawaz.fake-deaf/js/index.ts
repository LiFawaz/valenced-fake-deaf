/// <reference types="@valenced/types" />

type FakeDeafenSettings = {
  enabled: boolean;
  fakeMute: boolean;
  fakeDeafen: boolean;
};

const state: FakeDeafenSettings = {
  enabled: false,
  fakeMute: true,
  fakeDeafen: true,
};

let originalSend: ((...args: any[]) => any) | null = null;
let patchedSocket: any = null;
let unpatches: Array<() => void> = [];

function findModule(api: any, candidates: string[][]): any {
  for (const props of candidates) {
    try {
      const filter = api.modules.finders.filters.withProps(...props);
      const found = api.modules.finders.lookupModule(filter, { returnNamespace: true });
      if (found && found.length) return found[0];
    } catch (error) {
      console.log("[fake-deaf] module lookup failed:", error);
    }
  }
  return null;
}

function getSocket(api: any): any {
  const gateway = findModule(api, [
    ["getSocket"],
    ["getSocketProxy"],
    ["gatewaySocket"],
    ["socket", "send"],
  ]);
  try {
    return gateway?.getSocket?.() ?? gateway?.getSocketProxy?.() ?? gateway?.gatewaySocket ?? gateway?.socket ?? null;
  } catch {
    return null;
  }
}

function patchGateway(api: any): void {
  const socket = getSocket(api);
  if (!socket || typeof socket.send !== "function" || socket === patchedSocket) {
    console.log("[fake-deaf] gateway socket not available yet");
    return;
  }

  if (patchedSocket && originalSend) patchedSocket.send = originalSend;
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

  console.log("[fake-deaf] gateway send hook installed");
}

function restoreGateway(): void {
  if (patchedSocket && originalSend) {
    patchedSocket.send = originalSend;
  }
  patchedSocket = null;
  originalSend = null;
}

function forceVoiceState(api: any): void {
  const socket = getSocket(api);
  const voiceStore = findModule(api, [
    ["getVoiceChannelId"],
    ["getCurrentVoiceChannelId"],
    ["getSelectedVoiceChannelId"],
  ]);
  const channelStore = findModule(api, [["getChannel", "getDMFromUserId"], ["getChannel"]]);
  const mediaStore = findModule(api, [
    ["isSelfMute", "isSelfDeaf"],
    ["isMute", "isDeaf"],
    ["isLocalMute", "isLocalDeaf"],
  ]);

  const channelId =
    voiceStore?.getVoiceChannelId?.() ??
    voiceStore?.getCurrentVoiceChannelId?.() ??
    voiceStore?.getSelectedVoiceChannelId?.();

  if (!socket || typeof socket.send !== "function" || !channelId) {
    console.log("[fake-deaf] join a voice channel before toggling the fake state");
    return;
  }

  const channel = channelStore?.getChannel?.(channelId);
  const realMute =
    mediaStore?.isSelfMute?.() ??
    mediaStore?.isMute?.() ??
    mediaStore?.isLocalMute?.() ??
    false;
  const realDeaf =
    mediaStore?.isSelfDeaf?.() ??
    mediaStore?.isDeaf?.() ??
    mediaStore?.isLocalDeaf?.() ??
    false;

  socket.send(4, {
    guild_id: channel?.guild_id ?? null,
    channel_id: channelId,
    self_mute: (state.enabled && state.fakeMute) || realMute,
    self_deaf: (state.enabled && state.fakeDeafen) || realDeaf,
    self_video: false,
    flags: 0,
  });
}

function setEnabled(api: any, enabled: boolean): void {
  state.enabled = enabled;
  forceVoiceState(api);
}

export default plugin({
  start(api: any) {
    state.enabled = false;
    patchGateway(api.unscoped);
    // Discord's gateway module can initialize after plugins start.
    const unsub = api.unscoped.discord.utils.modules.metro.subscriptions.onModuleFinishedImporting(() => {
      patchGateway(api.unscoped);
    });
    if (typeof unsub === "function") unpatches.push(unsub);
    api.cleanup(() => {
      restoreGateway();
      for (const unpatch of unpatches.splice(0)) {
        try { unpatch(); } catch {}
      }
      state.enabled = false;
    });
    console.log("[fake-deaf] loaded; configure it from plugin settings");
  },

  stop() {
    restoreGateway();
    for (const unpatch of unpatches.splice(0)) {
      try { unpatch(); } catch {}
    }
  },

  SettingsComponent() {
    const api = (globalThis as any).valenced;
    const React = api?.react ?? (globalThis as any).React;
    const FormSwitch = api?.components?.FormSwitch;
    if (!React?.createElement || !FormSwitch) {
      return React?.createElement?.("RCTText", null, "Fake-deaf settings are unavailable in this Valenced build.") ?? null;
    }

    return React.createElement(
      "RCTView",
      { style: { padding: 16, gap: 12 } },
      React.createElement(FormSwitch, {
        label: "Fake Deafen Active",
        subLabel: "Others may see you as muted/deafened while local audio remains live.",
        value: state.enabled,
        onValueChange: (value: boolean) => {
          state.enabled = value;
          console.log("[fake-deaf] enabled:", value);
        },
      }),
      React.createElement(FormSwitch, {
        label: "Broadcast as Muted",
        value: state.fakeMute,
        onValueChange: (value: boolean) => { state.fakeMute = value; },
      }),
      React.createElement(FormSwitch, {
        label: "Broadcast as Deafened",
        value: state.fakeDeafen,
        onValueChange: (value: boolean) => { state.fakeDeafen = value; },
      }),
    );
  },
});
