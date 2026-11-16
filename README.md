# Fake Mute / Fake Deafen Detector (Valenced)

## Version 1.0.4

This build replaces the previous local-state check with the active default RTC media connection and suppresses detection while voice is joining or reconnecting.

### Self-test: own account

The detector compares the server-reported flags from `VoiceStateStore.getVoiceStateForUser()` with the actual connected default RTC connection from `MediaEngineStore.getMediaEngine().connections`.

The local values come from the RTC connection's `getSelfMute()` and `getSelfDeaf()` methods (with the connection's boolean fields as a fallback). The detector only judges a state when the connection belongs to the current account, has context `default`, is not destroyed, and reports `connectionState === "CONNECTED"`.

After an RTC connection first becomes connected, the detector waits three seconds for Discord's join state to settle. A mismatch must then persist for another 1.6 seconds before it records an alert. This avoids treating the brief state disagreement during connection startup as Fake Mute or Fake Deafen.

It reports these cases independently:
- Fake Mute: server says muted, active local RTC connection says unmuted.
- Fake Deafen: server says deafened, active local RTC connection says undeafened.
- Both: both mismatches remain present.

The settings page displays server mute/deafen, local RTC mute/deafen, RTC connection readiness, and the evidence used for each entry.

### Other members

The plugin listens to the documented `MediaEngine` `VoiceActivity` event. It flags a remote member only when an actual positive activity signal is observed while Discord's server voice state marks that member as self-muted or self-deafened in the same voice channel.

It cannot inspect a remote user's private RTC connection. A fake status that does not transmit detectable voice activity cannot be proven from another participant's client.

### Test steps

Install the latest 1.0.4 ZIP, join a voice channel, and open the detector settings. Wait until the self-test shows an RTC connection in the `CONNECTED` state.

Test Fake Mute alone, Fake Deafen alone, and then both. For each test, the server flag should become ON while the local RTC flag stays OFF; the corresponding alert should appear after the confirmation period. Disable the fake setting and verify that the server and local RTC flags return to agreement.

A successful build confirms compilation and packaging only. It does not replace testing inside a live Valenced voice channel. If the status keeps saying it is waiting for a connected default RTC connection, this Valenced build does not expose the required local RTC connection to this plugin and the detector will intentionally avoid false accusations.
