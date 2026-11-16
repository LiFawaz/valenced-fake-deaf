# Fake Deafen Detector (Valenced)

## Version 1.0.2

- Includes your own account in detection instead of excluding it.
- Adds a self-test that compares Discord's server-reported `self_deaf` state with the local client's deafen state.
- If the server says your account is deafened while the local client reports that it is not deafened for longer than the confirmation delay, the plugin records a high-confidence local/server mismatch and displays a notification.
- Continues monitoring other members in your current voice channel. A remote member is flagged when Discord reports a speaking event while their `self_deaf` state is active.
- The settings screen displays the self-test status and keeps a local detection history with display name, @username, user ID, evidence type, count, and last-seen time.

## What the self-test can establish

The self-test can detect a mismatch between the state Discord receives for your account and the local deafen state reported by the current Valenced client. This is especially useful for testing a Fake Deafen implementation that changes the outgoing/server `self_deaf` state without changing the local deafen state.

A persistent mismatch is strong evidence that the reported status does not match the local client state. It does not prove what audio physically reached your speakers or ears.

## Limits for other participants

Valenced can observe server voice states and speaking notifications for other members, but it cannot directly inspect another person's local audio output or private client state. Remote detection therefore requires a speaking notification while the member is server-marked as self-deafened. A method that suppresses speaking notifications or does not transmit microphone activity may not be detectable from your client.

## Install and test

Download the installable ZIP from the latest successful run of the GitHub Actions workflow. Install the inner plugin ZIP in Valenced through **Advanced → Install from file**.

For the self-test, join a voice channel, turn on your Fake Deafen setup, and watch the **Self-test** line in plugin settings. A successful build verifies packaging and compilation only; the behavior still needs to be confirmed in a live voice channel.
