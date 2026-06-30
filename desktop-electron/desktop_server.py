"""Desktop server: FastAPI backend + static frontend + browser launcher.

Starts the API server, serves the web UI, and opens the default browser.
No Electron needed — just Python + a browser.
"""

from __future__ import annotations

import asyncio
import sys
import threading
import webbrowser
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

# Ensure project root is importable
_project_root = Path(__file__).resolve().parent.parent
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))

from config import ConfigLoader
from server.app import build_app

HOST = "127.0.0.1"
PORT = 18080
RENDERER_DIR = Path(__file__).resolve().parent / "renderer"


def create_full_app() -> FastAPI:
    """Build FastAPI app with API routes + static UI."""
    # Backend API
    config_path = _project_root / "config.yml"
    if config_path.exists():
        config = ConfigLoader(str(config_path))
    else:
        config = ConfigLoader(None)

    config.update(path="./Downloaded/")
    config.update(thread=5)
    config.update(database=True)

    api_app = build_app(config)

    # Mount renderer directory for CSS/JS (before index route)
    api_app.mount("/static", StaticFiles(directory=str(RENDERER_DIR)), name="static")

    @api_app.get("/")
    async def index():
        return FileResponse(RENDERER_DIR / "index.html")

    return api_app


def open_browser():
    """Open browser after a short delay to let the server start."""
    import time

    time.sleep(1.5)
    webbrowser.open(f"http://{HOST}:{PORT}")


def main():
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=HOST)
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    app = create_full_app()

    if not args.no_browser:
        threading.Thread(target=open_browser, daemon=True).start()

    print(f"\n  Douyin Downloader Desktop\n")
    print(f"  Server: http://{args.host}:{args.port}")
    print(f"  按 Ctrl+C 退出\n")

    config = uvicorn.Config(app, host=args.host, port=args.port, log_level="warning")
    server = uvicorn.Server(config)
    asyncio.run(server.serve())


if __name__ == "__main__":
    main()
