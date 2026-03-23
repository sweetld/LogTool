# Session Log Viewer

Local tool for viewing Claude/Codex JSONL session logs in an easy-to-read UI.

## What it supports

- Loads processed session files from `logs/model_a` and `logs/model_b`
- Can also discover live Claude Code transcripts for active sessions from `~/.claude/projects/...` when you point it at an experiment root that contains `model_a` and `model_b`
- Groups timeline by **human prompts**
- Automatically nests context-compaction prompts ("continued from previous conversation") under the prior turn
- Shows:
  - human prompt text
  - prompt-level **assistant file changes** (from Edit/Write tool calls)
  - changed-file drill-down with before/after code snippets
  - assistant responses
  - tool calls and matching tool results
  - assistant thinking blocks
  - session metadata and timestamps
- Global search across loaded session content
- Line-number toggle for code views
- Copy buttons for prompt text, event text, and raw JSON
- Multi-session tabs
- Side-by-side comparison mode with up to **two panes**
- Upload extra JSONL files directly from your machine
- Tolerates a partially written trailing line when reading an active live JSONL transcript

## Run

```bash
python3 session_viewer.py
```

Then open:

```text
http://127.0.0.1:8787
```

## Live Session Workflow

1. Start the viewer.
2. In the sidebar, click `Choose Root Directory...` and select the experiment root or its `logs` directory using the native folder picker.
3. The viewer will show:
   - processed logs from `logs/model_a` and `logs/model_b` when they exist
   - live Claude transcripts from `~/.claude/projects/...` for `model_a` and `model_b` when those sessions are still active
4. Click `Refresh Current Root` to rescan the filesystem and reload any already-open live server sessions.

## Optional flags

```bash
python3 session_viewer.py --host 0.0.0.0 --port 8787 --log-dir /path/to/experiment --ui-dir ./viewer
```

`--log-dir` can now point either to a directory of JSONL files, a `logs` directory, or the full experiment root containing `model_a`, `model_b`, and `logs`.
