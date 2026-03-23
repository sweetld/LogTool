#!/usr/bin/env python3
"""Local UI for browsing Claude/Codex session JSONL/NDJSON logs."""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import subprocess
import sys
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT_DIR = Path(__file__).resolve().parent
DEFAULT_LOG_DIR = ROOT_DIR / "log"
DEFAULT_UI_DIR = ROOT_DIR / "viewer"
STATE_FILE = ROOT_DIR / ".session_viewer_state.json"
SUPPORTED_LOG_SUFFIXES = {".jsonl", ".ndjson"}
MODEL_LANES = ("model_a", "model_b")
CLAUDE_PROJECTS_DIR = Path.home() / ".claude" / "projects"


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


def resolve_existing_directory(path_input: str) -> Path:
    requested = Path(path_input.strip()).expanduser()
    try:
        resolved = requested.resolve()
    except OSError as exc:
        raise ValueError(f"Invalid directory path: {exc}") from exc

    if not resolved.exists():
        raise FileNotFoundError(f"Directory not found: {resolved}")
    if not resolved.is_dir():
        raise NotADirectoryError(f"Path is not a directory: {resolved}")
    return resolved


def pick_log_dir_with_native_dialog(initial_dir: Path) -> Path | None:
    picker_script = """
import json
import sys
from pathlib import Path

try:
    import tkinter as tk
    from tkinter import filedialog
except Exception as exc:
    print(json.dumps({"error": f"Native directory picker unavailable: {exc}"}))
    raise SystemExit(2)

initial_dir = sys.argv[1] if len(sys.argv) > 1 else str(Path.home())
root = tk.Tk()
root.withdraw()
try:
    root.attributes("-topmost", True)
except Exception:
    pass
root.update()
selected = filedialog.askdirectory(
    initialdir=initial_dir,
    mustexist=True,
    title="Select Session Log Root",
)
root.destroy()
print(json.dumps({"path": selected or None}))
"""
    try:
        result = subprocess.run(
            [sys.executable, "-c", picker_script, str(initial_dir)],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError as exc:
        raise RuntimeError(f"Failed to open native directory picker: {exc}") from exc

    stdout = result.stdout.strip()
    stderr = result.stderr.strip()
    payload: dict = {}
    if stdout:
        try:
            payload = json.loads(stdout)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                f"Native directory picker returned invalid output: {stdout}"
            ) from exc

    if result.returncode != 0:
        message = payload.get("error") if isinstance(payload, dict) else None
        raise RuntimeError(message or stderr or "Native directory picker failed")

    selected_path = payload.get("path") if isinstance(payload, dict) else None
    if not selected_path:
        return None
    return resolve_existing_directory(str(selected_path))


def posix_path(path: Path) -> str:
    return path.as_posix()


def encode_server_file_id(source_kind: str, lane: str | None, path: Path) -> str:
    raw = json.dumps(
        {
            "source_kind": source_kind,
            "lane": lane,
            "path": str(path.resolve()),
        },
        sort_keys=True,
    )
    return base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii").rstrip("=")


def make_file_entry(
    path: Path,
    *,
    display_name: str,
    source_kind: str,
    source_label: str,
    lane: str | None,
    auto_load: bool = False,
) -> dict | None:
    try:
        stat = path.stat()
    except OSError:
        return None

    return {
        "id": encode_server_file_id(source_kind, lane, path),
        "name": display_name,
        "size_bytes": stat.st_size,
        "modified_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        "source_kind": source_kind,
        "source_label": source_label,
        "lane": lane,
        "auto_load": auto_load,
        "_mtime": stat.st_mtime,
        "_path": path,
    }


def is_supported_log_file(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in SUPPORTED_LOG_SUFFIXES


def is_excluded_log_path(path: Path) -> bool:
    lowered_parts = {part.lower() for part in path.parts}
    stem = path.stem.lower()
    return (
        stem.endswith("_raw")
        or "original_sessions" in lowered_parts
        or "subagents" in lowered_parts
        or "memory" in lowered_parts
    )


def sanitize_claude_project_dir(cwd: Path) -> str:
    text = str(cwd.resolve())
    return text.replace("\\", "-").replace("/", "-").replace(":", "")


def resolve_experiment_root_and_lanes(selected_dir: Path) -> tuple[Path, list[str]] | None:
    resolved = selected_dir.resolve()

    if resolved.name in MODEL_LANES:
        if resolved.parent.name == "logs":
            return resolved.parent.parent, [resolved.name]
        return resolved.parent, [resolved.name]

    if resolved.name == "logs":
        root = resolved.parent
        lanes = [lane for lane in MODEL_LANES if (resolved / lane).is_dir() or (root / lane).is_dir()]
        return (root, lanes) if lanes else None

    lanes = [lane for lane in MODEL_LANES if (resolved / lane).is_dir() or (resolved / "logs" / lane).is_dir()]
    return (resolved, lanes) if lanes else None


def iter_processed_logs(experiment_root: Path, lane: str) -> list[dict]:
    lane_dir = experiment_root / "logs" / lane
    if not lane_dir.is_dir():
        return []

    entries = []
    for path in sorted(lane_dir.rglob("*")):
        if not is_supported_log_file(path) or is_excluded_log_path(path):
            continue
        rel = path.relative_to(experiment_root)
        entry = make_file_entry(
            path,
            display_name=posix_path(rel),
            source_kind="processed",
            source_label="Processed log",
            lane=lane,
        )
        if entry:
            entries.append(entry)
    return entries


def iter_live_claude_logs(experiment_root: Path, lane: str) -> list[dict]:
    model_dir = experiment_root / lane
    if not model_dir.is_dir() or not CLAUDE_PROJECTS_DIR.is_dir():
        return []

    project_dir = CLAUDE_PROJECTS_DIR / sanitize_claude_project_dir(model_dir)
    if not project_dir.is_dir():
        return []

    candidates: list[Path] = []
    for path in project_dir.glob("*.jsonl"):
        if is_supported_log_file(path) and not is_excluded_log_path(path):
            candidates.append(path)

    for path in project_dir.glob("*/*.jsonl"):
        if is_supported_log_file(path) and not is_excluded_log_path(path):
            candidates.append(path)

    unique_candidates = sorted({candidate.resolve() for candidate in candidates})
    entries = []
    for path in unique_candidates:
        if path.parent.name == "subagents":
            continue
        suffix = posix_path(path.relative_to(project_dir).parent)
        display_name = f"live/{lane}/{path.name}" if suffix == "." else f"live/{lane}/{suffix}/{path.name}"
        entry = make_file_entry(
            path,
            display_name=display_name,
            source_kind="live",
            source_label="Live Claude transcript",
            lane=lane,
        )
        if entry:
            entries.append(entry)
    return entries


def iter_direct_logs(log_dir: Path) -> list[dict]:
    if not log_dir.is_dir():
        return []

    entries = []
    for path in sorted(log_dir.iterdir()):
        if not is_supported_log_file(path) or is_excluded_log_path(path):
            continue
        entry = make_file_entry(
            path,
            display_name=path.name,
            source_kind="direct",
            source_label="Directory log",
            lane=None,
            auto_load=True,
        )
        if entry:
            entries.append(entry)
    return entries


def finalize_file_entries(entries: list[dict], *, experiment_mode: bool) -> list[dict]:
    if experiment_mode:
        by_lane: dict[str, list[dict]] = {lane: [] for lane in MODEL_LANES}
        for entry in entries:
            lane = entry.get("lane")
            if lane in by_lane:
                by_lane[lane].append(entry)

        for lane_entries in by_lane.values():
            lane_entries.sort(
                key=lambda item: (
                    0 if item["source_kind"] == "processed" else 1,
                    -item["_mtime"],
                    item["name"],
                )
            )
            if lane_entries:
                lane_entries[0]["auto_load"] = True

        entries.sort(
            key=lambda item: (
                MODEL_LANES.index(item["lane"]) if item.get("lane") in MODEL_LANES else len(MODEL_LANES),
                0 if item["source_kind"] == "processed" else 1,
                -item["_mtime"],
                item["name"],
            )
        )
    else:
        entries.sort(key=lambda item: (-item["_mtime"], item["name"]))

    cleaned = []
    for entry in entries:
        cleaned.append({k: v for k, v in entry.items() if not k.startswith("_")})
    return cleaned


def discover_available_logs(log_dir: Path) -> dict:
    experiment = resolve_experiment_root_and_lanes(log_dir)
    if experiment is None:
        return {
            "log_dir": str(log_dir),
            "root_dir": str(log_dir),
            "log_dir_display": str(log_dir),
            "discovery_mode": "direct",
            "files": finalize_file_entries(iter_direct_logs(log_dir), experiment_mode=False),
        }

    experiment_root, lanes = experiment
    entries: list[dict] = []
    for lane in lanes:
        entries.extend(iter_processed_logs(experiment_root, lane))
        entries.extend(iter_live_claude_logs(experiment_root, lane))

    if not entries:
        return {
            "log_dir": str(log_dir),
            "root_dir": str(experiment_root),
            "log_dir_display": f"{experiment_root} (no processed or live session logs found yet)",
            "discovery_mode": "experiment",
            "files": [],
        }

    return {
        "log_dir": str(log_dir),
        "root_dir": str(experiment_root),
        "log_dir_display": f"{experiment_root} (processed logs + live Claude transcripts)",
        "discovery_mode": "experiment",
        "files": finalize_file_entries(entries, experiment_mode=True),
    }


def build_server_file_index(log_dir: Path) -> dict[str, Path]:
    payload = discover_available_logs(log_dir)
    return {
        entry["id"]: Path(entry_path)
        for entry in payload["files"]
        for entry_path in [
            json.loads(
                base64.urlsafe_b64decode(entry["id"] + "=" * (-len(entry["id"]) % 4)).decode("utf-8")
            )["path"]
        ]
    }


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

        if parsed.path == "/api/pick-log-dir":
            self._handle_api_pick_log_dir()
            return

        if parsed.path == "/api/log-dir":
            self._handle_api_log_dir()
            return

        self.send_error(HTTPStatus.NOT_FOUND)

    def _handle_api_files(self) -> None:
        payload = discover_available_logs(type(self).log_dir)
        self._send_json(payload)

    def _handle_api_file(self, query: str) -> None:
        params = parse_qs(query)
        file_id = (params.get("id") or [None])[0]

        if not file_id:
            self._send_json({"error": "Missing required query parameter: id"}, 400)
            return

        file_index = build_server_file_index(type(self).log_dir)
        requested = file_index.get(file_id)
        if requested is None:
            self._send_json({"error": "File not found for requested id"}, 404)
            return

        if requested.suffix.lower() not in SUPPORTED_LOG_SUFFIXES:
            self._send_json({"error": "Only .jsonl and .ndjson files are supported"}, 400)
            return

        if not requested.exists() or not requested.is_file():
            self._send_json({"error": f"File not found: {requested.name}"}, 404)
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

    def _apply_log_dir(self, resolved: Path) -> dict:
        type(self).log_dir = resolved
        payload = discover_available_logs(resolved)
        try:
            write_persisted_log_dir(type(self).state_file, resolved)
        except OSError as exc:
            payload["warning"] = f"Failed to persist selected directory: {exc}"
        return payload

    def _handle_api_pick_log_dir(self) -> None:
        try:
            selected = pick_log_dir_with_native_dialog(type(self).log_dir)
        except RuntimeError as exc:
            self._send_json({"error": str(exc)}, 500)
            return

        if selected is None:
            self._send_json({"cancelled": True})
            return

        payload = self._apply_log_dir(selected)
        payload["cancelled"] = False
        self._send_json(payload)

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

        try:
            resolved = resolve_existing_directory(path_input)
        except FileNotFoundError as exc:
            self._send_json({"error": str(exc)}, 404)
            return
        except NotADirectoryError as exc:
            self._send_json({"error": str(exc)}, 400)
            return
        except ValueError as exc:
            self._send_json({"error": str(exc)}, 400)
            return

        payload = self._apply_log_dir(resolved)
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
        print(f"[{self.log_date_time_string()}] {self.address_string()} {format_str % args}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a local UI for inspecting session JSONL/NDJSON logs."
    )
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)")
    parser.add_argument("--port", default=8787, type=int, help="Bind port (default: 8787)")
    parser.add_argument(
        "--log-dir",
        default=str(DEFAULT_LOG_DIR),
        help=f"Directory containing JSONL/NDJSON session files or an experiment root (default: {DEFAULT_LOG_DIR})",
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
