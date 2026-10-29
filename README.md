# Provider Balances for Hermes Desktop

A status-bar plugin for Hermes Desktop showing the active session provider's remaining session allowance, or a monetary credit balance when a percentage is not available.

**Author and maintainer:** Monviso ([eosphor](https://github.com/eosphor)).

## Features

- Shows the active session provider in the status bar, with its current-session allowance when reported.
- Marks a known current-session remainder below 5% in red; exactly 5% does not trigger the warning.
- A popover lists the provider windows and available credit balances, including weekly windows.
- Displays money as an amount without inventing a percentage. When a session quota is unknown, it does not substitute a weekly quota.
- English and Russian interface labels.

## Installation

Requires Hermes Desktop and a compatible local Hermes gateway. Install the plugin package from this repository:

```sh
hermes plugins install eosphor/provider-balances
hermes plugins enable provider-balances
```

In Hermes Desktop, enable **Provider Balances** under **Capabilities → Plugins** if the desktop component is disabled. If needed, run **Reload desktop plugins** from the command palette. Both the Python backend and desktop UI must be enabled.

This project is a community plugin, not an official Hermes component. Catalog admission is subject to review.

## Providers and limitations

- **OpenAI Codex** and **Anthropic:** supported account-usage windows depend on Hermes and the available provider credentials.
- **OpenRouter:** credit amount from its official credits API.
- **DeepSeek:** account balance amount.

Availability depends on the credentials and endpoints supported by Hermes. Not every provider, subscription, account or quota window is supported. The status indicator follows the focused session's resolved provider when its selected model can be verified; otherwise it displays a dash rather than another provider's balance. Multi-connection and multi-profile routing has not yet been validated in all configurations. Amount-only balances cannot trigger a percentage-based low-balance warning.

Data is refreshed periodically and may be stale. Percentages are remaining allowance, not spending or token usage; they may not reflect all restrictions on an account. A 5-hour provider usage window is not necessarily the usage of an individual Hermes chat.

## Privacy and network access

The backend uses Hermes's `agent.account_usage.fetch_account_usage` for Codex and Anthropic. Those Hermes helpers resolve credentials and contact provider usage APIs. In the current Hermes implementation, Anthropic credential resolution may consult Claude Code's credential file or macOS Keychain and the usage request identifies as Claude Code. Codex's helper uses a read-only usage path, but Hermes may still refresh an expiring credential during resolution. DeepSeek and OpenRouter API keys are read via Hermes's profile-scoped secret API and sent only to their fixed official HTTPS balance endpoints, with redirects disabled. The backend exposes reported balances via Hermes's authenticated plugin API and the desktop displays them.

The plugin does not intentionally collect analytics or telemetry, persist credentials, or launch shell commands or background processes. Its polling performs provider network requests. Hermes may persist its own usage cache and resolve credentials through its own mechanisms. **Catalog compliance of Hermes's Anthropic helper behavior is not yet confirmed**; consult the current catalog policy before submitting or approving this integration. API credentials must never be committed, displayed or logged.

## Development

```sh
hermes plugins validate .
hermes plugins doctor .
```

The UI is plain ESM and uses the Hermes desktop plugin SDK. The Python backend is mounted under `/api/plugins/provider-balances/`. Provider APIs and Hermes internals can change; this plugin is provided without warranty.

## License

MIT — see [LICENSE](LICENSE).
