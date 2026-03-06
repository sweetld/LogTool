#!/usr/bin/env python3
"""Local UI for browsing Claude/Codex session JSONL logs."""

from __future__ import annotations

import argparse
import json
import mimetypes
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT_DIR = Path(__file__).resolve().parent
DEFAULT_LOG_DIR = ROOT_DIR / "log"
DEFAULT_UI_DIR = ROOT_DIR / "viewer"
STATE_FILE = ROOT_DIR / ".session_viewer_state.json"


def read_persisted_log_dir(state_file: Path) -> Path | None:
    if not state_file.exists():
        return None

    try:
        payload = json.loads(state_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None

    path_text = payload.get("log_dir") if isinstance(payload, dict) else None
    if not isinstance(path_text, str) or not path_text.strip():
        return None

    candidate = Path(path_text.strip()).expanduser()
    try:
        resolved = candidate.resolve()
    except OSError:
        return None

    if not resolved.exists() or not resolved.is_dir():
        return None
    return resolved


def write_persisted_log_dir(state_file: Path, log_dir: Path) -> None:
    payload = {"log_dir": str(log_dir)}
    state_file.write_text(json.dumps(payload, indent=2), encoding="utf-8")


class SessionViewerHandler(BaseHTTPRequestHandler):
    log_dir = DEFAULT_LOG_DIR
    ui_dir = DEFAULT_UI_DIR
    state_file = STATE_FILE

    def do_GET(self) -> None:  # noqa: N802 - inherited API
        parsed = urlparse(self.path)

        if parsed.path == "/api/files":
            self._handle_api_files()
            return

        if parsed.path == "/api/file":
            self._handle_api_file(parsed.query)
            return

        self._handle_static(parsed.path)

    def do_POST(self) -> None:  # noqa: N802 - inherited API
        parsed = urlparse(self.path)

        if parsed.path == "/api/log-dir":
            self._handle_api_log_dir()
            return

        self.send_error(HTTPStatus.NOT_FOUND)

    def _handle_api_files(self) -> None:
        log_dir = type(self).log_dir
        files = []
        if log_dir.exists():
            for path in sorted(log_dir.glob("*.jsonl")):
                stat = path.stat()
                files.append(
                    {
                        "name": path.name,
                        "size_bytes": stat.st_size,
                        "modified_at": datetime.fromtimestamp(
                            stat.st_mtime, tz=timezone.utc
                        ).isoformat(),
                    }
                )

        self._send_json({"log_dir": str(log_dir), "files": files})

    def _handle_api_file(self, query: str) -> None:
        params = parse_qs(query)
        name = (params.get("name") or [None])[0]

        if not name:
            self._send_json({"error": "Missing required query parameter: name"}, 400)
            return

        if "/" in name or "\\" in name:
            self._send_json({"error": "Invalid file name"}, 400)
            return

        log_root = type(self).log_dir.resolve()
        requested = (log_root / name).resolve()

        if requested.parent != log_root:
            self._send_json({"error": "Invalid file path"}, 400)
            return

        if requested.suffix.lower() != ".jsonl":
            self._send_json({"error": "Only .jsonl files are supported"}, 400)
            return

        if not requested.exists() or not requested.is_file():
            self._send_json({"error": f"File not found: {name}"}, 404)
            return

        try:
            content = requested.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            self._send_json({"error": f"Failed to read file: {exc}"}, 500)
            return

        self._send_bytes(
            content.encode("utf-8"),
            content_type="text/plain; charset=utf-8",
            status=HTTPStatus.OK,
        )

    def _handle_api_log_dir(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0

        if length <= 0:
            self._send_json({"error": "Missing JSON payload"}, 400)
            return

        payload_raw = self.rfile.read(length)
        try:
            payload = json.loads(payload_raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json({"error": "Invalid JSON payload"}, 400)
            return

        path_input = payload.get("path") if isinstance(payload, dict) else None
        if not isinstance(path_input, str) or not path_input.strip():
            self._send_json({"error": "Missing required field: path"}, 400)
            return

        requested = Path(path_input.strip()).expanduser()
        try:
            resolved = requested.resolve()
        except OSError as exc:
            self._send_json({"error": f"Invalid directory path: {exc}"}, 400)
            return

        if not resolved.exists():
            self._send_json({"error": f"Directory not found: {resolved}"}, 404)
            return

        if not resolved.is_dir():
            self._send_json({"error": f"Path is not a directory: {resolved}"}, 400)
            return

        type(self).log_dir = resolved
        payload = {"log_dir": str(resolved)}
        try:
            write_persisted_log_dir(type(self).state_file, resolved)
        except OSError as exc:
            payload["warning"] = f"Failed to persist selected directory: {exc}"
        self._send_json(payload)

    def _handle_static(self, path: str) -> None:
        requested_path = "index.html" if path in {"", "/"} else path.lstrip("/")
        fs_path = (self.ui_dir / requested_path).resolve()
        ui_root = self.ui_dir.resolve()

        if fs_path.is_dir():
            fs_path = (fs_path / "index.html").resolve()

        if fs_path.parent != ui_root and ui_root not in fs_path.parents:
            self.send_error(HTTPStatus.FORBIDDEN)
            return

        if not fs_path.exists() or not fs_path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        try:
            data = fs_path.read_bytes()
        except OSError:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        content_type, _ = mimetypes.guess_type(str(fs_path))
        self._send_bytes(
            data,
            content_type=content_type or "application/octet-stream",
            status=HTTPStatus.OK,
        )

    def _send_json(self, payload: dict, status: int = 200) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send_bytes(encoded, "application/json; charset=utf-8", status)

    def _send_bytes(self, data: bytes, content_type: str, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format_str: str, *args) -> None:  # noqa: A003
        # Keep terminal output focused while still showing request basics.
        print(f"[{self.log_date_time_string()}] {self.address_string()} {format_str % args}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a local UI for inspecting session JSONL logs."
    )
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)")
    parser.add_argument("--port", default=8787, type=int, help="Bind port (default: 8787)")
    parser.add_argument(
        "--log-dir",
        default=str(DEFAULT_LOG_DIR),
        help=f"Directory containing JSONL session files (default: {DEFAULT_LOG_DIR})",
    )
    parser.add_argument(
        "--ui-dir",
        default=str(DEFAULT_UI_DIR),
        help=f"Directory containing frontend files (default: {DEFAULT_UI_DIR})",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    requested_log_dir = Path(args.log_dir).expanduser().resolve()
    persisted_log_dir = (
        read_persisted_log_dir(STATE_FILE)
        if args.log_dir == str(DEFAULT_LOG_DIR)
        else None
    )
    log_dir = persisted_log_dir or requested_log_dir
    ui_dir = Path(args.ui_dir).resolve()

    if not ui_dir.exists():
        raise SystemExit(f"UI directory not found: {ui_dir}")

    if not log_dir.exists():
        print(f"Warning: log directory does not exist yet: {log_dir}")

    SessionViewerHandler.log_dir = log_dir
    SessionViewerHandler.ui_dir = ui_dir
    SessionViewerHandler.state_file = STATE_FILE

    try:
        write_persisted_log_dir(STATE_FILE, log_dir)
    except OSError as exc:
        print(f"Warning: failed to persist initial log directory: {exc}")

    server = ThreadingHTTPServer((args.host, args.port), SessionViewerHandler)
    url = f"http://{args.host}:{args.port}"

    print("Session Log Viewer")
    print(f"Serving UI: {ui_dir}")
    print(f"Using logs:  {log_dir}")
    print(f"Open:        {url}")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
