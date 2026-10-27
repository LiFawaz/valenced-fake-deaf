/// <reference types="@valenced/types" />

/**
 * Fake-deaf — Valenced port scaffold.
 *
 * The legacy plugin rewrote outgoing voice-gateway mute/deafen flags so other
 * people could see a false state while audio remained live. This port does
 * not reproduce that deception or patch the voice gateway. A supported,
 * transparent local-only status utility can be added once the relevant API
 * is verified.
 */
export default plugin({
  start() {
    console.log("[fake-deaf] loaded; voice-gateway spoofing is intentionally disabled");
  },

  stop() {
    console.log("[fake-deaf] stopped");
  },
});
