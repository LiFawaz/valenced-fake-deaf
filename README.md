# Fake-deaf (Valenced)

A Valenced port of [LiFawaz/Fake-deaf](https://github.com/LiFawaz/Fake-deaf).

## What it does

- Adds a Fake Deafen Active switch in plugin settings.
- Lets you choose whether outgoing voice-state updates report you as muted and/or deafened.
- Leaves local microphone/audio processing unchanged; this changes the voice-state sent to Discord.
- Attempts to push the current voice state immediately when toggled while connected to voice.

## Install

Download the **installable ZIP** from the latest successful run of the GitHub Actions workflow in this repository. Use the artifact named `com.lifawaz.fake-deaf-installable-zip`, then install that ZIP through Valenced's **Advanced → Install from file**.

Do not download the whole Actions artifact ZIP and install it directly if it contains another ZIP inside; install the inner plugin ZIP with `manifest.json` at its root.

## Compatibility notes

This port uses Discord's internal module shapes to locate the gateway and voice stores, which can change between Discord/Valenced versions. A successful build confirms packaging, not live runtime compatibility. If the gateway socket or settings component cannot be found in your Valenced build, check the plugin logs and report the exact error.

## Source layout

- `plugins/com.lifawaz.fake-deaf/manifest.json` — Valenced manifest
- `plugins/com.lifawaz.fake-deaf/js/index.ts` — plugin implementation
