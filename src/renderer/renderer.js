const dropZone = document.getElementById("drop-zone");
const pickButton = document.getElementById("pick-file");
const runButton = document.getElementById("run-button");
const inputPath = document.getElementById("input-path");
const mode = document.getElementById("mode");
const aiProvider = document.getElementById("ai-provider");
const suffix = document.getElementById("suffix");
const aiModelLabel = document.getElementById("ai-model-label");
const aiModel = document.getElementById("ai-model");
const aiApiKeyLabel = document.getElementById("ai-api-key-label");
const aiApiKey = document.getElementById("ai-api-key");
const writeReport = document.getElementById("write-report");
const resultOutput = document.getElementById("result-output");
const statusPill = document.getElementById("status-pill");
const appBuild = document.getElementById("app-build");
const appUpdate = document.getElementById("app-update");
let dragDepth = 0;
let providerSettings = {
  gemini: {
    model: "gemini-2.5-flash-lite",
    apiKey: ""
  },
  openai: {
    model: "gpt-5.2",
    apiKey: ""
  }
};
let activeProvider = "gemini";

function getDefaultModelForProvider(provider) {
  return provider === "openai" ? "gpt-5.2" : "gemini-2.5-flash-lite";
}

function getSelectedProvider() {
  return aiProvider.value === "openai" ? "openai" : "gemini";
}

function readProviderFieldState(provider = activeProvider) {
  providerSettings[provider] = {
    model: aiModel.value.trim() || getDefaultModelForProvider(provider),
    apiKey: aiApiKey.value.trim()
  };
}

function syncProviderFields() {
  const provider = getSelectedProvider();
  const label = provider === "openai" ? "OpenAI" : "Gemini";
  const saved = providerSettings[provider] || {
    model: getDefaultModelForProvider(provider),
    apiKey: ""
  };

  aiModelLabel.textContent = `${label} model`;
  aiApiKeyLabel.textContent = `${label} API key`;
  aiModel.value = saved.model || getDefaultModelForProvider(provider);
  aiApiKey.value = saved.apiKey || "";
  activeProvider = provider;
}

function setStatus(status, message) {
  statusPill.className = `status-pill ${status}`;
  statusPill.textContent = status;
  if (message) {
    resultOutput.textContent = message;
  }
}

function formatResult(result) {
  if (!result) {
    return "No result.";
  }

  if (!result.ok) {
    return `Error\n-----\n${result.error || "Unknown error."}`;
  }

  const lines = [
    "Completed",
    "---------",
    `Output file: ${result.outputPath}`,
    `Report file: ${result.reportPath || "None"}`,
    "",
    "Summary",
    `Processed groups: ${result.summary.processedGroups}`,
    `Changed groups: ${result.summary.changedGroups}`,
    `Unchanged groups: ${result.summary.unchangedGroups}`,
    `Flagged groups: ${result.summary.flaggedGroups}`,
    `Rows changed: ${result.summary.rowsChanged}`,
    `Rows written: ${result.summary.rowsWritten}`
  ];

  if (result.summary.ai) {
    lines.push(
      "",
      "AI",
      `Requested: ${result.summary.ai.requested ? "yes" : "no"}`,
      `Provider: ${result.summary.ai.provider || "None"}`,
      `API used: ${result.summary.ai.calledGroups > 0 ? "yes" : "no"}`,
      `Model: ${result.summary.ai.model || "None"}`,
      `Eligible groups: ${result.summary.ai.attemptedGroups}`,
      `Planning-called groups: ${result.summary.ai.planningCalledGroups || 0}`,
      `Planning-applied groups: ${result.summary.ai.planningAppliedGroups || 0}`,
      `API-called groups: ${result.summary.ai.calledGroups}`,
      `Applied groups: ${result.summary.ai.appliedGroups}`,
      `Edited groups: ${result.summary.ai.editedGroups || 0}`,
      `Failed groups: ${result.summary.ai.failedGroups}`
    );

    if (result.summary.ai.phraseSuggestions?.length > 0) {
      lines.push("", "AI phrase suggestions");
      for (const suggestion of result.summary.ai.phraseSuggestions.slice(0, 10)) {
        lines.push(
          `- Rows ${suggestion.rowRange}: phrases=${suggestion.phrases.join(", ")} | blocks=${suggestion.blocks.join("+")}`
        );
      }
    }
  }

  if (result.summary.learning?.enabled) {
    lines.push(
      "",
      "Learning",
      "Learned profile: yes",
      `Profile id: ${result.summary.learning.profileId || "default"}`,
      `Dataset items: ${result.summary.learning.datasetItemCount}`,
      `Preferred char range: ${result.summary.learning.preferredCharRange}`,
      `Learned hard char limit: ${result.summary.learning.hardCharLimit}`,
      `Preferred word max: ${result.summary.learning.preferredWordMax}`,
      `2-row repeat rate: ${(result.summary.learning.repeatTwoRate * 100).toFixed(1)}%`,
      `Title/date merge rate: ${(result.summary.learning.titleDateMergeRate * 100).toFixed(1)}%`,
      `Triple repeat allowed: ${result.summary.learning.allowTripleRepeat ? "yes" : "no"}`
    );
  } else {
    lines.push("", "Learning", "Learned profile: no");
  }

  if (result.summary.notes.length > 0) {
    lines.push("", "Notes");
    for (const note of result.summary.notes) {
      lines.push(`- ${note}`);
    }
  }

  if (result.flaggedDetails.length > 0) {
    lines.push("", "Flagged groups");
    for (const detail of result.flaggedDetails.slice(0, 20)) {
      lines.push(`- Rows ${detail.rowRange}: ${detail.reasons.join("; ")}`);
    }
  }

  return lines.join("\n");
}

async function chooseFile() {
  const picked = await window.subtitleApp.pickInputFile();
  if (picked) {
    inputPath.value = picked;
    setStatus("idle", `Selected file:\n${picked}`);
  }
}

async function run() {
  if (!inputPath.value) {
    setStatus("error", "Choose a .docx file first.");
    return;
  }

  setStatus("running", "Processing subtitle rows. This can take a moment on larger files.");

  try {
    readProviderFieldState(activeProvider);
    const provider = getSelectedProvider();
    const activeProviderSettings = providerSettings[provider];
    await window.subtitleApp.saveAppSettings({
      mode: mode.value,
      aiProvider: provider,
      outputSuffix: suffix.value || "_rearranged_byApp",
      geminiModel: providerSettings.gemini.model || "gemini-2.5-flash-lite",
      geminiApiKey: providerSettings.gemini.apiKey,
      openaiModel: providerSettings.openai.model || "gpt-5.2",
      openaiApiKey: providerSettings.openai.apiKey,
      writeReport: writeReport.checked
    });

    const result = await window.subtitleApp.runRearrangement(inputPath.value, {
      mode: mode.value,
      aiProvider: provider,
      outputSuffix: suffix.value || "_rearranged_byApp",
      aiModel: activeProviderSettings.model || getDefaultModelForProvider(provider),
      apiKey: activeProviderSettings.apiKey || null,
      writeReport: writeReport.checked
    });

    setStatus(result.ok ? "done" : "error", formatResult(result));
  } catch (error) {
    setStatus("error", error?.message || String(error));
  }
}

function readDroppedFile(event) {
  const filePath = extractDroppedFilePath(event);
  if (filePath) {
    inputPath.value = filePath;
    setStatus("idle", `Selected file:\n${filePath}`);
    return true;
  }

  setStatus("error", "Drop a .docx subtitle file.");
  return false;
}

function extractDroppedFilePath(event) {
  const file = event.dataTransfer?.files?.[0];
  const candidates = [
    file ? window.subtitleApp.getPathForDroppedFile(file) : "",
    file?.path || "",
    event.dataTransfer?.getData("text/uri-list") || "",
    event.dataTransfer?.getData("text/plain") || ""
  ];

  for (const candidate of candidates) {
    const normalized = normalizeDroppedPath(candidate);
    if (normalized.toLowerCase().endsWith(".docx")) {
      return normalized;
    }
  }

  return "";
}

function normalizeDroppedPath(value) {
  if (!value) {
    return "";
  }

  let normalized = String(value).trim().replace(/\0/g, "");
  if (!normalized) {
    return "";
  }

  normalized = normalized.replace(/^"+|"+$/g, "");
  normalized = normalized.split(/\r?\n/)[0].trim();

  if (normalized.startsWith("file://")) {
    try {
      normalized = decodeURIComponent(new URL(normalized).pathname);
    } catch (_error) {
      normalized = normalized.replace(/^file:\/*/i, "");
    }
  }

  if (/^\/[A-Za-z]:\//.test(normalized)) {
    normalized = normalized.slice(1);
  }

  return normalized.replace(/\//g, "\\");
}

function setDropActive(active) {
  dropZone.classList.toggle("is-over", active);
  document.body.classList.toggle("drag-active", active);
}

function preventWindowDropDefault(event) {
  event.preventDefault();
  event.stopPropagation();
}

function handleGlobalDragEnter(event) {
  preventWindowDropDefault(event);
  dragDepth += 1;
  setDropActive(true);
}

function handleGlobalDragOver(event) {
  preventWindowDropDefault(event);
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "copy";
  }
  setDropActive(true);
}

function handleGlobalDragLeave(event) {
  preventWindowDropDefault(event);
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    setDropActive(false);
  }
}

function handleGlobalDrop(event) {
  preventWindowDropDefault(event);
  dragDepth = 0;
  setDropActive(false);
  readDroppedFile(event);
}

async function loadAppMeta() {
  if (!appBuild) {
    return;
  }

  try {
    const meta = await window.subtitleApp.getAppMeta();
    const stamp = meta?.buildStamp ? new Date(meta.buildStamp).toLocaleString() : "unknown";
    appBuild.textContent = `Version ${meta?.appVersion || "unknown"} | Build ${stamp}`;
  } catch (_error) {
    appBuild.textContent = "Version unavailable";
  }
}

async function loadUpdateStatus() {
  if (!appUpdate) {
    return;
  }

  try {
    const update = await window.subtitleApp.checkForAppUpdate();
    appUpdate.textContent = update?.message || "Update status unavailable";
    appUpdate.className = `app-update ${update?.status || "unknown"}`;
    if (update?.url) {
      appUpdate.title = update.url;
    }
  } catch (_error) {
    appUpdate.textContent = "Update status unavailable";
    appUpdate.className = "app-update unknown";
  }
}

async function loadAppSettings() {
  try {
    const settings = await window.subtitleApp.getAppSettings();
    if (!settings) {
      return;
    }

    providerSettings = {
      gemini: {
        model: settings.geminiModel || "gemini-2.5-flash-lite",
        apiKey: settings.geminiApiKey || ""
      },
      openai: {
        model: settings.openaiModel || "gpt-5.2",
        apiKey: settings.openaiApiKey || ""
      }
    };
    mode.value = settings.mode || "offline";
    aiProvider.value = settings.aiProvider || "gemini";
    activeProvider = aiProvider.value || "gemini";
    suffix.value = settings.outputSuffix || "_rearranged_byApp";
    writeReport.checked = Boolean(settings.writeReport);
    syncProviderFields();
  } catch (_error) {
    // Keep static defaults if settings cannot be loaded.
  }
}

dropZone.addEventListener("dragover", (event) => {
  preventWindowDropDefault(event);
  setDropActive(true);
});

dropZone.addEventListener("dragleave", (event) => {
  preventWindowDropDefault(event);
  setDropActive(false);
});

dropZone.addEventListener("drop", (event) => {
  handleGlobalDrop(event);
});

dropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    chooseFile();
  }
});

pickButton.addEventListener("click", chooseFile);
runButton.addEventListener("click", run);
aiProvider.addEventListener("change", () => {
  readProviderFieldState(activeProvider);
  syncProviderFields();
});
aiModel.addEventListener("input", () => readProviderFieldState(activeProvider));
aiApiKey.addEventListener("input", () => readProviderFieldState(activeProvider));
window.addEventListener("dragenter", handleGlobalDragEnter);
window.addEventListener("dragover", handleGlobalDragOver);
window.addEventListener("dragleave", handleGlobalDragLeave);
window.addEventListener("drop", handleGlobalDrop);
document.addEventListener("dragenter", handleGlobalDragEnter);
document.addEventListener("dragover", handleGlobalDragOver);
document.addEventListener("dragleave", handleGlobalDragLeave);
document.addEventListener("drop", handleGlobalDrop);
loadAppMeta();
loadUpdateStatus();
loadAppSettings();
syncProviderFields();
