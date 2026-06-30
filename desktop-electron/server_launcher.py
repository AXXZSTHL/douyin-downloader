"""Standalone server launcher for the Electron desktop app.

Does NOT require config.yml — uses in-memory defaults. Cookies are
loaded from config/cookies.json if present.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Ensure project root is importable
_project_root = Path(__file__).resolve().parent.parent
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))

import uvicorn
from config import ConfigLoader
from server.app import build_app

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18080)
    args = parser.parse_args()

    # Use config.yml if it exists, otherwise in-memory defaults
    config_path = _project_root / "config.yml"
    if config_path.exists():
        config = ConfigLoader(str(config_path))
    else:
        config = ConfigLoader(None)

    config.update(path="./Downloaded/")
    config.update(thread=5)
    config.update(database=True)

    app = build_app(config)
    uv_config = uvicorn.Config(app, host=args.host, port=args.port, log_level="info")
    server = uvicorn.Server(uv_config)
    import asyncio

    asyncio.run(server.serve())
