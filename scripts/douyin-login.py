"""Interactive local setup. Never pass a Douyin cookie as a command argument."""

import argparse
import getpass
import json
import os
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ORIGIN = "http://127.0.0.1:8000"
DIRECTORY = Path(__file__).resolve().parents[1] / ".cache" / "provider"
SETTINGS = DIRECTORY / "douyin-login.json"
SCOPES = {"douyin:read", "identity:manage"}


class Stop(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise Stop("本机服务重定向，已停止。")


def request(opener, path, key, body=None):
    req = urllib.request.Request(
        ORIGIN + "/api/v1/" + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", "X-API-Key": key},
    )
    try:
        with opener.open(req, timeout=15) as response:
            payload = json.loads(response.read(512_000))
    except urllib.error.HTTPError as error:
        raise Stop(
            f"本机服务拒绝请求（HTTP {error.code}），请检查专用密钥和录入内容。"
        ) from None
    if payload.get("success") is not True:
        raise Stop("本机服务未确认操作。")
    return payload["data"]


def read_key():
    try:
        fd = os.open(SETTINGS, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return getpass.getpass(
            "本机服务专用 API key（douyin:read 和 identity:manage，输入隐藏）："
        ).strip()
    with os.fdopen(fd) as f:
        st = os.fstat(f.fileno())
        if (
            not stat.S_ISREG(st.st_mode)
            or st.st_uid != os.getuid()
            or st.st_mode & 0o077
            or st.st_size > 1024
        ):
            raise Stop("请检查本机登录文件的所有者与权限（0600）。")
        return json.load(f)["apiKey"]


def store(settings):
    with tempfile.NamedTemporaryFile(mode="w", dir=DIRECTORY, delete=False) as out:
        path = out.name
        try:
            json.dump(settings, out)
            out.flush()
            os.replace(path, SETTINGS)
        finally:
            Path(path).unlink(missing_ok=True)


def take_cookie(clipboard):
    if not clipboard:
        return getpass.getpass("douyin.com 的 Cookie（输入隐藏，粘贴后回车）：").strip()
    if sys.platform != "darwin":
        raise Stop("--clipboard 仅支持 Mac。")
    input(
        "现在复制 www.douyin.com 请求的 Cookie 值，回到此处只按回车，允许本次读取剪贴板（Ctrl+C 取消）："
    )
    data = subprocess.run(
        ["/usr/bin/pbpaste"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        timeout=5,
        check=True,
    ).stdout
    value = data.decode("utf-8").strip()
    if not value or "\n" in value or "\r" in value or ";" not in value:
        raise Stop(
            "剪贴板中不是单行 Cookie 值。请在请求标头中仅复制 Cookie 的值，然后重试。"
        )
    return value


def main(clipboard=False):
    if not sys.stdin.isatty() or not sys.stderr.isatty():
        raise Stop(
            "需要你本人在本机终端运行 media-lens douyin-login；不要在对话里输入 Cookie。"
        )
    DIRECTORY.mkdir(mode=0o700, parents=True, exist_ok=True)
    st = DIRECTORY.lstat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077:
        raise Stop("本机配置目录须由当前用户持有且权限为 0700。")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    key = read_key()
    me = request(opener, "auth/me", key)["user"]
    if (
        set(me["scopes"]) != SCOPES
        or me["via"] != "api_key"
        or me["role"] not in ("owner", "admin", "operator")
    ):
        raise Stop(
            "需要本机 operator 或更高角色的专用 key，仅授予 douyin:read 和 identity:manage。"
        )
    print("请在自己的浏览器登录 https://www.douyin.com 。在开发者工具 → 网络中刷新，")
    print("点 www.douyin.com 主文档，从请求标头分别复制 User-Agent 和 Cookie 的值。")
    print(
        "Cookie 只从这个终端发送到本机服务；输入时不回显。请勿粘贴到聊天或命令行参数。"
    )
    agent = input("User-Agent：").strip().removeprefix("User-Agent:").strip()
    if agent.lower().startswith("user-agent:"):
        agent = agent.partition(":")[2].strip()
    if not agent.startswith("Mozilla/") or len(agent) > 1024:
        raise Stop("请复制请求标头中的完整 User-Agent 值。")
    cookies = take_cookie(clipboard)
    if not cookies or len(cookies) > 100_000:
        raise Stop("未收到有效的 Cookie。")
    # Check the paste locally before sending it even to the loopback import preview.
    header = (
        cookies.partition(":")[2].strip()
        if cookies.lower().startswith("cookie:")
        else cookies
    )
    names = {part.partition("=")[0].strip().lower() for part in header.split(";")}
    if "ttwid" not in names or not names.intersection(
        {"sessionid", "sessionid_ss", "sid_tt"}
    ):
        raise Stop(
            "未检测到登录后的完整抖音 Cookie；没有发送。请复制主文档的 Cookie 值。"
        )
    body = {
        "platform": "douyin",
        "cookies": cookies,
        "user_agent": agent,
        "reserved": True,
        "note": "AgentMediaLens: local profile login",
    }
    preview = request(
        opener, "admin/identities/import", key, {**body, "dry_run": True}
    )["report"]
    names = set(preview["cookie_names"])
    if (
        preview["usable"] is not True
        or preview["authenticated"] is not True
        or preview.get("detected_platform") not in ("douyin", None)
        or not names.intersection({"sessionid", "sessionid_ss", "sid_tt"})
        or not {name.lower() for name in names}.intersection(
            {"uifid", "uifid_temp", "uifidtemp"}
        )
    ):
        raise Stop(
            "没有确认到完整的抖音登录态和访客标识。请确认已登录，从 www.douyin.com 主文档复制完整的 Cookie。"
        )
    result = request(opener, "admin/identities/import", key, {**body, "dry_run": False})
    if result["stored"] is not True or result["report"]["authenticated"] is not True:
        raise Stop("服务未确认保留的登录身份。")
    identity = str(uuid.UUID(result["identity_id"]))
    store(
        {
            "apiKey": key,
            "identityId": identity,
            "expiresAt": result["report"].get("expires_at"),
        }
    )
    print("本机登录已配置。后续查询无需打开浏览器；可关闭登录页并回到对话。")


if __name__ == "__main__":
    try:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument("--clipboard", action="store_true")
        main(parser.parse_args().clipboard)
    except Stop as exc:
        sys.exit(str(exc))
    except (KeyboardInterrupt, EOFError):
        sys.exit("已取消。")
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        sys.exit("本机服务或配置不可用。请检查本机服务、凭证和文件权限。")
