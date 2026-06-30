"""Launch the Douyin Downloader desktop GUI application."""

import sys
from pathlib import Path

# Ensure project root is on sys.path so all imports work.
_project_root = Path(__file__).resolve().parent
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))

from desktop.app import main

if __name__ == "__main__":
    main()
