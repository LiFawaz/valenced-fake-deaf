# Fake Mute / Fake Deafen Detector (Valenced)

## Version 1.0.3

This experimental build checks Fake Mute and Fake Deafen separately and together.

### Self-test

For your own account, the plugin compares the server-reported state from `VoiceStateStore.getVoiceStateForUser()` with the local media state from `MediaEngineStore.isSelfMute()` and `MediaEngineStore.isSelfDeaf()`.

It can report:
- Fake Mute: server says muted, local media engine says not muted.
- Fake Deafen: server says deafened, local media engine says not deafened.
- Both: both mismatches remain present for the confirmation period.

The settings page shows the four live values (server mute, local mute, server deafen, local deafen) so missing store access or an unavailable getter is visible instead of silently failing.

### Other members

For other members, the plugin can only observe Discord's server voice state and speaking notifications. It flags a speaking notification if that member is marked self-muted or self-deafened. This can catch a member who is actively transmitting speech while appearing muted/deafened.

It cannot inspect another person's local media engine. A remote user who is fake-deafened but never transmits speaking activity, or a fake status that suppresses speaking notifications, cannot be proven fake from your client alone.

### Test steps

1. Install the ZIP from the latest successful build artifact.
2. Join a voice channel and open this plugin's settings.
3. Turn on Fake Mute only. After the short confirmation delay, expect the server/local mute values to disagree and a Fake Mute notification.
4. Turn Fake Mute off, then test Fake Deafen only.
5. Finally enable both and expect both pairs to disagree.
6. Turn the fake switches off and verify that the four values match again.

A successful build confirms compilation and packaging, not a live Discord test. If any of the four values shows `unavailable`, the settings page will identify which side failed to expose a state value.
