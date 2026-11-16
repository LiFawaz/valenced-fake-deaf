# Fake Deafen Detector (Valenced)

Experimental Valenced plugin that watches for one specific mismatch: Discord's voice state says a participant is self-deafened, but Discord also reports that the same participant started speaking in the same voice channel.

## Version 1.0.1

- Detection toast displays the member's display name and @username.
- Settings include a local list of detected accounts, user IDs, evidence counts, and last-seen times.
- Speaking events are checked against the current VoiceStateStore state and your current voice channel.
- A short stability delay reduces false positives caused by event ordering.

## Important limitation

The signal is strong evidence of a voice-state/speaking mismatch, not absolute proof that the person actually heard audio on their device. Discord's speaking signal is a voice-gateway speaking-state notification; this plugin does not receive another participant's private audio output or inspect their device.

The plugin therefore says **Possible Fake Deafen** instead of making a guaranteed accusation. It cannot detect every fake-deafen method, especially methods that suppress speaking events or do not transmit microphone activity.

## Install

Download the installable ZIP from the latest successful run of the GitHub Actions workflow. Install the inner plugin ZIP in Valenced through **Advanced → Install from file**.

A successful build verifies packaging and compilation only. It does not replace testing inside a live voice channel.
