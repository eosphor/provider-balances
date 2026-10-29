"""Provider Balances — dashboard backend for the desktop status-bar plugin.

Mounted at ``/api/plugins/provider-balances/`` by the dashboard plugin system:

    GET /balances -> {"providers": [...]}

Each row follows the desktop plugin's contract (see its plugin.js header): the
four core fields (id/display/status/detail) are always present, and
``remaining_percent`` / ``resets_at`` only when the provider actually reported
them. Honesty rules are respected in both directions: a quota window becomes a
percentage, a credit balance stays an amount, and a provider that cannot be read
is reported as ``error`` with the reason — never as a made-up number.

Where the numbers come from:

* ``agent.account_usage.fetch_account_usage(read_only=True)`` — Hermes's
  account-usage code for Anthropic and Codex. Hermes may still refresh an
  expiring Codex credential while resolving it.
* DeepSeek and OpenRouter credit checks use their fixed official HTTPS
  endpoints and profile-scoped secrets, without following redirects.

Each request collects fresh data in the request's profile scope. No shared
cross-profile cache is used.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Optional

from fastapi import APIRouter

log = logging.getLogger(__name__)

router = APIRouter()

_HTTP_TIMEOUT_SECONDS = 10.0

# Popover order: quota windows first (they can run out), then money balances.
WINDOW_PROVIDERS: tuple[tuple[str, str], ...] = (
    ("anthropic", "Anthropic"),
    ("openai-codex", "OpenAI Codex"),
)
DEEPSEEK_LABEL = "DeepSeek"

# --- row builders ------------------------------------------------------------

def _slug(text: str) -> str:
    return "".join(ch if ch.isalnum() else "-" for ch in text.lower()).strip("-")


def _row(
    row_id: str,
    display: str,
    *,
    status: str = "ok",
    detail: str = "",
    remaining_percent: Optional[float] = None,
    resets_at: Optional[str] = None,
) -> dict[str, Any]:
    """One provider row, with optional fields only present when they are real."""
    row: dict[str, Any] = {
        "id": row_id,
        "display": display,
        "status": status,
        "detail": detail,
    }
    if remaining_percent is not None:
        row["remaining_percent"] = max(0.0, min(100.0, float(remaining_percent)))
    if resets_at:
        row["resets_at"] = resets_at
    return row


def _window_rows(slug: str, display: str, snapshot: Any) -> list[dict[str, Any]]:
    """One row per reported quota window: the label is the detail line, the ring is what is left."""
    rows: list[dict[str, Any]] = []
    for window in getattr(snapshot, "windows", ()) or ():
        used = getattr(window, "used_percent", None)
        remaining = None if used is None else 100.0 - float(used)
        reset_at = getattr(window, "reset_at", None)
        rows.append(
            _row(
                f"{slug}:{_slug(str(getattr(window, 'label', '') or 'window'))}",
                display,
                detail=str(getattr(window, "label", "") or ""),
                remaining_percent=remaining,
                resets_at=reset_at.isoformat() if reset_at else None,
            )
        )
    return rows


def _first_detail(snapshot: Any) -> str:
    """The amount an amount-only snapshot reported, with its label stripped ('Credits balance: $0.23' -> '$0.23')."""
    for line in getattr(snapshot, "details", ()) or ():
        text = str(line or "").strip()
        if not text:
            continue
        head, sep, tail = text.partition(": ")
        return tail.strip() if sep and tail.strip() else text
    return ""


def _provider_rows(slug: str, display: str) -> list[dict[str, Any]]:
    from agent.account_usage import fetch_account_usage

    snapshot = fetch_account_usage(slug, read_only=True)
    if snapshot is None:
        return []
    windows = _window_rows(slug, display, snapshot)
    if windows:
        return windows
    amount = _first_detail(snapshot)
    if amount:
        return [_row(slug, display, detail=amount)]
    reason = getattr(snapshot, "unavailable_reason", None) or "no balance reported"
    return [_row(slug, display, status="unavailable", detail=str(reason))]


def _openrouter_rows() -> list[dict[str, Any]]:
    """Read credits from OpenRouter's fixed official origin only."""
    import httpx
    from agent.secret_scope import get_secret

    token = str(get_secret("OPENROUTER_API_KEY") or "").strip()
    if not token:
        return []
    with httpx.Client(timeout=_HTTP_TIMEOUT_SECONDS, follow_redirects=False) as client:
        resp = client.get("https://openrouter.ai/api/v1/credits", headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
        resp.raise_for_status()
        data = resp.json().get("data") or {}
    total, used = data.get("total_credits"), data.get("total_usage")
    if (not isinstance(total, (int, float)) or isinstance(total, bool) or
            not isinstance(used, (int, float)) or isinstance(used, bool)):
        return [_row("openrouter", "OpenRouter", status="unavailable", detail="no balance reported")]
    import math
    if not math.isfinite(total) or not math.isfinite(used):
        return [_row("openrouter", "OpenRouter", status="unavailable", detail="no balance reported")]
    return [_row("openrouter", "OpenRouter", detail=f"${max(0.0, total - used):.2f}")]


def _deepseek_rows() -> list[dict[str, Any]]:
    """DeepSeek's own balance endpoint — money, not a quota, so no percentage is derived."""
    import httpx
    from agent.secret_scope import get_secret

    token = str(get_secret("DEEPSEEK_API_KEY") or "").strip()
    if not token:
        return []
    with httpx.Client(timeout=_HTTP_TIMEOUT_SECONDS, follow_redirects=False) as client:
        resp = client.get("https://api.deepseek.com/user/balance", headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
        resp.raise_for_status()
        payload = resp.json() or {}
    infos = [i for i in (payload.get("balance_infos") or []) if isinstance(i, dict)]
    # Prefer the currency that actually holds money; DeepSeek reports all of them.
    infos.sort(key=lambda i: abs(float(i.get("total_balance") or 0.0)), reverse=True)
    if not infos:
        return [_row("deepseek", DEEPSEEK_LABEL, status="unavailable", detail="no balance reported")]
    info = infos[0]
    amount = str(info.get("total_balance") or "").strip()
    currency = str(info.get("currency") or "").strip()
    detail = f"{amount} {currency} left".strip() if amount else "no balance reported"
    status = "ok" if payload.get("is_available", True) else "unavailable"
    return [_row("deepseek", DEEPSEEK_LABEL, status=status, detail=detail)]


# --- collection --------------------------------------------------------------

def _collect() -> list[dict[str, Any]]:
    """Every connected provider, one row per quota window or one amount row. Never raises."""
    rows: list[dict[str, Any]] = []
    for slug, display in WINDOW_PROVIDERS:
        try:
            rows.extend(_provider_rows(slug, display))
        except Exception:
            log.debug("provider-balances: %s unavailable", slug)
            rows.append(_row(slug, display, status="unavailable", detail="could not be read"))
    for slug, label, builder in (("deepseek", DEEPSEEK_LABEL, _deepseek_rows), ("openrouter", "OpenRouter", _openrouter_rows)):
        try:
            rows.extend(builder())
        except Exception:
            log.debug("provider-balances: %s unavailable", slug)
            rows.append(_row(slug, label, status="unavailable", detail="could not be read"))
    return rows


@router.get("/balances")
async def balances() -> dict[str, Any]:
    """Remaining quota/credits per connected provider, for the desktop status-bar plugin."""
    import asyncio

    rows = await asyncio.to_thread(_collect)
    return {"providers": rows, "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
