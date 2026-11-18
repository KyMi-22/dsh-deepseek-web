# Security and privacy

`dsh-deepseek-web` connects DeepSeek Harness (DSH) to the consumer web product at
`chat.deepseek.com`. It is not an official DeepSeek integration.

## What is stored, and where

`$DSH_HOME/deepseek-web/state.json` (directory `0700`, file `0600` on POSIX) holds:

- the `chat.deepseek.com` user token;
- session bindings and the import ledger;
- quick-ask thread records, including compressed conversation excerpts and
  question/answer text kept for the panel transcript;
- the last sync report.

The plugin does not write conversation text to any other local file. If
`$DSH_HOME` is inside a cloud-sync folder (OneDrive, Dropbox, iCloud, …), all of
the above is synced. Set `DEEPSEEK_WEB_TOKEN` to avoid persisting the token;
the quick-ask transcript still lives in `state.json`.

A corrupt `state.json` is preserved as `state.json.corrupt-<timestamp>` rather
than silently discarded. That backup may contain the token.

## Network destinations

- `chat.deepseek.com` (or a configured HTTPS `baseUrl`): conversations,
  history, uploads, completions.
- `hif-leim.deepseek.com` / `hif-dliq.deepseek.com`: short-lived anti-abuse
  tokens. Only browser-shape headers are sent; no conversation content.
- `api.github.com`, `github.com`, GitHub asset hosts and an optional
  `updateProxy`: update checks and release downloads.

No telemetry is sent. `DEEPSEEK_WEB_TOKEN` overrides the stored token and is
never written by the plugin.

## What leaves the machine

Only the newest human message is sent as the prompt. DSH runtime context,
skill catalogs, approval notices and earlier DSH turns are filtered out.
Attachments are uploaded from the current message only. A host-projected file
handle contains a local read-only path; the plugin recovers the raw attachment
from the live session and replaces the handle with the user caption. If
recovery fails, the turn is refused rather than sending the path.

Quick ask sends a rule-compressed context (up to 12,000 characters) to a
separate web thread when the panel is first used.

## Tool boundary

The web completion endpoint has no function-calling channel, so a web-backed
conversation never invokes tools. As a second line of defence, a whitelist
denies direct write/shell/plugin tools. The whitelist still allows read and
interaction tools (`read`, `web_fetch`, `send_message`, …); it is not a
guarantee that a future combination cannot read data or delegate work. Do not
treat it as a sandbox.

## Account and service risk

The plugin automates a non-public web API. DeepSeek may change endpoints,
proof-of-work, device checks or risk rules at any time, and may rate-limit,
challenge or restrict an account. The plugin uses browser-shape headers,
short-lived HIF tokens and request pacing to reduce false positives, and it
does not attempt to bypass captchas. It cannot guarantee account safety. Use it
in line with DeepSeek's terms and avoid high-volume or batch automation.

## Self-update

Updates are downloaded only from allowlisted GitHub HTTPS hosts, capped at
100 MB, and must carry a SHA-256 digest that matches both the downloaded bytes
and the declared size. Assets without a digest are refused. Installation is
delegated to DSH's plugin manager; a failed install leaves the previous version
in place. Releases are unsigned beyond GitHub's transport and the published
digest.

## Reporting

Open an issue at <https://github.com/KyMi-22/dsh-deepseek-web/issues> with
reproduction steps and the plugin/DSH versions. Do not include a real token,
conversation content, or local paths in a report.
