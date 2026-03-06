# Session Log Viewer

Local tool for viewing Claude/Codex JSONL session logs in an easy-to-read UI.

## What it supports

- Loads session files from `log/*.jsonl`
- Groups timeline by **human prompts**
- Automatically nests context-compaction prompts (\"continued from previous conversation\") under the prior turn
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

## Run

```bash
python3 session_viewer.py
```

Then open:

```text
http://127.0.0.1:8787
```

## Optional flags

```bash
python3 session_viewer.py --host 0.0.0.0 --port 8787 --log-dir ./log --ui-dir ./viewer
```
