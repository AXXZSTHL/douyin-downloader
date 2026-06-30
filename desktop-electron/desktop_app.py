"""Native desktop window using pywebview + FastAPI backend.

Opens a real Windows/macOS/Linux window (not a browser tab),
starts the API server, and loads the web UI inside.
"""

from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

# Ensure project root is importable
_project_root = Path(__file__).resolve().parent.parent
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))


def start_server(host: str, port: int):
    """Start FastAPI server in a daemon thread."""
    import asyncio
    import uvicorn

    from desktop_server import create_full_app

    app = create_full_app()
    config = uvicorn.Config(app, host=host, port=port, log_level="warning")
    server = uvicorn.Server(config)

    # Run in this thread (it's already a daemon thread)
    asyncio.run(server.serve())


def main():
    HOST = "127.0.0.1"
    PORT = 18080

    # Kill any existing process on our port
    import socket

    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind((HOST, PORT))
        s.close()
    except OSError:
        print("检测到已有服务在运行，尝试复用...")

    # Start backend in background thread
    server_thread = threading.Thread(target=start_server, args=(HOST, PORT), daemon=True)
    server_thread.start()

    # Wait for server to be ready
    import urllib.request

    for _ in range(30):
        try:
            urllib.request.urlopen(f"http://{HOST}:{PORT}/api/v1/health", timeout=1)
            break
        except Exception:
            time.sleep(0.3)

    # Open native window
    import webview

    window = webview.create_window(
        title="Douyin Downloader — 抖音批量下载工具",
        url=f"http://{HOST}:{PORT}",
        width=960,
        height=720,
        min_size=(720, 540),
        text_select=True,
        confirm_close=False,
    )

    webview.start(debug=False)


if __name__ == "__main__":
    main()
