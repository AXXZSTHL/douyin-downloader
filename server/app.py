"""FastAPI REST 服务入口。

HTTP 层薄封装：
- 接收 URL，创建 job，返回 job_id
- 实际下载委托给 cli.main.download_url 的简化复用

fastapi/uvicorn 是**可选**依赖。若未安装，导入本模块会 ImportError。
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any, Dict, List

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from auth import CookieManager
from config import ConfigLoader
from control import QueueManager, RateLimiter, RetryHandler
from core import DouyinAPIClient, DownloaderFactory, URLParser
from server.jobs import JobManager
from storage import FileManager
from utils.logger import setup_logger
from utils.validators import is_short_url, normalize_short_url

logger = setup_logger("REST")


def _extract_posts(items: list) -> list:
    """Extract post previews from raw aweme items."""
    posts = []
    for item in items:
        if not isinstance(item, dict):
            continue
        video = item.get("video") or {}
        cover = (video.get("cover") or {}).get("url_list") or item.get("cover") or []
        if isinstance(cover, list):
            cover = cover[0] if cover else ""
        posts.append({
            "aweme_id": str(item.get("aweme_id") or ""),
            "desc": str(item.get("desc") or "")[:80],
            "cover": str(cover or ""),
            "duration": int(video.get("duration") or 0) if isinstance(video, dict) else 0,
            "is_video": not bool(item.get("images")),
        })
    return posts


class SaveCookiesRequest(BaseModel):
    cookies: dict = {}

class DownloadRequest(BaseModel):
    url: str
    mode: str = "post"
    number: int = 0
    path: str = "./Downloaded/"
    thread: int = 5


class JobResponse(BaseModel):
    job_id: str
    status: str
    url: str


class _ServerDeps:
    """跨请求复用的重量级依赖。

    REST 服务在进程生命周期内只需要一份 FileManager / RateLimiter / RetryHandler /
    QueueManager / CookieManager；每个请求重新构造既浪费又会触发文件系统 mkdir。
    DouyinAPIClient 由于持有 aiohttp.ClientSession，依旧按请求创建，避免跨请求泄漏
    连接状态或触发 "Session is closed" 错误。
    """

    def __init__(self, config: ConfigLoader):
        self.config = config
        # Resolve the cookie file path relative to the config file's directory
        # so the sidecar can find it regardless of its working directory (which
        # on macOS is often '/' when launched by Electron).
        if config.config_path:
            from pathlib import Path

            cookie_file = str(Path(config.config_path).resolve().parent / ".cookies.json")
        else:
            cookie_file = ".cookies.json"
        self.cookie_manager = CookieManager(cookie_file=cookie_file)
        # Load cookies from the config (env var / YAML cookie key) first, then
        # fall back to whatever is already on disk in the cookie file. This
        # ensures that cookies saved by a previous session are picked up on
        # restart even when the config doesn't embed them inline.
        initial_cookies = config.get_cookies()
        if initial_cookies:
            self.cookie_manager.set_cookies(initial_cookies)
        else:
            # Trigger a load from disk so get_cookies() returns the persisted
            # session without requiring a fresh login on every app restart.
            self.cookie_manager.get_cookies()
        self.file_manager = FileManager(config.get("path"))
        self.rate_limiter = RateLimiter(max_per_second=float(config.get("rate_limit", 2) or 2))
        self.retry_handler = RetryHandler(max_retries=int(config.get("retry_times", 3) or 3))
        self.queue_manager = QueueManager(max_workers=int(config.get("thread", 5) or 5))


async def _execute_download(params: dict, deps: "_ServerDeps", job=None) -> Dict[str, int]:
    """简化版 download_url：只负责执行并返回成功/失败计数。"""
    url = params["url"]
    mode = params.get("mode", "post")
    number = params.get("number", 0)
    download_path = params.get("path", "./Downloaded/")
    thread = params.get("thread", 5)

    from config import ConfigLoader

    captured_items = []
    author_name = ""

    class _JobReporter:
        def update_step(self, step, detail=""): pass
        def set_item_total(self, total, detail=""):
            if job: job.total = total
        def advance_item(self, status, detail=""):
            if job:
                if status == "success": job.success += 1
                elif status == "failed": job.failed += 1
                elif status == "skipped": job.skipped += 1
            import re
            aweme_id = ""
            m = re.search(r'aweme[=_](\d+)', detail)
            if m: aweme_id = m.group(1)
            captured_items.append({
                "title": detail[:60], "aweme_id": aweme_id, "cover": "",
                "status": status, "duplicated": status == "skipped",
            })

    reporter = _JobReporter()

    async with DouyinAPIClient(deps.cookie_manager.get_cookies()) as api_client:
        if is_short_url(url):
            resolved = await api_client.resolve_short_url(normalize_short_url(url))
            if not resolved:
                raise RuntimeError(f"Failed to resolve short URL: {url}")
            url = resolved

        parsed = URLParser.parse(url)
        if not parsed:
            raise RuntimeError(f"Unsupported URL: {url}")

        runtime_cfg = ConfigLoader(None)
        cfg = deps.config.config.copy()
        cfg["path"] = download_path
        cfg["thread"] = thread
        cfg["mode"] = [mode]
        cfg["number"] = {mode: number}
        runtime_cfg.config = cfg

        fm = deps.file_manager if download_path == deps.config.get("path") \
            else FileManager(download_path)

        downloader = DownloaderFactory.create(
            parsed["type"],
            runtime_cfg,
            api_client,
            fm,
            deps.cookie_manager,
            None,
            deps.rate_limiter,
            deps.retry_handler,
            deps.queue_manager,
            progress_reporter=reporter,
        )
        if downloader is None:
            raise RuntimeError(f"No downloader for url_type={parsed['type']}")

        result = await downloader.download(parsed)

        # Try to get author name from user info
        if parsed.get("sec_uid"):
            try:
                info = await api_client.get_user_info(parsed["sec_uid"])
                if info: author_name = info.get("nickname", "")
            except Exception: pass

        return {
            "total": result.total,
            "success": result.success,
            "failed": result.failed,
            "skipped": result.skipped,
            "author_name": author_name,
            "save_path": str(download_path),
            "items": captured_items,
        }


def build_app(config: ConfigLoader) -> FastAPI:
    deps = _ServerDeps(config)

    async def executor(params: dict, job=None) -> Dict[str, int]:
        return await _execute_download(params, deps, job)

    server_cfg = config.get("server") or {}
    if not isinstance(server_cfg, dict):
        server_cfg = {}
    manager = JobManager(
        executor=executor,
        max_concurrency=int(config.get("thread", 2) or 2),
        max_jobs=int(server_cfg.get("max_jobs") or JobManager.DEFAULT_MAX_JOBS),
        job_ttl_seconds=float(
            server_cfg.get("job_ttl_seconds") or JobManager.DEFAULT_JOB_TTL_SECONDS
        ),
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield
        await manager.shutdown()

    app = FastAPI(
        title="Douyin Downloader API",
        version="1.0",
        description="REST API for dispatching Douyin download jobs.",
        lifespan=lifespan,
    )
    app.state.job_manager = manager
    app.state.deps = deps

    @app.post("/api/v1/save-cookies")
    async def save_cookies(req: SaveCookiesRequest) -> Dict[str, Any]:
        """Receive cookies from Electron login window."""
        import json
        from pathlib import Path
        from utils.cookie_utils import sanitize_cookies
        from tools.cookie_fetcher import update_config

        cookies = sanitize_cookies(req.cookies or {})
        if not cookies:
            return {"ok": False, "error": "空 Cookie"}
        # Save to file
        cp = Path("config/cookies.json")
        cp.parent.mkdir(parents=True, exist_ok=True)
        cp.write_text(json.dumps(cookies, ensure_ascii=False, indent=2), encoding="utf-8")
        # Update config.yml
        if deps.config.config_path:
            update_config(Path(deps.config.config_path), cookies)
        deps.cookie_manager.set_cookies(cookies)
        return {"ok": True, "count": len(cookies)}

    @app.get("/api/v1/health")
    async def health() -> Dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/v1/user")
    async def get_current_user() -> Dict[str, Any]:
        """Return logged-in user info from Douyin."""
        from core import DouyinAPIClient

        try:
            cookies = deps.cookie_manager.get_cookies()
            if not cookies:
                return {"ok": False, "error": "未找到 Cookie，请先登录"}
            async with DouyinAPIClient(cookies) as api:
                user = await api.get_self_info()
                if user:
                    # Extract avatar URL from various formats
                    avatar = user.get("avatar_larger") or user.get("avatar_medium") or user.get("avatar_thumb") or {}
                    if isinstance(avatar, dict):
                        urls = avatar.get("url_list") or []
                        avatar = urls[0] if urls else ""
                    return {
                        "ok": True,
                        "nickname": user.get("nickname", ""),
                        "sec_uid": user.get("sec_uid", ""),
                        "avatar": avatar,
                        "follower_count": user.get("follower_count", 0),
                        "following_count": user.get("following_count", 0),
                        "aweme_count": user.get("aweme_count", 0),
                    }
                return {"ok": False, "error": "API 未返回用户信息，Cookie 可能已过期"}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    @app.get("/api/v1/following")
    async def get_following(sec_uid: str = "", max_time: int = 0, count: int = 20) -> Dict[str, Any]:
        """Return the logged-in user's following list."""
        from core import DouyinAPIClient

        try:
            async with DouyinAPIClient(deps.cookie_manager.get_cookies()) as api:
                if not sec_uid:
                    user = await api.get_self_info()
                    if not user:
                        return {"ok": False, "error": "无法获取当前用户信息"}
                    sec_uid = user.get("sec_uid", "")

                page = await api.get_following_page(sec_uid, max_time=max_time, count=count)
                items = page.get("items") or page.get("followings") or []
                users = []
                for item in items:
                    # The following list embeds user info in different shapes
                    u = item.get("user") or item.get("following") or item
                    avatar = u.get("avatar_medium") or u.get("avatar_thumb") or {}
                    if isinstance(avatar, dict):
                        urls = avatar.get("url_list") or []
                        avatar = urls[0] if urls else ""
                    users.append({
                        "nickname": u.get("nickname", ""),
                        "sec_uid": u.get("sec_uid", ""),
                        "unique_id": u.get("unique_id") or u.get("short_id", ""),
                        "signature": str(u.get("signature") or "")[:60],
                        "avatar": avatar,
                        "follower_count": u.get("follower_count", 0),
                    })
                return {
                    "ok": True,
                    "users": users,
                    "has_more": bool(page.get("has_more")),
                    "min_time": int(page.get("min_time") or 0),
                }
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    @app.get("/api/v1/user/posts")
    async def get_user_posts(sec_uid: str = "", max_cursor: int = 0, count: int = 18) -> Dict[str, Any]:
        """Return a user's post list (aweme items) for preview/selection."""
        from core import DouyinAPIClient

        if not sec_uid:
            return {"ok": False, "error": "sec_uid is required"}
        try:
            async with DouyinAPIClient(deps.cookie_manager.get_cookies()) as api:
                data = await api.get_user_post(sec_uid, max_cursor=max_cursor, count=count)
                items = data.get("items") or data.get("aweme_list") or []
                return {
                    "ok": True,
                    "posts": _extract_posts(items),
                    "has_more": bool(data.get("has_more")),
                    "max_cursor": int(data.get("max_cursor") or 0),
                }
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    @app.get("/api/v1/resolve")
    async def resolve_link(url: str = "") -> Dict[str, Any]:
        """Resolve a Douyin short link and return the target info + video list."""
        from core import DouyinAPIClient, URLParser
        from utils.validators import is_short_url, normalize_short_url

        if not url:
            return {"ok": False, "error": "url is required"}
        try:
            async with DouyinAPIClient(deps.cookie_manager.get_cookies()) as api:
                # Resolve short link first
                resolved = url
                if is_short_url(url):
                    resolved = await api.resolve_short_url(normalize_short_url(url)) or url

                parsed = URLParser.parse(resolved)
                if not parsed:
                    return {"ok": False, "error": "无法解析链接: " + resolved}

                result = {"ok": True, "type": parsed["type"], "resolved": resolved}

                if parsed["type"] == "user" and parsed.get("sec_uid"):
                    user = await api.get_user_info(parsed["sec_uid"])
                    if user:
                        av = user.get("avatar_medium") or {}
                        if isinstance(av, dict):
                            av = (av.get("url_list") or [None])[0] or ""
                        result["user"] = {
                            "nickname": user.get("nickname", ""),
                            "sec_uid": user.get("sec_uid", ""),
                            "avatar": av,
                            "follower_count": user.get("follower_count", 0),
                            "aweme_count": user.get("aweme_count", 0),
                        }
                        # Also fetch first page of posts
                        posts_data = await api.get_user_post(parsed["sec_uid"], max_cursor=0, count=18)
                        items = posts_data.get("items") or posts_data.get("aweme_list") or []
                        posts = _extract_posts(items)
                        result["posts"] = posts
                        result["has_more"] = bool(posts_data.get("has_more"))
                        result["max_cursor"] = int(posts_data.get("max_cursor") or 0)
                elif parsed["type"] in ("video", "note"):
                    result["aweme_id"] = parsed.get("aweme_id", "")
                    result["note_id"] = parsed.get("note_id", "")

                return result
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    @app.get("/api/v1/hot-board")
    async def get_hot_board(limit: int = 15) -> Dict[str, Any]:
        """Fetch Douyin hot search board."""
        from core.discovery import dump_hot_board

        try:
            import tempfile
            from pathlib import Path

            async with DouyinAPIClient(deps.cookie_manager.get_cookies()) as api:
                tmp = Path(tempfile.gettempdir()) / "douyin_hot.jsonl"
                result = await dump_hot_board(api, tmp.parent, limit=max(1, min(50, limit)))
                return {"ok": True, "items": result.get("items", [])}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    @app.post("/api/v1/logout")
    async def logout() -> Dict[str, Any]:
        """Clear all cookies."""
        from pathlib import Path

        deps.cookie_manager.clear_cookies()
        # Also clear config cookies
        if deps.config.config_path:
            from tools.cookie_fetcher import update_config

            update_config(Path(deps.config.config_path), {})
        # Remove cookie file
        cookie_file = Path("config/cookies.json")
        if cookie_file.exists():
            cookie_file.unlink()
        return {"ok": True}

    @app.post("/api/v1/login")
    async def trigger_login() -> Dict[str, Any]:
        """Open browser, poll for login, auto-close, return cookies."""
        import json, asyncio
        from pathlib import Path
        from urllib.parse import parse_qs, urlparse

        cookies_path = Path(deps.config.config_path).resolve().parent / ".cookies.json" \
            if deps.config.config_path else Path("config/cookies.json")

        from tools.cookie_fetcher import (
            extract_ms_token_from_text, filter_cookies,
            goto_with_fallback, try_extract_ms_token, update_config,
        )
        from utils.cookie_utils import sanitize_cookies

        # Ensure Chromium is installed
        import subprocess, sys
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            return {"ok": False, "error": "请先安装: pip install playwright && python -m playwright install chromium"}

        # Auto-install Chromium if needed
        try:
            async with async_playwright() as p:
                await p.chromium.launch(headless=True).close()
        except Exception:
            logger.info("Chromium not found, auto-installing...")
            try:
                subprocess.run([sys.executable, "-m", "playwright", "install", "chromium"],
                               capture_output=True, timeout=300)
            except Exception:
                return {"ok": False, "error": "Chromium 安装失败，请手动运行: python -m playwright install chromium"}

        try:
            async with async_playwright() as p:
                browser = await p.chromium.launch(headless=False)
                context = await browser.new_context()
                page = await context.new_page()
                observed_headers = []
                observed_tokens = []

                def _on_req(request):
                    try:
                        h = request.headers or {}
                        ch = h.get("cookie")
                        if ch: observed_headers.append(ch)
                        q = parse_qs(urlparse(request.url or "").query)
                        if "msToken" in q and q["msToken"]:
                            observed_tokens.append((q["msToken"][0] or "").strip())
                        t = extract_ms_token_from_text(request.url or "")
                        if t: observed_tokens.append(t)
                    except Exception: pass

                page.on("request", _on_req)
                await goto_with_fallback(page, "https://www.douyin.com/")

                logged_in = False
                for _ in range(90):
                    await asyncio.sleep(2)
                    try:
                        st = await context.storage_state()
                        ck = {c["name"]: c["value"] for c in st["cookies"] if "douyin" in c.get("domain", "")}
                        # Check for login — need passport_csrf_token AND (sessionid OR sessionid_ss)
                        has_csrf = bool(ck.get("passport_csrf_token"))
                        has_session = bool(ck.get("sessionid") or ck.get("sessionid_ss"))
                        if has_csrf and has_session:
                            all_cookies = sanitize_cookies(ck)
                            ms = await try_extract_ms_token(page, all_cookies, observed_headers, observed_tokens)
                            if ms and not all_cookies.get("msToken"): all_cookies["msToken"] = ms
                            picked = filter_cookies(all_cookies)
                            picked = sanitize_cookies(picked)
                            cookies_path.parent.mkdir(parents=True, exist_ok=True)
                            cookies_path.write_text(json.dumps(picked, ensure_ascii=False, indent=2), encoding="utf-8")
                            if deps.config.config_path: update_config(Path(deps.config.config_path), picked)
                            deps.cookie_manager._load_cookies()
                            logged_in = True
                            break
                    except Exception: pass

                await context.close()
                await browser.close()

                if logged_in:
                    return {"ok": True, "cookie_count": len(picked)}
                return {"ok": False, "error": "登录超时，请在 3 分钟内扫码登录"}
        except Exception as exc:
            logger.exception("Login failed")
            return {"ok": False, "error": str(exc)}

    @app.post("/api/v1/download", response_model=JobResponse)
    async def create_job(req: DownloadRequest) -> JobResponse:
        if not req.url:
            raise HTTPException(status_code=400, detail="url is required")
        job = await manager.submit(req.url, mode=req.mode, number=req.number,
                                   path=req.path, thread=req.thread)
        return JobResponse(job_id=job.job_id, status=job.status, url=job.url)

    @app.get("/api/v1/jobs/{job_id}")
    async def get_job(job_id: str) -> Dict[str, Any]:
        job = await manager.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="job not found")
        return job.to_dict()

    @app.post("/api/v1/jobs/clear")
    async def clear_jobs() -> Dict[str, Any]:
        """Clear completed jobs."""
        await manager.clear_completed()
        return {"ok": True}

    @app.get("/api/v1/jobs")
    async def list_jobs() -> Dict[str, List[Dict[str, Any]]]:
        jobs = await manager.list_jobs()
        return {"jobs": [j.to_dict() for j in jobs]}

    return app


async def run_server(config: ConfigLoader, *, host: str, port: int) -> None:
    import uvicorn

    app = build_app(config)
    uv_config = uvicorn.Config(app, host=host, port=port, log_level="info")
    server = uvicorn.Server(uv_config)
    await server.serve()
