import importlib.util
import json
from pathlib import Path
from unittest.mock import Mock

import pytest

spec = importlib.util.spec_from_file_location(
    "local_login", Path(__file__).resolve().parents[1] / "scripts" / "douyin-login.py"
)
assert spec and spec.loader
login = importlib.util.module_from_spec(spec)
spec.loader.exec_module(login)


@pytest.mark.parametrize("guest", [True, False])
def test_only_imports_reserved_logins_and_persists_no_platform_cookie(
    tmp_path, monkeypatch, guest
):
    fixture_cookie = "ttwid=a; sessionid=fixture-session; UIFID=b"
    monkeypatch.setattr(login, "DIRECTORY", tmp_path)
    monkeypatch.setattr(login, "SETTINGS", tmp_path / "config")
    monkeypatch.setattr(login, "read_key", lambda: "fixture-key")
    monkeypatch.setattr(login.sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr(login.sys.stderr, "isatty", lambda: True)
    monkeypatch.setattr("builtins.input", lambda _: "user-agent: Mozilla/5.0 fixture")
    monkeypatch.setattr(login, "take_cookie", lambda _: fixture_cookie)
    preview = {
        "usable": True,
        "authenticated": not guest,
        "cookie_names": ["ttwid", "sessionid", "UIFID"],
    }
    events = []

    def service(_opener, path, _key, body=None):
        if path == "auth/me":
            return {
                "user": {
                    "role": "operator",
                    "via": "api_key",
                    "scopes": list(login.SCOPES),
                }
            }
        assert path == "admin/identities/import" and body["reserved"] is True
        assert body["user_agent"] == "Mozilla/5.0 fixture"
        events.append(body["dry_run"])
        return {
            "report": preview,
            "stored": not body["dry_run"],
            "identity_id": "00000000-0000-4000-8000-000000000001",
        }

    monkeypatch.setattr(login, "request", service)
    if guest:
        with pytest.raises(login.Stop):
            login.main()
        assert not login.SETTINGS.exists() and events == [True]
    else:
        login.main()
        assert events == [True, False]
        assert json.loads(login.SETTINGS.read_text())["apiKey"] == "fixture-key"
        assert "fixture-session" not in login.SETTINGS.read_text()
        assert login.SETTINGS.stat().st_mode & 0o777 == 0o600


def test_mac_clipboard_is_read_once_only_after_confirmation(monkeypatch):
    monkeypatch.setattr(login.sys, "platform", "darwin")
    read = Mock(return_value=Mock(stdout=b"ttwid=a; sessionid=fixture"))
    monkeypatch.setattr(login.subprocess, "run", read)

    def cancel(_):
        raise KeyboardInterrupt()

    monkeypatch.setattr("builtins.input", cancel)
    with pytest.raises(KeyboardInterrupt):
        login.take_cookie(True)
    read.assert_not_called()
    monkeypatch.setattr("builtins.input", lambda _: "")
    assert login.take_cookie(True).startswith("ttwid=")
    assert read.call_count == 1 and read.call_args.args[0] == ["/usr/bin/pbpaste"]
