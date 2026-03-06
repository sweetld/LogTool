const state = {
  logDir: "",
  serverLogDir: "",
  serverFiles: [],
  fileListMode: "server",
  localFiles: [],
  currentDirectoryHandle: null,
  sessions: new Map(),
  sessionOrder: [],
  activeSessionId: null,
  compareMode: false,
  leftSessionId: null,
  rightSessionId: null,
  searchQuery: "",
  searchQueryRaw: "",
  searchHitNodes: [],
  activeSearchHitIndex: -1,
  lastSearchQueryRaw: "",
  showLineNumbers: false,
  syncCompareScroll: false,
  syncDiffScroll: false,
  activeFileTabByTurn: {},
  turnOpenByKey: {},
};

const PATH_REGEX =
  /(?:\.{1,2}\/)?(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+|(?:\/[A-Za-z0-9._-]+)+\.[A-Za-z0-9_-]+/g;

const dom = {
  logDirPath: document.getElementById("logDirPath"),
  chooseDirButton: document.getElementById("chooseDirButton"),
  directoryInput: document.getElementById("directoryInput"),
  serverFiles: document.getElementById("serverFiles"),
  refreshButton: document.getElementById("refreshButton"),
  uploadInput: document.getElementById("uploadInput"),
  searchInput: document.getElementById("searchInput"),
  searchHits: document.getElementById("searchHits"),
  searchHitCount: document.getElementById("searchHitCount"),
  searchPrevButton: document.getElementById("searchPrevButton"),
  searchNextButton: document.getElementById("searchNextButton"),
  lineNumbersToggle: document.getElementById("lineNumbersToggle"),
  syncDiffToggle: document.getElementById("syncDiffToggle"),
  compareButton: document.getElementById("compareButton"),
  tabs: document.getElementById("tabs"),
  compareControls: document.getElementById("compareControls"),
  leftSelect: document.getElementById("leftSelect"),
  rightSelect: document.getElementById("rightSelect"),
  compareSyncToggle: document.getElementById("compareSyncToggle"),
  content: document.getElementById("content"),
};

window.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  initialize();
});

function bindEvents() {
  dom.refreshButton.addEventListener("click", async () => {
    await refreshServerFiles();
  });

  if (dom.chooseDirButton && dom.directoryInput) {
    dom.chooseDirButton.addEventListener("click", async () => {
      try {
        const usedNativePicker = await pickDirectoryWithNativePicker();
        if (!usedNativePicker) {
          dom.directoryInput.value = "";
          dom.directoryInput.click();
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        showMessage(
          `Failed to open directory picker: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
    dom.directoryInput.addEventListener("change", async event => {
      const input = event.currentTarget;
      if (!(input instanceof HTMLInputElement) || !input.files) {
        return;
      }
      try {
        const selectedFiles = [...input.files];
        const entries = selectedFiles.map(file => ({
          file,
          relativePath: String(file.webkitRelativePath || file.name),
        }));
        const top = entries
          .map(entry => entry.relativePath.split("/")[0])
          .filter(Boolean)[0];
        state.currentDirectoryHandle = null;
        await loadSelectedLocalDirectory(entries, top || "Selected directory");
      } catch (error) {
        showMessage(
          `Failed to load selected directory: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        input.value = "";
      }
    });
  }

  dom.uploadInput.addEventListener("change", async event => {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement) || !input.files) {
      return;
    }
    try {
      const files = [...input.files];
      for (const file of files) {
        const text = await file.text();
        const sessionId = `upload:${file.name}:${file.lastModified}`;
        const parsed = parseSession(sessionId, file.name, text, "upload");
        upsertSession(parsed, { activate: true });
      }

      renderAll();
    } catch (error) {
      showMessage(
        `Failed to load selected file(s): ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      input.value = "";
    }
  });

  dom.searchInput.addEventListener("input", event => {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) {
      return;
    }
    state.activeSearchHitIndex = -1;
    state.searchQueryRaw = input.value.trim();
    state.searchQuery = state.searchQueryRaw.toLowerCase();
    renderContent();
  });

  if (dom.searchPrevButton) {
    dom.searchPrevButton.addEventListener("click", () => {
      goToSearchHit(-1);
    });
  }

  if (dom.searchNextButton) {
    dom.searchNextButton.addEventListener("click", () => {
      goToSearchHit(1);
    });
  }

  if (dom.lineNumbersToggle) {
    dom.lineNumbersToggle.addEventListener("change", event => {
      const input = event.currentTarget;
      if (!(input instanceof HTMLInputElement)) {
        return;
      }
      state.showLineNumbers = input.checked;
      renderContent();
    });
  }

  if (dom.syncDiffToggle) {
    dom.syncDiffToggle.addEventListener("change", event => {
      const input = event.currentTarget;
      if (!(input instanceof HTMLInputElement)) {
        return;
      }
      state.syncDiffScroll = input.checked;
      renderContent();
    });
    dom.syncDiffToggle.checked = state.syncDiffScroll;
  }

  dom.compareButton.addEventListener("click", () => {
    state.compareMode = !state.compareMode;
    if (!state.compareMode) {
      state.leftSessionId = null;
      state.rightSessionId = null;
    }
    renderAll();
  });

  dom.leftSelect.addEventListener("change", event => {
    const select = event.currentTarget;
    if (!(select instanceof HTMLSelectElement)) {
      return;
    }
    state.leftSessionId = select.value || null;
    renderContent();
  });

  dom.rightSelect.addEventListener("change", event => {
    const select = event.currentTarget;
    if (!(select instanceof HTMLSelectElement)) {
      return;
    }
    state.rightSessionId = select.value || null;
    renderContent();
  });

  if (dom.compareSyncToggle) {
    dom.compareSyncToggle.addEventListener("change", event => {
      const input = event.currentTarget;
      if (!(input instanceof HTMLInputElement)) {
        return;
      }
      state.syncCompareScroll = input.checked;
      renderContent();
    });
  }
}

async function initialize() {
  await refreshServerFiles();

  for (const file of state.serverFiles) {
    await loadServerFile(file.name, { activate: state.activeSessionId == null });
  }

  renderAll();
}

async function refreshServerFiles() {
  try {
    const response = await fetch("/api/files", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    state.serverLogDir = payload.log_dir || "";
    state.serverFiles = Array.isArray(payload.files) ? payload.files : [];
    if (state.fileListMode === "server") {
      state.logDir = state.serverLogDir;
    }
  } catch (error) {
    showMessage(
      `Failed to read log directory listing: ${error instanceof Error ? error.message : String(error)}`,
    );
    state.serverFiles = [];
  }

  renderServerFiles();
}

async function pickDirectoryWithNativePicker() {
  if (typeof window.showDirectoryPicker !== "function") {
    return false;
  }

  const pickerOptions = {
    id: "logtool-directory",
    mode: "read",
  };
  if (state.currentDirectoryHandle) {
    pickerOptions.startIn = state.currentDirectoryHandle;
  }

  const handle = await window.showDirectoryPicker(pickerOptions);
  state.currentDirectoryHandle = handle;

  const entries = await collectFilesFromDirectoryHandle(handle);
  await loadSelectedLocalDirectory(entries, handle.name || "Selected directory");
  return true;
}

async function collectFilesFromDirectoryHandle(directoryHandle) {
  const out = [];

  const logsHandle = await getChildDirectory(directoryHandle, "logs");
  if (!logsHandle) {
    return out;
  }

  for (const modelName of ["model_a", "model_b"]) {
    const modelHandle = await getChildDirectory(logsHandle, modelName);
    if (!modelHandle) {
      continue;
    }
    const nested = await collectFilesRecursively(modelHandle, `logs/${modelName}`);
    out.push(...nested);
  }

  return out;
}

async function getChildDirectory(parentHandle, name) {
  try {
    return await parentHandle.getDirectoryHandle(name);
  } catch (_error) {
    return null;
  }
}

async function collectFilesRecursively(directoryHandle, basePath) {
  const out = [];
  for await (const [name, entry] of directoryHandle.entries()) {
    const relativePath = `${basePath}/${name}`;
    if (entry.kind === "directory") {
      if (name.toLowerCase() === "original_sessions") {
        continue;
      }
      const nested = await collectFilesRecursively(entry, relativePath);
      out.push(...nested);
      continue;
    }

    if (entry.kind === "file") {
      const file = await entry.getFile();
      out.push({ file, relativePath });
    }
  }
  return out;
}

function applyLocalDirectorySelection(fileEntries, directoryLabel = "Selected directory") {
  const localFiles = fileEntries
    .filter(entry => isEligibleLogFilePath(entry.relativePath))
    .map(entry => {
      const file = entry.file;
      const relativePath = normalizeLogRelativePath(entry.relativePath || file.name);
      return {
        source: "local",
        name: relativePath,
        file,
        size_bytes: file.size || 0,
        modified_at: new Date(file.lastModified || Date.now()).toISOString(),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  state.fileListMode = "local";
  state.localFiles = localFiles;
  state.logDir = `Local selection: ${directoryLabel}`;
}

function isEligibleLogFilePath(relativePath) {
  const normalized = normalizeLogRelativePath(relativePath).toLowerCase();
  if (!normalized.endsWith(".jsonl")) {
    return false;
  }

  const fileName = normalized.split("/").pop() || "";
  const fileStem = fileName.slice(0, -".jsonl".length);
  if (fileStem.endsWith("_raw")) {
    return false;
  }

  if (normalized.includes("/original_sessions/")) {
    return false;
  }

  return normalized.startsWith("logs/model_a/") || normalized.startsWith("logs/model_b/");
}

function normalizeLogRelativePath(relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);

  for (let i = 0; i < parts.length - 2; i += 1) {
    const head = parts[i].toLowerCase();
    const model = parts[i + 1].toLowerCase();
    if (head === "logs" && (model === "model_a" || model === "model_b")) {
      return parts.slice(i).join("/");
    }
  }

  return parts.join("/");
}

async function loadSelectedLocalDirectory(fileEntries, directoryLabel = "Selected directory") {
  applyLocalDirectorySelection(fileEntries, directoryLabel);
  resetLoadedSessions();

  for (const file of state.localFiles) {
    await loadLocalFile(file, { activate: state.activeSessionId == null });
  }

  renderAll();
}

function resetLoadedSessions() {
  state.sessions.clear();
  state.sessionOrder = [];
  state.activeSessionId = null;
  state.compareMode = false;
  state.leftSessionId = null;
  state.rightSessionId = null;
  state.activeFileTabByTurn = {};
  state.turnOpenByKey = {};
}

function getDisplayedFiles() {
  if (state.fileListMode === "local") {
    return state.localFiles;
  }
  return state.serverFiles.map(file => ({ ...file, source: "server" }));
}

function renderServerFiles() {
  dom.logDirPath.textContent = state.logDir || "-";
  dom.serverFiles.innerHTML = "";
  const displayedFiles = getDisplayedFiles();

  if (displayedFiles.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent =
      state.fileListMode === "local"
        ? "No JSONL files found in selected local directory."
        : "No JSONL files found in log directory.";
    dom.serverFiles.appendChild(empty);
    return;
  }

  for (const file of displayedFiles) {
    const row = document.createElement("div");
    row.className = "file-row";

    const name = document.createElement("div");
    name.className = "file-name";
    name.textContent = file.name;

    const meta = document.createElement("div");
    meta.className = "file-meta";
    meta.textContent = `${formatBytes(file.size_bytes)}  |  ${formatTimestamp(file.modified_at)}`;

    const actions = document.createElement("div");
    actions.className = "file-actions";

    const loadButton = document.createElement("button");
    const sessionId =
      file.source === "local" ? localSessionId(file.name, file.file?.lastModified || 0) : serverSessionId(file.name);
    const loaded = state.sessions.has(sessionId);
    loadButton.textContent = loaded ? "Reload" : "Load";
    loadButton.addEventListener("click", async () => {
      await withButtonProgress(loadButton, async () => {
        if (file.source === "local") {
          await loadLocalFile(file, { activate: true });
        } else {
          await loadServerFile(file.name, { activate: true });
        }
        renderAll();
      });
    });

    actions.appendChild(loadButton);

    if (loaded) {
      const status = document.createElement("span");
      status.className = "badge";
      status.textContent = "Loaded";
      actions.appendChild(status);
    }

    row.append(name, meta, actions);
    dom.serverFiles.appendChild(row);
  }
}

async function loadLocalFile(entry, options = { activate: false }) {
  const sourceFile = entry?.file;
  if (!(sourceFile instanceof File)) {
    throw new Error("Selected local file is no longer available. Choose the directory again.");
  }

  const content = await sourceFile.text();
  const id = localSessionId(entry.name, sourceFile.lastModified || 0);
  const parsed = parseSession(id, entry.name, content, "local");
  upsertSession(parsed, options);
}

async function loadServerFile(name, options = { activate: false }) {
  const response = await fetch(`/api/file?name=${encodeURIComponent(name)}`, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Unable to load ${name}: HTTP ${response.status}`);
  }

  const content = await response.text();
  const parsed = parseSession(serverSessionId(name), name, content, "server");
  upsertSession(parsed, options);
}

function upsertSession(session, options = { activate: false }) {
  state.sessions.set(session.id, session);
  if (!state.sessionOrder.includes(session.id)) {
    state.sessionOrder.push(session.id);
  }

  if (options.activate || state.activeSessionId == null) {
    state.activeSessionId = session.id;
  }

  if (state.leftSessionId == null) {
    state.leftSessionId = session.id;
  }

  if (state.rightSessionId == null && state.sessionOrder.length > 1) {
    const other = state.sessionOrder.find(id => id !== state.leftSessionId) || null;
    state.rightSessionId = other;
  }
}

function parseSession(id, name, content, source) {
  const lines = content.split(/\r?\n/);
  const events = [];
  const parseErrors = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }

    try {
      const raw = JSON.parse(line);
      events.push(normalizeEvent(raw, index + 1));
    } catch (error) {
      parseErrors.push({
        line: index + 1,
        error: error instanceof Error ? error.message : String(error),
        sample: line.slice(0, 300),
      });
    }
  }

  annotateToolResultNames(events);
  const turnBuild = buildTurns(events);
  const turns = turnBuild.turns;
  const meta = buildSessionMeta(name, events, turns);

  return {
    id,
    name,
    source,
    events,
    turns,
    flowItems: turnBuild.flowItems,
    detachedPrompts: turnBuild.detachedPrompts,
    parseErrors,
    meta,
  };
}

function normalizeEvent(raw, lineNumber) {
  const base = {
    lineNumber,
    timestamp: raw.timestamp || null,
    type: raw.type || "unknown",
    raw,
    kind: "unknown",
    summary: raw.type || "unknown",
    preview: "",
  };

  if (raw.type === "user") {
    const content = raw?.message?.content;

    if (typeof content === "string") {
      const text = content;
      const promptClass = classifyPromptClass(raw, text);
      return {
        ...base,
        kind: "user_prompt",
        summary: "Human Prompt",
        preview: truncate(oneLine(text), 180),
        text,
        promptClass,
        searchBlob: collectSearchBlob(raw),
      };
    }

    const toolResults = Array.isArray(content)
      ? content
          .filter(item => item && typeof item === "object")
          .map(item => ({
            type: item.type || "tool_result",
            toolUseId: item.tool_use_id || null,
            content: item.content,
            isError: Boolean(item.is_error),
            toolName: null,
          }))
      : [];

    const preview = toolResults.length
      ? truncate(
          oneLine(
            toolResults
              .map(result => {
                const text = flattenValue(result.content);
                return text;
              })
              .join("\n"),
          ),
          180,
        )
      : "Tool result";

    return {
      ...base,
      kind: "user_tool_result",
      summary: "Tool Result",
      preview,
      toolResults,
      searchBlob: collectSearchBlob(raw),
    };
  }

  if (raw.type === "assistant") {
    const blocks = Array.isArray(raw?.message?.content) ? raw.message.content : [];
    const textBlocks = blocks.filter(block => block?.type === "text");
    const toolUses = blocks.filter(block => block?.type === "tool_use");

    const preview = textBlocks.length
      ? truncate(oneLine(textBlocks.map(block => block.text || "").join("\n")), 180)
      : toolUses.length
        ? `Tool calls: ${toolUses.map(tool => tool.name).join(", ")}`
        : "Assistant event";

    return {
      ...base,
      kind: "assistant_message",
      summary: "Assistant",
      preview,
      blocks,
      textBlocks,
      toolUses,
      messageId: raw?.message?.id || null,
      searchBlob: collectSearchBlob(raw),
    };
  }

  if (raw.type === "assistant_thinking") {
    const thinking = raw.thinking_content || "";
    return {
      ...base,
      kind: "assistant_thinking",
      summary: "Assistant Thinking",
      preview: truncate(oneLine(thinking), 180),
      thinking,
      searchBlob: collectSearchBlob(raw),
    };
  }

  if (raw.type === "session_start") {
    return {
      ...base,
      kind: "session_meta",
      summary: "Session Start",
      preview: raw.session_id || "",
      searchBlob: collectSearchBlob(raw),
    };
  }

  if (raw.type === "session_summary") {
    return {
      ...base,
      kind: "session_meta",
      summary: "Session Summary",
      preview: raw?.summary_data?.validation?.complete
        ? "Validation: complete"
        : "Summary entry",
      searchBlob: collectSearchBlob(raw),
    };
  }

  if (raw.type === "session_end") {
    return {
      ...base,
      kind: "session_meta",
      summary: "Session End",
      preview: raw.reason || "",
      searchBlob: collectSearchBlob(raw),
    };
  }

  return {
    ...base,
    summary: raw.type || "Unknown",
    preview: truncate(oneLine(flattenValue(raw)), 180),
    searchBlob: collectSearchBlob(raw),
  };
}

function classifyPromptClass(raw, text) {
  const normalized = oneLine(text).toLowerCase();

  if (normalized.includes("<local-command-stdout>")) {
    return "hidden";
  }

  if (
    normalized.includes("<command-name>/exit</command-name>") &&
    normalized.includes("<command-message>exit</command-message>")
  ) {
    return "info";
  }

  if (raw?.isMeta === true) {
    if (normalized.startsWith("stop hook feedback:")) {
      return "error";
    }
    return "meta";
  }

  if (
    normalized.includes("this session is being continued from a previous conversation") &&
    normalized.includes("ran out of context")
  ) {
    return "continuation";
  }

  if (normalized.startsWith("stop hook feedback:")) {
    return "error";
  }

  if (normalized.startsWith("implement the following plan:")) {
    return "meta";
  }

  if (
    normalized.includes("if you need specific details from before exiting plan mode") ||
    normalized.includes("if you need specific details from before compaction")
  ) {
    return "meta";
  }

  if (normalized.includes("please continue the conversation from where we left off")) {
    return "meta";
  }

  return "human";
}

function annotateToolResultNames(events) {
  const toolUseNames = new Map();

  for (const event of events) {
    if (event.kind === "assistant_message") {
      for (const block of event.toolUses) {
        if (block?.id) {
          toolUseNames.set(block.id, block.name || "UnknownTool");
        }
      }
      continue;
    }

    if (event.kind === "user_tool_result") {
      for (const result of event.toolResults) {
        if (result.toolUseId && toolUseNames.has(result.toolUseId)) {
          result.toolName = toolUseNames.get(result.toolUseId);
        }
      }
    }
  }
}

function buildTurns(events) {
  const turns = [];
  let currentTurn = null;
  const detachedPrompts = [];
  const infoItems = [];
  const flowItems = [];

  const preamble = {
    id: "setup",
    index: 0,
    prompt: null,
    events: [],
    stats: null,
    searchBlob: "",
    referencedFiles: [],
    changedFiles: [],
    changeStats: null,
    continuationPrompts: [],
  };

  for (const event of events) {
    if (event.kind === "user_prompt") {
      if (event.promptClass === "hidden") {
        continue;
      }

      if (event.promptClass === "continuation" || isCompactedContextPrompt(event.text || "")) {
        if (currentTurn) {
          currentTurn.continuationPrompts.push(event);
          continue;
        }
        detachedPrompts.push({ event, reason: "continuation_without_parent" });
        preamble.continuationPrompts.push(event);
        continue;
      }

      if (event.promptClass === "info") {
        const infoItem = {
          id: `info-${infoItems.length + 1}`,
          event,
        };
        infoItems.push(infoItem);
        flowItems.push({
          type: "info",
          info: infoItem,
        });
        continue;
      }

      if (event.promptClass === "error" || event.promptClass === "meta") {
        detachedPrompts.push({ event, reason: event.promptClass });
        continue;
      }

      currentTurn = {
        id: `turn-${turns.length + 1}`,
        index: turns.length + 1,
        prompt: event,
        events: [],
        stats: null,
        searchBlob: "",
        referencedFiles: [],
        changedFiles: [],
        changeStats: null,
        continuationPrompts: [],
      };
      turns.push(currentTurn);
      flowItems.push({
        type: "turn",
        turn: currentTurn,
      });
      continue;
    }

    if (currentTurn) {
      currentTurn.events.push(event);
    } else {
      preamble.events.push(event);
    }
  }

  const finalized = [];

  if (preamble.events.length > 0) {
    finalizeTurn(preamble);
    finalized.push(preamble);
  }

  for (const turn of turns) {
    finalizeTurn(turn);
    finalized.push(turn);
  }

  return {
    turns: finalized,
    infoItems,
    flowItems,
    detachedPrompts,
  };
}

function isCompactedContextPrompt(text) {
  const normalized = oneLine(String(text || "")).toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("this session is being continued from a previous conversation") &&
    normalized.includes("ran out of context")
  );
}

function finalizeTurn(turn) {
  const stats = {
    assistantMessages: 0,
    assistantThinking: 0,
    toolUses: 0,
    toolResults: 0,
    metaEvents: 0,
  };

  const pieces = [];
  const candidateText = [];

  if (turn.prompt?.searchBlob) {
    pieces.push(turn.prompt.searchBlob);
    candidateText.push(turn.prompt.text || "");
  }

  if (Array.isArray(turn.continuationPrompts)) {
    for (const continuation of turn.continuationPrompts) {
      candidateText.push(continuation.text || "");
    }
  }

  for (const event of turn.events) {
    pieces.push(event.searchBlob || "");

    if (event.kind === "assistant_message") {
      stats.assistantMessages += 1;
      stats.toolUses += event.toolUses.length;
      candidateText.push(event.textBlocks.map(block => block.text || "").join("\n"));
    } else if (event.kind === "assistant_thinking") {
      stats.assistantThinking += 1;
      candidateText.push(event.thinking || "");
    } else if (event.kind === "user_tool_result") {
      stats.toolResults += event.toolResults.length;
      candidateText.push(
        event.toolResults
          .map(result => {
            const name = result.toolName || "";
            return `${name}\n${flattenValue(result.content)}`;
          })
          .join("\n"),
      );
    } else if (event.kind === "session_meta") {
      stats.metaEvents += 1;
      candidateText.push(flattenValue(event.raw));
    }
  }

  turn.stats = stats;
  turn.searchBlob = pieces.join("\n").toLowerCase();
  turn.referencedFiles = extractFileReferences(candidateText.join("\n"));
  const changeSummary = extractTurnChanges(turn.events);
  turn.changedFiles = changeSummary.files;
  turn.changeStats = changeSummary.stats;
}

function extractTurnChanges(events) {
  const toolResultsByUseId = new Map();

  for (const event of events) {
    if (event.kind !== "user_tool_result") {
      continue;
    }

    for (const result of event.toolResults) {
      if (!result.toolUseId) {
        continue;
      }
      if (!toolResultsByUseId.has(result.toolUseId)) {
        toolResultsByUseId.set(result.toolUseId, []);
      }
      toolResultsByUseId.get(result.toolUseId).push(result);
    }
  }

  const filesMap = new Map();
  let totalOperations = 0;

  for (const event of events) {
    if (event.kind !== "assistant_message") {
      continue;
    }

    for (const block of event.toolUses) {
      if (!block || typeof block !== "object") {
        continue;
      }

      const toolName = block.name || "";
      const input = block.input || {};
      const toolUseId = block.id || null;
      const results = toolUseId ? toolResultsByUseId.get(toolUseId) || [] : [];
      const status = getOperationStatus(results);
      const statusMessage = summarizeToolResults(results);

      if (toolName === "Edit" && typeof input.file_path === "string") {
        const entry = ensureFileEntry(filesMap, input.file_path);
        entry.operations.push({
          kind: "edit",
          toolUseId,
          toolName,
          timestamp: event.timestamp,
          oldText: String(input.old_string || ""),
          newText: String(input.new_string || ""),
          replaceAll: Boolean(input.replace_all),
          status,
          statusMessage,
        });
        bumpEntryStatus(entry, status);
        totalOperations += 1;
        continue;
      }

      if (toolName === "Write" && typeof input.file_path === "string") {
        const entry = ensureFileEntry(filesMap, input.file_path);
        entry.operations.push({
          kind: "write",
          toolUseId,
          toolName,
          timestamp: event.timestamp,
          content: String(input.content || ""),
          status,
          statusMessage,
        });
        bumpEntryStatus(entry, status);
        totalOperations += 1;
        continue;
      }
    }
  }

  const files = [...filesMap.values()].sort((a, b) => a.filePath.localeCompare(b.filePath));
  return {
    files,
    stats: {
      filesChanged: files.length,
      totalOperations,
    },
  };
}

function ensureFileEntry(filesMap, filePath) {
  if (!filesMap.has(filePath)) {
    filesMap.set(filePath, {
      filePath,
      displayPath: shortenPath(filePath),
      operations: [],
      okCount: 0,
      errorCount: 0,
      unknownCount: 0,
    });
  }
  return filesMap.get(filePath);
}

function bumpEntryStatus(entry, status) {
  if (status === "ok") {
    entry.okCount += 1;
    return;
  }
  if (status === "error") {
    entry.errorCount += 1;
    return;
  }
  entry.unknownCount += 1;
}

function getOperationStatus(results) {
  if (!results || results.length === 0) {
    return "unknown";
  }
  return results.some(result => result.isError) ? "error" : "ok";
}

function summarizeToolResults(results) {
  if (!results || results.length === 0) {
    return "No tool_result captured for this tool call.";
  }
  const first = results[0];
  const text = flattenValue(first.content);
  if (first.isError) {
    return truncate(oneLine(text || "Tool returned an error."), 220);
  }
  return truncate(oneLine(text || "Tool call completed."), 220);
}

function buildSessionMeta(name, events, turns) {
  const timestamps = events
    .map(event => event.timestamp)
    .filter(Boolean)
    .map(value => Date.parse(value))
    .filter(value => Number.isFinite(value));

  const modelNames = new Set();
  const lanes = new Set();
  const taskIds = new Set();

  for (const event of events) {
    const rawModel = event.raw?.model_name;
    const msgModel = event.raw?.message?.model;
    if (rawModel) {
      modelNames.add(rawModel);
    }
    if (msgModel) {
      modelNames.add(msgModel);
    }
    if (event.raw?.model_lane) {
      lanes.add(event.raw.model_lane);
    }
    if (event.raw?.task_id) {
      taskIds.add(event.raw.task_id);
    }
  }

  const promptCount = turns.filter(turn => turn.prompt != null).length;
  const latestSummary = [...events]
    .reverse()
    .find(event => event.type === "session_summary")?.raw?.summary_data;

  return {
    name,
    eventCount: events.length,
    promptCount,
    firstTimestamp: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null,
    lastTimestamp: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null,
    modelNames: [...modelNames],
    modelLanes: [...lanes],
    taskIds: [...taskIds],
    latestSummary: latestSummary || null,
  };
}

function extractFileReferences(text) {
  const matches = text.match(PATH_REGEX) || [];
  const cleaned = [];

  for (const raw of matches) {
    const value = raw.replace(/[),.;:]+$/, "");
    if (value.length < 4) {
      continue;
    }
    if (!cleaned.includes(value)) {
      cleaned.push(value);
    }
    if (cleaned.length >= 20) {
      break;
    }
  }

  return cleaned;
}

function renderAll() {
  renderServerFiles();
  renderTabs();
  renderCompareControls();
  renderContent();
}

function renderTabs() {
  dom.tabs.innerHTML = "";

  if (state.sessionOrder.length === 0) {
    return;
  }

  for (const sessionId of state.sessionOrder) {
    const session = state.sessions.get(sessionId);
    if (!session) {
      continue;
    }

    const tab = document.createElement("button");
    tab.className = "tab";
    if (!state.compareMode && state.activeSessionId === sessionId) {
      tab.classList.add("active");
    }

    const label = document.createElement("span");
    label.textContent = session.name;

    tab.addEventListener("click", () => {
      if (state.compareMode) {
        state.leftSessionId = sessionId;
      } else {
        state.activeSessionId = sessionId;
      }
      renderAll();
    });

    const close = document.createElement("button");
    close.className = "close";
    close.type = "button";
    close.textContent = "x";
    close.title = "Remove from view";
    close.addEventListener("click", event => {
      event.stopPropagation();
      removeSession(sessionId);
    });

    tab.append(label, close);
    dom.tabs.appendChild(tab);
  }
}

function renderCompareControls() {
  dom.compareButton.classList.toggle("active", state.compareMode);
  dom.compareButton.textContent = state.compareMode ? "Disable Compare" : "Enable Compare";
  dom.compareControls.hidden = !state.compareMode;
  dom.compareControls.style.display = state.compareMode ? "flex" : "none";

  if (!state.compareMode) {
    dom.leftSelect.innerHTML = "";
    dom.rightSelect.innerHTML = "";
    if (dom.compareSyncToggle) {
      dom.compareSyncToggle.checked = state.syncCompareScroll;
    }
    return;
  }

  normalizeCompareSelection();

  const options = state.sessionOrder
    .map(id => state.sessions.get(id))
    .filter(Boolean)
    .map(session => ({ id: session.id, name: session.name }));

  dom.leftSelect.innerHTML = "";
  dom.rightSelect.innerHTML = "";
  dom.leftSelect.appendChild(new Option("Select left session...", "", false, !state.leftSessionId));
  dom.rightSelect.appendChild(
    new Option("Select right session...", "", false, !state.rightSessionId),
  );

  for (const option of options) {
    dom.leftSelect.appendChild(new Option(option.name, option.id, false, option.id === state.leftSessionId));
    dom.rightSelect.appendChild(
      new Option(option.name, option.id, false, option.id === state.rightSessionId),
    );
  }

  if (dom.compareSyncToggle) {
    dom.compareSyncToggle.checked = state.syncCompareScroll;
  }
}

function renderContent() {
  dom.content.innerHTML = "";

  if (state.sessionOrder.length === 0) {
    showMessage("No sessions loaded yet. Load files from the left panel or upload JSONL files.");
    return;
  }

  if (!state.compareMode) {
    const session = state.sessions.get(state.activeSessionId || state.sessionOrder[0]);
    if (!session) {
      showMessage("Select a session tab to begin.");
      return;
    }

    const pane = document.createElement("div");
    pane.className = "pane";
    renderSessionIntoPane(session, pane, state.searchQuery);
    dom.content.appendChild(pane);
    highlightSearchHits(dom.content, state.searchQueryRaw);
    applySearchExpansion(dom.content, Boolean(state.searchQueryRaw));
    syncSearchHitNavigation();
    updateSearchHits(state.searchHitNodes.length);
    return;
  }

  normalizeCompareSelection();

  const split = document.createElement("div");
  split.className = "split";

  const leftPane = document.createElement("div");
  leftPane.className = "pane";
  const rightPane = document.createElement("div");
  rightPane.className = "pane";

  const leftSession = state.sessions.get(state.leftSessionId);
  const rightSession = state.sessions.get(state.rightSessionId);

  if (leftSession) {
    renderSessionIntoPane(leftSession, leftPane, state.searchQuery, "Left");
  } else {
    leftPane.appendChild(makeEmpty("Choose a left session."));
  }

  if (rightSession) {
    renderSessionIntoPane(rightSession, rightPane, state.searchQuery, "Right");
  } else {
    rightPane.appendChild(makeEmpty("Choose a right session."));
  }

  wirePairedScroll(leftPane, rightPane, () => state.syncCompareScroll);

  split.append(leftPane, rightPane);
  dom.content.appendChild(split);
  highlightSearchHits(dom.content, state.searchQueryRaw);
  applySearchExpansion(dom.content, Boolean(state.searchQueryRaw));
  syncSearchHitNavigation();
  updateSearchHits(state.searchHitNodes.length);
}

function renderSessionIntoPane(session, pane, query, paneName = null) {
  pane.innerHTML = "";

  pane.appendChild(renderSessionMeta(session, paneName));

  if (session.parseErrors.length > 0) {
    const errorCard = document.createElement("div");
    errorCard.className = "session-meta";

    const title = document.createElement("div");
    title.textContent = `Parse warnings (${session.parseErrors.length})`;

    const preview = document.createElement("pre");
    preview.textContent = JSON.stringify(session.parseErrors.slice(0, 5), null, 2);

    errorCard.append(title, preview);
    pane.appendChild(errorCard);
  }

  renderDetachedPromptSection(session, pane, query);

  const sourceItems = Array.isArray(session.flowItems)
    ? session.flowItems
    : session.turns
        .filter(turn => turn.prompt != null)
        .map(turn => ({ type: "turn", turn }));
  const items = [...sourceItems];

  const list = document.createElement("div");
  list.className = "turn-list";

  if (items.length === 0) {
    list.appendChild(makeEmpty("No turns available in this session."));
    pane.appendChild(list);
    return;
  }

  items.forEach(item => {
    if (item.type === "info") {
      list.appendChild(renderInfoItemCard(item.info, query));
      return;
    }

    const turn = item.turn;
    const turnKey = `${session.id}:${turn.id}`;
    const details = document.createElement("details");
    details.className = "turn";

    const hasSavedOpenState = Object.prototype.hasOwnProperty.call(
      state.turnOpenByKey,
      turnKey,
    );
    const matchesQuery = Boolean(query) && turn.searchBlob.includes(query);
    const defaultOpen = false;
    details.open = query
      ? matchesQuery
      : hasSavedOpenState
        ? Boolean(state.turnOpenByKey[turnKey])
        : defaultOpen;

    const summary = document.createElement("summary");
    const title = document.createElement("div");
    title.className = "turn-title";

    const label = turn.prompt
      ? `Turn ${turn.index}: ${turn.prompt.preview || "(empty prompt)"}`
      : "Session Setup / Meta";
    title.textContent = label;

    const sub = document.createElement("div");
    sub.className = "turn-sub";
    sub.textContent = formatTurnSubline(turn);

    summary.append(title, sub);
    details.appendChild(summary);

    const body = document.createElement("div");
    body.className = "turn-body";
    details.appendChild(body);

    details.addEventListener("toggle", () => {
      state.turnOpenByKey[turnKey] = details.open;
      if (!details.open || body.dataset.rendered === "1") {
        return;
      }
      renderTurnBody(session, turn, body, query);
      body.dataset.rendered = "1";
    });

    if (details.open) {
      renderTurnBody(session, turn, body, query);
      body.dataset.rendered = "1";
    }

    list.appendChild(details);
  });

  pane.appendChild(list);
}

function renderSessionMeta(session, paneName) {
  const container = document.createElement("div");
  container.className = "session-meta";

  const header = document.createElement("div");
  header.textContent = paneName ? `${paneName} Pane: ${session.name}` : session.name;

  const grid = document.createElement("div");
  grid.className = "session-meta-grid";

  addMetaItem(grid, "Source", session.source);
  addMetaItem(grid, "Events", String(session.meta.eventCount));
  addMetaItem(grid, "Human Prompts", String(session.meta.promptCount));
  addMetaItem(grid, "Errors/System", String(session.detachedPrompts?.length || 0));
  addMetaItem(grid, "Start", formatTimestamp(session.meta.firstTimestamp));
  addMetaItem(grid, "End", formatTimestamp(session.meta.lastTimestamp));
  addMetaItem(grid, "Models", session.meta.modelNames.join(", ") || "-");
  addMetaItem(grid, "Model Lanes", session.meta.modelLanes.join(", ") || "-");
  addMetaItem(grid, "Task IDs", session.meta.taskIds.join(", ") || "-");

  container.append(header, grid);

  if (session.meta.latestSummary) {
    const summary = document.createElement("details");
    summary.className = "raw";

    const sumTitle = document.createElement("summary");
    sumTitle.textContent = "Latest session_summary data";

    const body = document.createElement("div");
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(session.meta.latestSummary, null, 2);
    body.appendChild(pre);

    summary.append(sumTitle, body);
    container.appendChild(summary);
  }

  return container;
}

function renderInfoItemCard(info, query) {
  const details = document.createElement("details");
  details.className = "info-item";
  details.open = Boolean(query) && (info.event?.searchBlob || "").includes(query);

  const summary = document.createElement("summary");
  const title = document.createElement("div");
  title.className = "turn-title";
  const commandName = extractXmlTagValue(info.event.text || "", "command-name");
  title.textContent = commandName ? `Info: ${commandName}` : "Info";

  const sub = document.createElement("div");
  sub.className = "turn-sub";
  sub.textContent = `Timestamp: ${formatTimestamp(info.event.timestamp)} | Line: ${info.event.lineNumber}`;

  summary.append(title, sub);
  details.appendChild(summary);

  const body = document.createElement("div");
  body.className = "turn-body";

  const prompt = document.createElement("div");
  prompt.className = "info-box";

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(
    makeButton("Copy Info Text", () => copyToClipboard(info.event.text || ""), {
      feedbackLabel: "Copied",
    }),
    makeButton("Copy Info JSON", () => copyToClipboard(JSON.stringify(info.event.raw, null, 2)), {
      feedbackLabel: "Copied",
    }),
  );

  const pre = document.createElement("pre");
  pre.textContent = info.event.text || "";

  prompt.append(actions, pre);
  body.appendChild(prompt);
  details.appendChild(body);
  return details;
}

function extractXmlTagValue(text, tagName) {
  const source = String(text || "");
  const re = new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*<\\/${tagName}>`, "i");
  const match = source.match(re);
  return match ? match[1].trim() : "";
}

function renderDetachedPromptSection(session, pane, query) {
  const all = Array.isArray(session.detachedPrompts) ? session.detachedPrompts : [];
  if (all.length === 0) {
    return;
  }

  const grouped = groupDetachedPrompts(all);

  const section = document.createElement("details");
  section.className = "errors-section";
  section.open = Boolean(query) && grouped.some(group => (group.searchBlob || "").includes(query));

  const summary = document.createElement("summary");
  summary.textContent = `Errors / System Messages (${all.length} messages, ${grouped.length} groups)`;
  section.appendChild(summary);

  const body = document.createElement("div");
  body.className = "errors-body";

  grouped.forEach((group, index) => {
    const event = group.firstEvent;
    const groupDetails = document.createElement("details");
    groupDetails.className = "error-group";
    groupDetails.open = Boolean(query) && (group.searchBlob || "").includes(query);

    const groupSummary = document.createElement("summary");
    const groupTitle = document.createElement("div");
    groupTitle.className = "file-change-title";
    groupTitle.textContent = `Group ${index + 1}: ${truncate(oneLine(event.text || ""), 120)}`;

    const badges = document.createElement("div");
    badges.className = "badges";
    badges.append(
      makeBadge(`Type: ${group.reason}`),
      makeBadge(`Count: ${group.count}`),
      makeBadge(`First: ${formatTimestamp(group.firstEvent.timestamp)}`),
      makeBadge(`Last: ${formatTimestamp(group.lastEvent.timestamp)}`),
    );
    if (group.reason === "error") {
      badges.append(makeBadge("Error", "error"));
    } else {
      badges.append(makeBadge("System", "warn"));
    }

    groupSummary.append(groupTitle, badges);
    groupDetails.appendChild(groupSummary);

    const card = document.createElement("div");
    card.className = "error-box";

    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(
      makeButton("Copy Text", () => copyToClipboard(event.text || ""), {
        feedbackLabel: "Copied",
      }),
    );

    const pre = document.createElement("pre");
    pre.textContent = event.text || "";

    card.append(actions, pre);
    groupDetails.appendChild(card);
    body.appendChild(groupDetails);
  });

  section.appendChild(body);
  pane.appendChild(section);
}

function groupDetachedPrompts(items) {
  const groups = new Map();

  for (const item of items) {
    const reason = item.reason || "meta";
    const text = item.event?.text || "";
    const key = `${reason}::${text}`;
    if (!groups.has(key)) {
      groups.set(key, {
        reason,
        text,
        searchBlob: item.event?.searchBlob || collectSearchBlob(text || ""),
        count: 0,
        firstEvent: item.event,
        lastEvent: item.event,
      });
    }
    const group = groups.get(key);
    group.count += 1;
    if (Date.parse(item.event.timestamp || "") > Date.parse(group.lastEvent.timestamp || "")) {
      group.lastEvent = item.event;
    }
  }

  return [...groups.values()].sort((a, b) => {
    const aTs = Date.parse(a.firstEvent.timestamp || "") || 0;
    const bTs = Date.parse(b.firstEvent.timestamp || "") || 0;
    return aTs - bTs;
  });
}

function renderTurnBody(session, turn, root, query) {
  root.innerHTML = "";

  if (turn.prompt) {
    const prompt = document.createElement("div");
    prompt.className = "prompt";

    const promptTitle = document.createElement("div");
    promptTitle.className = "section-title";
    promptTitle.textContent = "User prompt was:";

    const badges = document.createElement("div");
    badges.className = "badges";
    badges.append(
      makeBadge(`Timestamp: ${formatTimestamp(turn.prompt.timestamp)}`),
      makeBadge(`Line: ${turn.prompt.lineNumber}`),
    );

    const actions = document.createElement("div");
    actions.className = "actions";

    const copyText = makeButton("Copy Prompt Text", () => {
      copyToClipboard(turn.prompt.text || "");
    }, { feedbackLabel: "Copied" });

    const copyJson = makeButton("Copy Prompt JSON", () => {
      copyToClipboard(JSON.stringify(turn.prompt.raw, null, 2));
    }, { feedbackLabel: "Copied" });

    actions.append(copyText, copyJson);

    const pre = document.createElement("pre");
    pre.textContent = turn.prompt.text || "";

    prompt.append(promptTitle, badges, actions, pre);
    root.appendChild(prompt);
  }

  renderCompactedContexts(turn, root, query);
  renderTurnChanges(session, turn, root);
}

function renderCompactedContexts(turn, root, query) {
  if (!Array.isArray(turn.continuationPrompts) || turn.continuationPrompts.length === 0) {
    return;
  }

  const details = document.createElement("details");
  details.className = "event";
  details.open = false;
  details.dataset.searchExclude = "1";

  const summary = document.createElement("summary");
  const title = document.createElement("div");
  title.className = "section-title";
  title.textContent = `Compacted context (${turn.continuationPrompts.length})`;

  const meta = document.createElement("div");
  meta.className = "event-meta";
  meta.textContent =
    "Continuation prompts merged into this turn because they represent context compaction.";

  summary.append(title, meta);
  details.appendChild(summary);

  const body = document.createElement("div");
  body.className = "event-body";

  turn.continuationPrompts.forEach((continuation, index) => {
    const block = document.createElement("div");
    block.className = "prompt";

    const badges = document.createElement("div");
    badges.className = "badges";
    badges.append(
      makeBadge(`Compacted Context ${index + 1}`),
      makeBadge(`Timestamp: ${formatTimestamp(continuation.timestamp)}`),
      makeBadge(`Line: ${continuation.lineNumber}`),
    );

    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(
      makeButton("Copy Context Text", () => copyToClipboard(continuation.text || ""), {
        feedbackLabel: "Copied",
      }),
      makeButton(
        "Copy Context JSON",
        () => copyToClipboard(JSON.stringify(continuation.raw, null, 2)),
        { feedbackLabel: "Copied" },
      ),
    );

    const pre = document.createElement("pre");
    pre.textContent = continuation.text || "";

    block.append(badges, actions, pre);
    body.appendChild(block);
  });

  details.appendChild(body);
  root.appendChild(details);
}

function renderTurnChanges(session, turn, root) {
  const section = document.createElement("div");
  section.className = "changes-card";

  const head = document.createElement("div");
  head.className = "changes-head";

  const title = document.createElement("div");
  title.className = "section-title";
  title.textContent = "Assistant made these changes:";
  head.appendChild(title);

  const stats = turn.changeStats || { filesChanged: 0, totalOperations: 0 };
  head.append(
    makeBadge(`Files changed: ${stats.filesChanged}`),
    makeBadge(`Edit operations: ${stats.totalOperations}`),
    makeBadge(state.showLineNumbers ? "Line numbers: on" : "Line numbers: off"),
  );

  section.appendChild(head);

  if (!turn.changedFiles || turn.changedFiles.length === 0) {
    const message = document.createElement("div");
    message.className = "event-meta";
    message.textContent = "No explicit Edit/Write file changes were captured for this prompt.";
    section.appendChild(message);
    root.appendChild(section);
    return;
  }

  const turnKey = `${session.id}:${turn.id}`;
  const activePath =
    state.activeFileTabByTurn[turnKey] && turn.changedFiles.some(f => f.filePath === state.activeFileTabByTurn[turnKey])
      ? state.activeFileTabByTurn[turnKey]
      : turn.changedFiles[0].filePath;

  state.activeFileTabByTurn[turnKey] = activePath;

  const tabs = document.createElement("div");
  tabs.className = "file-tabs";
  for (const file of turn.changedFiles) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "file-tab";
    if (file.filePath === activePath) {
      tab.classList.add("active");
    }
    tab.textContent = `${file.displayPath} (${file.operations.length})`;
    tab.addEventListener("click", () => {
      state.activeFileTabByTurn[turnKey] = file.filePath;
      renderContent();
    });
    tabs.appendChild(tab);
  }
  section.appendChild(tabs);

  const selectedFile = turn.changedFiles.find(file => file.filePath === activePath) || turn.changedFiles[0];
  section.appendChild(renderSelectedFileTab(selectedFile));

  root.appendChild(section);
}

function renderSelectedFileTab(file) {
  const wrap = document.createElement("div");
  wrap.className = "file-change-body";

  const header = document.createElement("div");
  header.className = "file-change-title";
  header.textContent = file.filePath;

  const meta = document.createElement("div");
  meta.className = "event-meta";
  meta.textContent = `Operations: ${file.operations.length} | ok: ${file.okCount} | error: ${file.errorCount} | unknown: ${file.unknownCount}`;

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(
    makeButton(
      "Copy File Path",
      () => copyToClipboard(file.filePath),
      { feedbackLabel: "Copied" },
    ),
    makeButton(
      "Copy All Changed Code",
      () => copyToClipboard(joinFileChangeCode(file)),
      { feedbackLabel: "Copied" },
    ),
  );

  wrap.append(header, meta, actions);

  file.operations.forEach((operation, index) => {
    const opWrap = document.createElement("div");
    opWrap.className = "event";

    const opBody = document.createElement("div");
    opBody.className = "event-body";

    const opTitle = document.createElement("div");
    opTitle.className = "section-title";
    opTitle.textContent = `${capitalize(operation.kind)} #${index + 1}`;

    const opMeta = document.createElement("div");
    opMeta.className = "event-meta";
    opMeta.textContent = `${operation.toolName} | ${formatTimestamp(operation.timestamp)} | ${operation.status}`;

    const badges = document.createElement("div");
    badges.className = "badges";
    badges.append(makeBadge(`Status: ${operation.status}`, operation.status === "error" ? "error" : ""));
    if (operation.toolUseId) {
      badges.append(makeBadge(`Tool Use ID: ${operation.toolUseId}`, "tool"));
    }
    if (operation.kind === "edit" && operation.replaceAll) {
      badges.append(makeBadge("replace_all: true"));
    }

    opBody.append(opTitle, opMeta, badges);

    if (operation.statusMessage) {
      const statusLine = document.createElement("div");
      statusLine.className = "event-meta";
      statusLine.textContent = operation.statusMessage;
      opBody.appendChild(statusLine);
    }

    if (operation.kind === "edit") {
      opBody.appendChild(renderDiffComparison(operation.oldText || "", operation.newText || ""));
    } else if (operation.kind === "write") {
      opBody.appendChild(renderDiffComparison("", operation.content || ""));
    }

    const opActions = document.createElement("div");
    opActions.className = "actions";
    opActions.append(
      makeButton(
        "Copy Operation JSON",
        () => copyToClipboard(JSON.stringify(operation, null, 2)),
        { feedbackLabel: "Copied" },
      ),
    );
    opBody.appendChild(opActions);

    opWrap.appendChild(opBody);
    wrap.appendChild(opWrap);
  });

  return wrap;
}

function renderDiffComparison(oldText, newText) {
  const diffRows = buildDiffRows(oldText, newText);
  const stats = summarizeDiffRows(diffRows);

  const container = document.createElement("div");
  container.className = "code-compare";

  const leftPane = document.createElement("div");
  leftPane.className = "code-pane";
  const leftTitle = document.createElement("div");
  leftTitle.className = "code-pane-title";
  leftTitle.textContent = `Before (-${stats.removed})`;
  const leftBody = document.createElement("div");
  leftBody.className = "diff-body";
  leftPane.append(leftTitle, leftBody);

  const rightPane = document.createElement("div");
  rightPane.className = "code-pane";
  const rightTitle = document.createElement("div");
  rightTitle.className = "code-pane-title";
  rightTitle.textContent = `After (+${stats.added})`;
  const rightBody = document.createElement("div");
  rightBody.className = "diff-body";
  rightPane.append(rightTitle, rightBody);

  diffRows.forEach(row => {
    const leftRow = document.createElement("div");
    leftRow.className = `diff-row ${row.type === "remove" ? "remove" : row.type === "context" ? "context" : "blank"}`;
    leftRow.textContent = formatDiffLine(row.oldLine, row.oldText);
    leftBody.appendChild(leftRow);

    const rightRow = document.createElement("div");
    rightRow.className = `diff-row ${row.type === "add" ? "add" : row.type === "context" ? "context" : "blank"}`;
    rightRow.textContent = formatDiffLine(row.newLine, row.newText);
    rightBody.appendChild(rightRow);
  });

  wirePairedScroll(leftBody, rightBody, () => state.syncDiffScroll);

  container.append(leftPane, rightPane);
  return container;
}

function formatTurnSubline(turn) {
  const parts = [];

  if (turn.prompt?.timestamp) {
    parts.push(`Turn Time: ${formatTimestamp(turn.prompt.timestamp)}`);
  }

  parts.push(`Assistant: ${turn.stats.assistantMessages}`);
  parts.push(`Thinking: ${turn.stats.assistantThinking}`);
  parts.push(`Tool Calls: ${turn.stats.toolUses}`);
  parts.push(`Tool Results: ${turn.stats.toolResults}`);
  parts.push(`Files Changed: ${turn.changeStats?.filesChanged || 0}`);
  parts.push(`Compacted Context: ${turn.continuationPrompts?.length || 0}`);

  if (turn.referencedFiles.length > 0) {
    parts.push(`File Refs: ${turn.referencedFiles.length}`);
  }

  return parts.join(" | ");
}

function joinFileChangeCode(file) {
  const chunks = [];
  for (const operation of file.operations) {
    if (operation.kind === "edit") {
      chunks.push(
        `# ${file.filePath}\n## Edit (old_string)\n${operation.oldText || ""}\n\n## Edit (new_string)\n${operation.newText || ""}`,
      );
    } else if (operation.kind === "write") {
      chunks.push(`# ${file.filePath}\n## Write (content)\n${operation.content || ""}`);
    }
  }
  return chunks.join("\n\n");
}

function shortenPath(filePath) {
  const input = String(filePath || "");
  if (!input) {
    return "(unknown file)";
  }

  const normalized = input.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 5) {
    return normalized;
  }
  return `.../${parts.slice(-5).join("/")}`;
}

function capitalize(value) {
  const text = String(value || "");
  if (!text) {
    return "";
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function buildDiffRows(oldText, newText) {
  const oldLines = String(oldText ?? "").split("\n");
  const newLines = String(newText ?? "").split("\n");

  if (oldLines.length === 1 && oldLines[0] === "") {
    return newLines.map((line, index) => ({
      type: "add",
      oldLine: null,
      newLine: index + 1,
      oldText: "",
      newText: line,
    }));
  }

  if (newLines.length === 1 && newLines[0] === "") {
    return oldLines.map((line, index) => ({
      type: "remove",
      oldLine: index + 1,
      newLine: null,
      oldText: line,
      newText: "",
    }));
  }

  const maxCells = 900000;
  if (oldLines.length * newLines.length > maxCells) {
    return buildDiffRowsFast(oldLines, newLines);
  }

  const m = oldLines.length;
  const n = newLines.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));

  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      if (oldLines[i] === newLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const rows = [];
  let i = 0;
  let j = 0;
  let oldNo = 1;
  let newNo = 1;

  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      rows.push({
        type: "context",
        oldLine: oldNo,
        newLine: newNo,
        oldText: oldLines[i],
        newText: newLines[j],
      });
      i += 1;
      j += 1;
      oldNo += 1;
      newNo += 1;
      continue;
    }

    if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({
        type: "remove",
        oldLine: oldNo,
        newLine: null,
        oldText: oldLines[i],
        newText: "",
      });
      i += 1;
      oldNo += 1;
    } else {
      rows.push({
        type: "add",
        oldLine: null,
        newLine: newNo,
        oldText: "",
        newText: newLines[j],
      });
      j += 1;
      newNo += 1;
    }
  }

  while (i < m) {
    rows.push({
      type: "remove",
      oldLine: oldNo,
      newLine: null,
      oldText: oldLines[i],
      newText: "",
    });
    i += 1;
    oldNo += 1;
  }

  while (j < n) {
    rows.push({
      type: "add",
      oldLine: null,
      newLine: newNo,
      oldText: "",
      newText: newLines[j],
    });
    j += 1;
    newNo += 1;
  }

  return rows;
}

function buildDiffRowsFast(oldLines, newLines) {
  const rows = [];
  let i = 0;
  let j = 0;
  let oldNo = 1;
  let newNo = 1;
  const lookahead = 30;

  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      rows.push({
        type: "context",
        oldLine: oldNo,
        newLine: newNo,
        oldText: oldLines[i],
        newText: newLines[j],
      });
      i += 1;
      j += 1;
      oldNo += 1;
      newNo += 1;
      continue;
    }

    const nextInNew = findAhead(newLines, j, oldLines[i], lookahead);
    const nextInOld = findAhead(oldLines, i, newLines[j], lookahead);

    if (nextInNew !== -1 && (nextInOld === -1 || nextInNew <= nextInOld)) {
      rows.push({
        type: "add",
        oldLine: null,
        newLine: newNo,
        oldText: "",
        newText: newLines[j],
      });
      j += 1;
      newNo += 1;
    } else if (nextInOld !== -1) {
      rows.push({
        type: "remove",
        oldLine: oldNo,
        newLine: null,
        oldText: oldLines[i],
        newText: "",
      });
      i += 1;
      oldNo += 1;
    } else {
      rows.push({
        type: "remove",
        oldLine: oldNo,
        newLine: null,
        oldText: oldLines[i],
        newText: "",
      });
      rows.push({
        type: "add",
        oldLine: null,
        newLine: newNo,
        oldText: "",
        newText: newLines[j],
      });
      i += 1;
      j += 1;
      oldNo += 1;
      newNo += 1;
    }
  }

  while (i < oldLines.length) {
    rows.push({
      type: "remove",
      oldLine: oldNo,
      newLine: null,
      oldText: oldLines[i],
      newText: "",
    });
    i += 1;
    oldNo += 1;
  }

  while (j < newLines.length) {
    rows.push({
      type: "add",
      oldLine: null,
      newLine: newNo,
      oldText: "",
      newText: newLines[j],
    });
    j += 1;
    newNo += 1;
  }

  return rows;
}

function findAhead(lines, start, target, limit) {
  const stop = Math.min(lines.length, start + limit);
  for (let i = start + 1; i < stop; i += 1) {
    if (lines[i] === target) {
      return i - start;
    }
  }
  return -1;
}

function summarizeDiffRows(rows) {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.type === "add") {
      added += 1;
    } else if (row.type === "remove") {
      removed += 1;
    }
  }
  return { added, removed };
}

function formatDiffLine(lineNo, text) {
  if (lineNo == null) {
    return state.showLineNumbers ? "    " : "";
  }
  if (!state.showLineNumbers) {
    return text;
  }
  const prefix = String(lineNo).padStart(4, " ");
  return `${prefix} | ${text}`;
}

function addMetaItem(grid, key, value) {
  const k = document.createElement("div");
  k.className = "k";
  k.textContent = key;

  const v = document.createElement("div");
  v.textContent = value;

  grid.append(k, v);
}

function makeBadge(text, kind = "") {
  const badge = document.createElement("span");
  badge.className = `badge ${kind}`.trim();
  badge.textContent = text;
  return badge;
}

function makeButton(label, onClick, options = {}) {
  const { feedbackLabel = "", feedbackMs = 1100 } = options;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", async () => {
    const result = await onClick(button);
    if (feedbackLabel && result !== false) {
      flashButton(button, feedbackLabel, feedbackMs);
    }
  });
  return button;
}

async function withButtonProgress(button, run) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Loading...";

  try {
    await run();
    button.textContent = "Done";
    window.setTimeout(() => {
      button.textContent = original;
      button.disabled = false;
    }, 850);
  } catch (error) {
    button.textContent = "Failed";
    window.setTimeout(() => {
      button.textContent = original;
      button.disabled = false;
    }, 1200);
    throw error;
  }
}

function flashButton(button, message, duration = 1100) {
  const original = button.textContent;
  button.textContent = message;
  button.classList.add("button-flash");
  window.setTimeout(() => {
    button.textContent = original;
    button.classList.remove("button-flash");
  }, duration);
}

function wirePairedScroll(leftEl, rightEl, isEnabled) {
  let syncing = false;

  const sync = (source, target) => () => {
    if (!isEnabled() || syncing) {
      return;
    }
    syncing = true;
    target.scrollTop = source.scrollTop;
    target.scrollLeft = source.scrollLeft;
    syncing = false;
  };

  leftEl.addEventListener("scroll", sync(leftEl, rightEl), { passive: true });
  rightEl.addEventListener("scroll", sync(rightEl, leftEl), { passive: true });
}

function updateSearchHits(hitCount) {
  if (!dom.searchHits) {
    return;
  }

  const hasQuery = Boolean(state.searchQueryRaw.trim());
  const canNavigate = hasQuery && hitCount > 0;
  if (!hasQuery) {
    dom.searchHits.hidden = true;
    if (dom.searchHitCount) {
      dom.searchHitCount.textContent = "0 hits";
    }
    if (dom.searchPrevButton) {
      dom.searchPrevButton.disabled = true;
    }
    if (dom.searchNextButton) {
      dom.searchNextButton.disabled = true;
    }
    return;
  }

  const count = Number.isFinite(hitCount) ? hitCount : 0;
  dom.searchHits.hidden = false;
  if (dom.searchHitCount) {
    dom.searchHitCount.textContent = `${count} hit${count === 1 ? "" : "s"}`;
  }
  if (dom.searchPrevButton) {
    dom.searchPrevButton.disabled = !canNavigate;
  }
  if (dom.searchNextButton) {
    dom.searchNextButton.disabled = !canNavigate;
  }
}

function highlightSearchHits(root, queryRaw) {
  if (!(root instanceof Element)) {
    return 0;
  }

  const query = String(queryRaw || "").trim();
  if (!query) {
    return 0;
  }

  const queryLower = query.toLowerCase();
  let hits = 0;
  const textNodes = [];
  const skipTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION"]);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) {
        return NodeFilter.FILTER_REJECT;
      }
      const parent = node.parentElement;
      if (!parent) {
        return NodeFilter.FILTER_REJECT;
      }
      if (skipTags.has(parent.tagName)) {
        return NodeFilter.FILTER_REJECT;
      }
      if (parent.closest("[data-search-exclude='1']")) {
        return NodeFilter.FILTER_REJECT;
      }
      if (parent.closest(".search-hit")) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  while (walker.nextNode()) {
    textNodes.push(walker.currentNode);
  }

  for (const node of textNodes) {
    const text = node.nodeValue || "";
    const lowered = text.toLowerCase();
    let index = lowered.indexOf(queryLower);
    if (index === -1) {
      continue;
    }

    const fragment = document.createDocumentFragment();
    let cursor = 0;

    while (index !== -1) {
      if (index > cursor) {
        fragment.appendChild(document.createTextNode(text.slice(cursor, index)));
      }
      const mark = document.createElement("mark");
      mark.className = "search-hit";
      mark.textContent = text.slice(index, index + query.length);
      fragment.appendChild(mark);
      hits += 1;
      cursor = index + query.length;
      index = lowered.indexOf(queryLower, cursor);
    }

    if (cursor < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(cursor)));
    }

    if (node.parentNode) {
      node.parentNode.replaceChild(fragment, node);
    }
  }

  return hits;
}

function applySearchExpansion(root, enabled) {
  if (!(root instanceof Element) || !enabled) {
    return;
  }

  const detailsNodes = [...root.querySelectorAll("details")];
  for (let i = detailsNodes.length - 1; i >= 0; i -= 1) {
    const details = detailsNodes[i];
    const hasHit = details.querySelector("mark.search-hit") != null;
    details.open = hasHit;
  }
}

function syncSearchHitNavigation() {
  const query = state.searchQueryRaw.trim();
  if (!query) {
    state.searchHitNodes = [];
    state.activeSearchHitIndex = -1;
    state.lastSearchQueryRaw = "";
    return;
  }

  state.searchHitNodes = [...dom.content.querySelectorAll("mark.search-hit")];
  if (state.searchHitNodes.length === 0) {
    state.activeSearchHitIndex = -1;
    state.lastSearchQueryRaw = query;
    return;
  }

  if (
    state.lastSearchQueryRaw !== query ||
    state.activeSearchHitIndex < 0 ||
    state.activeSearchHitIndex >= state.searchHitNodes.length
  ) {
    state.activeSearchHitIndex = 0;
  }
  state.lastSearchQueryRaw = query;
  applyActiveSearchHit(false);
}

function applyActiveSearchHit(scrollIntoView) {
  for (const node of state.searchHitNodes) {
    node.classList.remove("search-hit-active");
  }

  if (
    state.activeSearchHitIndex < 0 ||
    state.activeSearchHitIndex >= state.searchHitNodes.length
  ) {
    return;
  }

  const node = state.searchHitNodes[state.activeSearchHitIndex];
  node.classList.add("search-hit-active");

  if (scrollIntoView) {
    openAncestorDetails(node);
    node.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
  }
}

function goToSearchHit(step) {
  if (!state.searchHitNodes.length) {
    return;
  }

  const total = state.searchHitNodes.length;
  const current = state.activeSearchHitIndex < 0 ? 0 : state.activeSearchHitIndex;
  state.activeSearchHitIndex = (current + step + total) % total;
  applyActiveSearchHit(true);
}

function openAncestorDetails(node) {
  let parent = node.parentElement;
  while (parent) {
    if (parent.tagName === "DETAILS") {
      parent.open = true;
    }
    parent = parent.parentElement;
  }
}

function makeEmpty(message) {
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.textContent = message;
  return empty;
}

function showMessage(message) {
  dom.content.innerHTML = "";
  dom.content.appendChild(makeEmpty(message));
  highlightSearchHits(dom.content, state.searchQueryRaw);
  applySearchExpansion(dom.content, Boolean(state.searchQueryRaw));
  syncSearchHitNavigation();
  updateSearchHits(state.searchHitNodes.length);
}

function removeSession(sessionId) {
  state.sessions.delete(sessionId);
  state.sessionOrder = state.sessionOrder.filter(id => id !== sessionId);
  Object.keys(state.turnOpenByKey).forEach(key => {
    if (key.startsWith(`${sessionId}:`)) {
      delete state.turnOpenByKey[key];
    }
  });
  Object.keys(state.activeFileTabByTurn).forEach(key => {
    if (key.startsWith(`${sessionId}:`)) {
      delete state.activeFileTabByTurn[key];
    }
  });

  if (state.activeSessionId === sessionId) {
    state.activeSessionId = state.sessionOrder[0] || null;
  }

  if (state.leftSessionId === sessionId) {
    state.leftSessionId = state.sessionOrder[0] || null;
  }

  if (state.rightSessionId === sessionId) {
    state.rightSessionId = state.sessionOrder.find(id => id !== state.leftSessionId) || null;
  }

  if (state.sessionOrder.length < 2) {
    state.compareMode = false;
  }

  renderAll();
}

function normalizeCompareSelection() {
  if (!state.sessionOrder.length) {
    state.leftSessionId = null;
    state.rightSessionId = null;
    return;
  }

  if (state.leftSessionId && !state.sessions.has(state.leftSessionId)) {
    state.leftSessionId = null;
  }

  if (state.rightSessionId && !state.sessions.has(state.rightSessionId)) {
    state.rightSessionId = null;
  }
}

function serverSessionId(name) {
  return `server:${name}`;
}

function localSessionId(name, stamp) {
  return `local:${name}:${stamp}`;
}

async function copyToClipboard(text) {
  const payload = String(text ?? "");

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(payload);
      return true;
    } catch (_error) {
      return fallbackCopy(payload);
    }
  }

  return fallbackCopy(payload);
}

function fallbackCopy(text) {
  try {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    document.body.removeChild(area);
    return true;
  } catch (_error) {
    return false;
  }
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimestamp(value) {
  if (!value) {
    return "-";
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return String(value);
  }

  return `${new Date(parsed).toLocaleString()} (${value})`;
}

function oneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncate(value, maxLength) {
  if (!value) {
    return "";
  }
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function collectSearchBlob(value) {
  const out = [];
  collectStrings(value, out);
  return out.join("\n").toLowerCase();
}

function collectStrings(value, out) {
  if (value == null) {
    return;
  }

  if (typeof value === "string") {
    out.push(value);
    return;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    out.push(String(value));
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, out);
    }
    return;
  }

  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      out.push(key);
      collectStrings(nested, out);
    }
  }
}

function flattenValue(value) {
  if (value == null) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map(item => flattenValue(item)).join("\n");
  }

  if (typeof value === "object") {
    return Object.values(value)
      .map(item => flattenValue(item))
      .join("\n");
  }

  return String(value);
}
