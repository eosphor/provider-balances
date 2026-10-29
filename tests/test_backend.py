import asyncio
import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('provider_balances_api', Path(__file__).resolve().parents[1] / 'dashboard' / 'plugin_api.py')
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


def test_threshold_precision_is_preserved():
    row = api._row('codex:session', 'Codex', remaining_percent=4.96)
    assert row['remaining_percent'] == 4.96


def test_window_percentage_and_reset():
    window = SimpleNamespace(label='Current session', used_percent=25.0, reset_at=None)
    row = api._window_rows('anthropic', 'Anthropic', SimpleNamespace(windows=[window]))[0]
    assert row['id'] == 'anthropic:current-session'
    assert row['remaining_percent'] == 75.0


def test_openrouter_uses_only_official_origin(monkeypatch):
    import agent.secret_scope
    import httpx
    observed = {}
    class Client:
        def __init__(self, **kwargs): observed.update(kwargs)
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def get(self, url, headers):
            observed['url'] = url
            return SimpleNamespace(raise_for_status=lambda: None, json=lambda: {'data': {'total_credits': 10, 'total_usage': 4}})
    monkeypatch.setattr(agent.secret_scope, 'get_secret', lambda name: 'test-key')
    monkeypatch.setattr(httpx, 'Client', Client)
    assert api._openrouter_rows()[0]['detail'] == '$6.00'
    assert observed['url'] == 'https://openrouter.ai/api/v1/credits'
    assert observed['follow_redirects'] is False


def test_deepseek_uses_only_the_official_origin_and_no_redirects(monkeypatch):
    import agent.secret_scope
    import httpx
    observed = {}
    class Client:
        def __init__(self, **kwargs): observed.update(kwargs)
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def get(self, url, headers):
            observed['url'] = url
            return SimpleNamespace(raise_for_status=lambda: None, json=lambda: {'is_available': True, 'balance_infos': [{'currency': 'USD', 'total_balance': '2.00'}]})
    monkeypatch.setattr(agent.secret_scope, 'get_secret', lambda name: 'test-key')
    monkeypatch.setattr(httpx, 'Client', Client)
    assert api._deepseek_rows()[0]['detail'] == '2.00 USD left'
    assert observed['url'] == 'https://api.deepseek.com/user/balance'
    assert observed['follow_redirects'] is False


def test_each_request_collects_fresh_without_cross_profile_cache(monkeypatch):
    calls = []
    monkeypatch.setattr(api, '_collect', lambda: calls.append(len(calls)) or [{'id': str(len(calls))}])
    first = asyncio.run(api.balances())
    second = asyncio.run(api.balances())
    assert first['providers'] != second['providers']
    assert len(calls) == 2
