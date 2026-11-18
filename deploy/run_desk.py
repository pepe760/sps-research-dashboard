"""Launch the managed desk with Massive's API key from systemd credentials."""
import os
from pathlib import Path
import sys


def main():
    try:
        key_path = Path(os.environ["CREDENTIALS_DIRECTORY"]) / "massive-api-key"
        key = key_path.read_text(encoding="ascii").strip()
        if not 1 <= len(key) <= 4096 or not all(33 <= ord(char) <= 126 for char in key):
            raise ValueError("invalid credential")
    except (KeyError, OSError, UnicodeError, ValueError):
        raise SystemExit("Missing or invalid Massive service credential") from None
    os.environ["SPS_MASSIVE_API_KEY"] = key
    app = Path(__file__).resolve().parents[1] / "scripts" / "serve_desk.py"
    os.execv(sys.executable, [sys.executable, "-B", "-u", str(app), *sys.argv[1:]])


if __name__ == "__main__":
    main()
