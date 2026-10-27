# Fake-deaf (Valenced)

A clean Valenced-format port project for LiFawaz's original Fake-deaf Revenge plugin.

## Status

This repository contains a Valenced-format manifest and a lifecycle scaffold. The old implementation monkey-patched outgoing voice-gateway payloads to make the client report a muted/deafened state while audio remained live. This project intentionally does not reproduce that deceptive behavior or spoof voice state.

A transparent local-only indicator or testing utility can be implemented after the supported Valenced APIs are verified.

## Source layout

- `plugins/com.lifawaz.fake-deaf/manifest.json` — Valenced plugin manifest
- `plugins/com.lifawaz.fake-deaf/js/index.ts` — JS entry point

## Build

This source is laid out for the official [Valenced plugin template](https://github.com/Valenced/valenced-plugin-template). Copy the plugin folder into that template, install its dependencies, and run its plugin build task. A packaged ZIP is not committed yet.
