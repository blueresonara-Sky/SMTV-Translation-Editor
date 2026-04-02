const fs = require("fs/promises");
const path = require("path");
const { loadDocxSubtitleDocument, saveDocxSubtitleDocument } = require("./docx");
const { buildSentenceGroups } = require("./grouper");
const { reviewGroupsInBatches } = require("./geminiReviewer");
const { planSubtitleGroup } = require("./segmenter");
const { loadLearningProfileForInput } = require("./styleProfile");
const { validateFinalRows } = require("./validator");
const { normalizePersianSpacing, unique } = require("./utils");

async function processSubtitleDocx(inputPath, options = {}) {
  try {
    let styleProfile = null;
    let learningError = null;
    try {
      styleProfile = await loadLearningProfileForInput(inputPath);
    } catch (error) {
      learningError = error.message || String(error);
    }
    const model = await loadDocxSubtitleDocument(inputPath);
    const grouped = buildSentenceGroups(model.rows);
    const processedGroups = grouped.map((group) => rewriteGroup(group, styleProfile));
    const maybeReviewed = await maybeRunGemini(processedGroups, options, styleProfile);
    const rewrittenRows = flattenRows(model.rows, maybeReviewed);
    const validation = validateFinalRows(model.rows, rewrittenRows, { styleProfile });

    if (!validation.valid) {
      return {
        ok: false,
        error: `Validation failed.\n${validation.reasons.join("\n")}`
      };
    }

    const outputPath = buildOutputPath(inputPath, options.outputSuffix || "_rearranged_byApp");
    await saveDocxSubtitleDocument(model, outputPath, rewrittenRows);

    const summary = buildSummary(
      model.rows,
      maybeReviewed,
      rewrittenRows,
      options,
      styleProfile,
      learningError
    );

    let reportPath = null;
    if (options.writeReport) {
      reportPath = await writeReport(outputPath, maybeReviewed, summary);
    }

    return {
      ok: true,
      outputPath,
      reportPath,
      summary,
      flaggedDetails: collectFlaggedDetails(maybeReviewed)
    };
  } catch (error) {
    return {
      ok: false,
      error: error.stack || error.message || String(error)
    };
  }
}

function rewriteGroup(group, styleProfile) {
  if (group.type !== "subtitle") {
    return {
      ...group,
      changed: false,
      flagged: false,
      ambiguous: false,
      reasons: [],
      candidatePlans: [],
      geminiAttempted: false,
      geminiCalled: false,
      geminiApplied: false,
      geminiEdited: false,
      geminiEditSuggestions: [],
      geminiModel: null,
      geminiProtectedPhrases: [],
      geminiPreferredBlockSizes: [],
      geminiPlanningAttempted: Boolean(group.geminiPlanningAttempted),
      geminiPlanningCalled: Boolean(group.geminiPlanningCalled),
      geminiPlanningApplied: Boolean(group.geminiPlanningApplied),
      geminiPlanningReasons: group.geminiPlanningReasons || [],
      geminiPlanningKeepSingleRows: group.geminiPlanningKeepSingleRows || [],
      geminiPlanningMergeWithNextRows: group.geminiPlanningMergeWithNextRows || [],
      draftRows: group.rows.map((row) => ({
        rowNumber: row.rowNumber,
        persianText: normalizePersianSpacing(row.persianText),
        strategy: "single"
      }))
    };
  }

  const planned = planSubtitleGroup(group.rows, {
    preferredBlockSizes: group.geminiPlanningPreferredBlockSizes || [],
    extraProtectedPhrases: group.geminiPlanningProtectedPhrases || [],
    preferredSingleRows: group.geminiPlanningKeepSingleRows || [],
    preferredMergeWithNextRows: group.geminiPlanningMergeWithNextRows || [],
    styleProfile,
    allowTripleRepeat: styleProfile?.repeat?.allowTripleRepeat === true
  });
  return {
    ...group,
    changed: planned.changed,
    flagged: planned.flagged,
    ambiguous: planned.ambiguous,
    reasons: planned.reasons,
    candidatePlans: planned.candidatePlans || [],
    geminiAttempted: false,
    geminiCalled: false,
    geminiApplied: false,
    geminiEdited: false,
    geminiEditSuggestions: [],
    geminiModel: null,
    geminiProtectedPhrases: group.geminiPlanningProtectedPhrases || [],
    geminiPreferredBlockSizes: group.geminiPlanningPreferredBlockSizes || [],
    geminiPlanningAttempted: Boolean(group.geminiPlanningAttempted),
    geminiPlanningCalled: Boolean(group.geminiPlanningCalled),
    geminiPlanningApplied: Boolean(group.geminiPlanningApplied),
    geminiPlanningReasons: group.geminiPlanningReasons || [],
    geminiPlanningKeepSingleRows: group.geminiPlanningKeepSingleRows || [],
    geminiPlanningMergeWithNextRows: group.geminiPlanningMergeWithNextRows || [],
    draftRows: planned.rows
  };
}

async function maybeRunGemini(groups, options, styleProfile) {
  if (options.mode !== "ai" && options.mode !== "gemini") {
    return groups;
  }

  const enriched = groups.map((group, index) => ({
    ...group,
    styleProfile,
    previousRows: groups
      .slice(Math.max(0, index - 1), index)
      .flatMap((entry) => (entry.type === "subtitle" ? entry.rows : []))
      .slice(-2),
    nextRows: groups
      .slice(index + 1, index + 2)
      .flatMap((entry) => (entry.type === "subtitle" ? entry.rows : []))
      .slice(0, 2)
  }));

  return reviewGroupsInBatches(enriched, {
    provider: options.aiProvider,
    model: options.aiModel,
    apiKey: options.apiKey,
    enableGeminiEditing: options.enableGeminiEditing !== false,
    styleProfile
  });
}

function flattenRows(originalRows, groups) {
  const rewriteMap = new Map();
  for (const group of groups) {
    for (const row of group.draftRows) {
      rewriteMap.set(row.rowNumber, normalizePersianSpacing(row.persianText));
    }
  }

  return originalRows.map((row) => ({
    rowNumber: row.rowNumber,
    persianText: rewriteMap.has(row.rowNumber)
      ? rewriteMap.get(row.rowNumber)
      : normalizePersianSpacing(row.persianText)
  }));
}

function buildOutputPath(inputPath, suffix) {
  const parsed = path.parse(inputPath);
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const timestamp = `${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
  return path.join(parsed.dir, `${parsed.name}${suffix}_${timestamp}${parsed.ext}`);
}

async function writeReport(outputPath, groups, summary = null) {
  const reportPath = outputPath.replace(/\.docx$/i, ".report.json");
  const report = {
    generatedAt: new Date().toISOString(),
    learning: summary?.learning || { enabled: false },
    ai: summary?.ai || null,
    flaggedGroups: collectFlaggedDetails(groups),
    groups: groups
      .filter((group) => group.type === "subtitle")
      .map((group) => ({
        type: group.type,
        changed: group.changed,
        flagged: group.flagged,
        ambiguous: Boolean(group.ambiguous),
        rowRange: rowRange(group.rows),
        reasons: group.reasons,
        geminiAttempted: group.geminiAttempted,
        geminiCalled: group.geminiCalled,
        geminiApplied: group.geminiApplied,
        geminiEdited: group.geminiEdited,
        geminiProvider: group.geminiProvider || null,
        geminiModel: group.geminiModel,
        geminiPlanningAttempted: Boolean(group.geminiPlanningAttempted),
        geminiPlanningCalled: Boolean(group.geminiPlanningCalled),
        geminiPlanningApplied: Boolean(group.geminiPlanningApplied),
        geminiPlanningReasons: group.geminiPlanningReasons || [],
        geminiPlanningKeepSingleRows: group.geminiPlanningKeepSingleRows || [],
        geminiPlanningMergeWithNextRows: group.geminiPlanningMergeWithNextRows || [],
        geminiProtectedPhrases: group.geminiProtectedPhrases || [],
        geminiPreferredBlockSizes: group.geminiPreferredBlockSizes || [],
        geminiEditSuggestions: group.geminiEditSuggestions || [],
        englishRows: group.rows.map((row) => row.englishText),
        originalPersianRows: group.rows.map((row) => row.persianText),
        outputPersianRows: group.draftRows.map((row) => row.persianText)
      }))
  };

  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  return reportPath;
}

function buildSummary(
  originalRows,
  groups,
  rewrittenRows,
  options = {},
  styleProfile,
  learningError = null
) {
  const subtitleGroups = groups.filter((group) => group.type === "subtitle");
  const rowsChanged = rewrittenRows.reduce((sum, row, index) => {
    return (
      sum +
      (normalizePersianSpacing(row.persianText) !==
      normalizePersianSpacing(originalRows[index].persianText)
        ? 1
        : 0)
    );
  }, 0);

  const notes = [];
  const flagged = subtitleGroups.filter((group) => group.flagged);
  const geminiAttemptedGroups = subtitleGroups.filter((group) => group.geminiAttempted).length;
  const geminiCalledGroups = subtitleGroups.filter((group) => group.geminiCalled).length;
  const geminiAppliedGroups = subtitleGroups.filter((group) => group.geminiApplied).length;
  const geminiEditedGroups = subtitleGroups.filter((group) => group.geminiEdited).length;
  const geminiPlanningCalledGroups = subtitleGroups.filter((group) => group.geminiPlanningCalled).length;
  const geminiPlanningAppliedGroups = subtitleGroups.filter((group) => group.geminiPlanningApplied).length;
  const geminiEnabled = subtitleGroups.some(
    (group) => group.geminiCalled || group.geminiApplied || group.geminiPlanningCalled || group.geminiPlanningApplied
  );
  const geminiPhraseSuggestions = subtitleGroups
    .filter((group) => Array.isArray(group.geminiProtectedPhrases) && group.geminiProtectedPhrases.length > 0)
    .map((group) => ({
      rowRange: rowRange(group.rows),
      phrases: group.geminiProtectedPhrases,
      blocks: group.geminiPreferredBlockSizes || []
    }));
  if (flagged.length > 0) {
    notes.push(
      "Some groups were left unchanged or partially conservative because they failed offline or AI validation."
    );
  }
  if (groups.some((group) => group.type === "skip")) {
    notes.push("Header rows before the first Persian subtitle row were preserved untouched.");
  }
  if (groups.some((group) => group.type === "locked")) {
    notes.push("Some locked non-subtitle rows were preserved untouched.");
  }
  if (groups.some((group) => group.type === "meta")) {
    notes.push("Detected source/meta rows were isolated from subtitle sentence planning.");
  }
  if (learningError) {
    notes.push(`Learning profile could not be loaded, so the run used fallback rules. ${learningError}`);
  }

  return {
    processedGroups: subtitleGroups.length,
    changedGroups: subtitleGroups.filter((group) => group.changed).length,
    unchangedGroups: subtitleGroups.filter((group) => !group.changed).length,
    flaggedGroups: flagged.length,
    rowsChanged,
    rowsWritten: rewrittenRows.length,
    ai: {
      requested: options.mode === "ai" || options.mode === "gemini",
      enabled: geminiEnabled,
      provider:
        subtitleGroups.find((group) => group.geminiModel)?.geminiProvider ||
        (options.mode === "ai" || options.mode === "gemini"
          ? options.aiProvider || "gemini"
          : null),
      model:
        subtitleGroups.find((group) => group.geminiModel)?.geminiModel ||
        (options.mode === "ai" || options.mode === "gemini"
          ? options.aiModel || (options.aiProvider === "openai" ? "gpt-5.2" : "gemini-2.5-flash-lite")
          : null),
      attemptedGroups: geminiAttemptedGroups,
      calledGroups: geminiCalledGroups,
      appliedGroups: geminiAppliedGroups,
      editedGroups: geminiEditedGroups,
      planningCalledGroups: geminiPlanningCalledGroups,
      planningAppliedGroups: geminiPlanningAppliedGroups,
      failedGroups: geminiCalledGroups - geminiAppliedGroups,
      phraseSuggestions: geminiPhraseSuggestions
    },
    learning: buildLearningSummary(styleProfile),
    notes
  };
}

function rowRange(rows) {
  if (rows.length === 0) {
    return "";
  }

  const first = rows[0].rowNumber;
  const last = rows[rows.length - 1].rowNumber;
  return first === last ? String(first) : `${first}-${last}`;
}

function collectFlaggedDetails(groups) {
  return groups
    .filter((group) => group.flagged)
    .map((group) => ({
      rowRange: rowRange(group.rows),
      reasons: unique(group.reasons)
    }));
}

function buildLearningSummary(styleProfile) {
  if (!styleProfile?.constraints?.overall) {
    return {
      enabled: false
    };
  }

  return {
    enabled: true,
    profileId: styleProfile.profileId || "default",
    datasetItemCount: styleProfile.datasetItemCount || 0,
    preferredCharRange: `${styleProfile.constraints.overall.preferredCharMin}-${styleProfile.constraints.overall.preferredCharMax}`,
    hardCharLimit: styleProfile.constraints.overall.hardCharMax,
    preferredWordMax: styleProfile.constraints.overall.preferredWordMax,
    allowTripleRepeat: Boolean(styleProfile.repeat?.allowTripleRepeat),
    repeatTwoRate: styleProfile.repeat?.rates?.["2"] || 0,
    titleDateMergeRate: styleProfile.titleDate?.mergeRate || 0
  };
}

module.exports = {
  processSubtitleDocx
};
