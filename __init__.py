"""Provider Balances — agent-plugin shell for a desktop-only feature.

The user-facing half is the desktop status-bar chip
(``$HERMES_HOME/desktop-plugins/provider-balances/plugin.js``); this package
exists so the chip's data route (``/api/plugins/provider-balances/balances``,
``dashboard/plugin_api.py``) gets discovered and mounted by the dashboard /
gateway, which only imports backends of installed *plugin packages*.

Deliberately registers nothing agent-side: no tools, hooks, slash commands.
"""

from __future__ import annotations


def register(ctx) -> None:  # noqa: ARG001 - nothing to register on purpose
    """No agent-side surface: the plugin is UI + one read-only HTTP route."""
