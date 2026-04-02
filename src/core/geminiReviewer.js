const { planHasProtectedBoundarySplit, planSubtitleGroup } = require("./segmenter");
const { validateLineText } = require("./validator");
const {
  classifyEnglishRowType,
  countWords,
  normalizePersianSpacing,
  safeJsonParse,
  unique
} = require("./utils");

const DEFAULT_MODELS = {
  gemini: "gemini-2.5-flash-lite",
  openai: "gpt-5.2"
};
const MAX_CANDIDATE_PLANS = 5;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getProvider(options = {}) {
  return options.provider === "openai" ? "openai" : "gemini";
}

function getDefaultModel(provider) {
  return DEFAULT_MODELS[provider] || DEFAULT_MODELS.gemini;
}

function getApiKeyForProvider(provider, options = {}) {
  if (options.apiKey) {
    return options.apiKey;
  }

  return provider === "openai" ? process.env.OPENAI_API_KEY : process.env.GEMINI_API_KEY;
}

function parseQuotaErrorDetails(message) {
  const text = String(message || "");
  const retryMatch = text.match(/retry in ([\d.]+)s/i);
  const retryMs = retryMatch ? Math.ceil(Number.parseFloat(retryMatch[1]) * 1000) : null;
  const quotaType = /PerMinute/i.test(text)
    ? "minute"
    : /PerDay/i.test(text)
      ? "day"
      : null;

  return {
    isQuotaError: /RESOURCE_EXHAUSTED|429/.test(text),
    quotaType,
    retryMs,
    message: text
  };
}

async function generateGeminiContent(client, request, state = {}) {
  if (state.nextAllowedAt && state.nextAllowedAt > Date.now()) {
    await delay(state.nextAllowedAt - Date.now());
  }

  try {
    return await client.models.generateContent(request);
  } catch (error) {
    const quota = parseQuotaErrorDetails(error.message || String(error));
    if (quota.isQuotaError && quota.quotaType === "minute" && quota.retryMs) {
      state.nextAllowedAt = Date.now() + quota.retryMs + 500;
      await delay(quota.retryMs + 500);
      state.nextAllowedAt = 0;
      return generateGeminiContent(client, request, state);
    }

    if (quota.isQuotaError && quota.quotaType === "day") {
      state.disabledReason = quota.message;
    }

    throw error;
  }
}

function extractOpenAIText(responseBody) {
  if (typeof responseBody?.output_text === "string" && responseBody.output_text.trim()) {
    return responseBody.output_text;
  }

  const output = Array.isArray(responseBody?.output) ? responseBody.output : [];
  const parts = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const entry of content) {
      if (typeof entry?.text === "string" && entry.text.trim()) {
        parts.push(entry.text);
      }
    }
  }

  return parts.join("\n").trim();
}

async function generateOpenAIContent(client, request, state = {}) {
  if (state.nextAllowedAt && state.nextAllowedAt > Date.now()) {
    await delay(state.nextAllowedAt - Date.now());
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${client.apiKey}`
    },
    body: JSON.stringify({
      model: request.model,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: request.contents
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: request.schemaName,
          strict: true,
          schema: request.schema
        }
      }
    })
  });

  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      responseBody?.error?.message ||
      `OpenAI request failed with status ${response.status}`;
    const retryAfterHeader = response.headers.get("retry-after");
    const retryMs = retryAfterHeader ? Number.parseFloat(retryAfterHeader) * 1000 : null;

    if (response.status === 429 && retryMs && retryMs > 0) {
      state.nextAllowedAt = Date.now() + retryMs + 500;
      await delay(retryMs + 500);
      state.nextAllowedAt = 0;
      return generateOpenAIContent(client, request, state);
    }

    if (response.status === 429 && /per day|daily|quota/i.test(message)) {
      state.disabledReason = message;
    }

    throw new Error(message);
  }

  return {
    text: extractOpenAIText(responseBody)
  };
}

async function generateStructuredContent(client, request, state = {}) {
  if (client.provider === "openai") {
    return generateOpenAIContent(client, request, state);
  }

  return generateGeminiContent(client.sdkClient, {
    model: request.model,
    contents: request.contents,
    config: {
      temperature: request.temperature,
      responseMimeType: "application/json",
      responseSchema: request.schema
    }
  }, state);
}

function buildClient(provider, apiKey) {
  if (provider === "openai") {
    return {
      provider,
      apiKey
    };
  }

  let GoogleGenAI;
  ({ GoogleGenAI } = require("@google/genai"));
  return {
    provider,
    apiKey,
    sdkClient: new GoogleGenAI({ apiKey })
  };
}

async function reviewFlaggedGroup(group, options = {}) {
  const provider = getProvider(options);
  const apiKey = getApiKeyForProvider(provider, options);
  if (!apiKey) {
    return {
      applied: false,
      called: false,
      reasons: [`${provider === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY"} is not set`],
      edited: false
    };
  }

  try {
    const client = buildClient(provider, apiKey);
    const reviewState = {
      applied: false,
      called: false,
      rows: group.draftRows.map((row) => ({ ...row })),
      protectedPhrases: [],
      preferredBlockSizes: [],
      reasons: [],
      edited: false,
      editSuggestions: []
    };

    const providerOptions = {
      ...options,
      provider,
      model: options.model || getDefaultModel(provider)
    };

    const layoutResult = await reviewLayoutWithGemini(client, group, providerOptions);
    reviewState.called = reviewState.called || layoutResult.called;
    reviewState.reasons.push(...(layoutResult.reasons || []));
    if (layoutResult.applied) {
      reviewState.applied = true;
      reviewState.rows = layoutResult.rows.map((row) => ({ ...row }));
      reviewState.protectedPhrases = layoutResult.protectedPhrases || [];
      reviewState.preferredBlockSizes = layoutResult.preferredBlockSizes || [];
    }

    if (shouldAttemptGeminiEdit(group, providerOptions)) {
      const editResult = await reviewEditedRowsWithGemini(client, group, reviewState.rows, providerOptions, {
        protectedPhrases: reviewState.protectedPhrases
      });
      reviewState.called = reviewState.called || editResult.called;
      reviewState.reasons.push(...(editResult.reasons || []));
      if (editResult.applied) {
        reviewState.applied = true;
        reviewState.rows = editResult.rows.map((row) => ({ ...row }));
        reviewState.protectedPhrases = unique([
          ...reviewState.protectedPhrases,
          ...(editResult.protectedPhrases || [])
        ]);
        reviewState.edited = true;
        reviewState.editSuggestions = editResult.editSuggestions || [];
      }
    }

    reviewState.reasons = unique(reviewState.reasons);
    return reviewState;
  } catch (error) {
    return {
      applied: false,
      called: false,
      reasons: [`${provider === "openai" ? "OpenAI" : "Gemini"} client is not available: ${error.message}`],
      edited: false
    };
  }
}

async function fetchPlanningHintsForGroup(group, options = {}) {
  const provider = getProvider(options);
  const apiKey = getApiKeyForProvider(provider, options);
  if (!apiKey) {
    return {
      applied: false,
      called: false,
      reasons: [`${provider === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY"} is not set`],
      protectedPhrases: [],
      preferredBlockSizes: [],
      keepSingleRows: [],
      mergeWithNextRows: []
    };
  }

  try {
    const client = buildClient(provider, apiKey);
    const response = await generateStructuredContent(
      client,
      {
        model: options.model || getDefaultModel(provider),
        contents: buildPlannerPrompt(group),
        schemaName: "subtitle_planner",
        schema: buildPlannerSchema(),
        temperature: 0.2
      },
      options.rateLimitState
    );

    return applyPlanningHintResult(group, safeJsonParse(response.text));
  } catch (error) {
    return {
      applied: false,
      called: false,
      reasons: [`${provider === "openai" ? "OpenAI" : "Gemini"} client is not available: ${error.message}`],
      protectedPhrases: [],
      preferredBlockSizes: [],
      keepSingleRows: [],
      mergeWithNextRows: []
    };
  }
}

async function reviewLayoutWithGemini(client, group, options = {}) {
  const provider = getProvider(options);
  const hasRankableCandidates = Array.isArray(group.candidatePlans) && group.candidatePlans.length >= 2;
  const prompt = hasRankableCandidates
    ? buildCandidateRankingPrompt(group)
    : buildPlannerPrompt(group);

  try {
    const response = await generateStructuredContent(client, {
      model: options.model || getDefaultModel(provider),
      contents: prompt,
      schemaName: hasRankableCandidates ? "subtitle_candidate_ranker" : "subtitle_layout_planner",
      schema: hasRankableCandidates ? buildCandidateRankingSchema() : buildPlannerSchema(),
      temperature: 0.2
    }, options.rateLimitState);

    const parsed = safeJsonParse(response.text);
    if (hasRankableCandidates) {
      return applyCandidateRankingResult(group, parsed, options);
    }

    if (!parsed || !Array.isArray(parsed.preferredBlockSizes) || !Array.isArray(parsed.protectedPhrases)) {
      return {
        applied: false,
        called: true,
        reasons: ["Gemini returned invalid planning JSON"]
      };
    }

    const rowCount = group.rows.length;
    if (
      parsed.preferredBlockSizes.reduce((sum, size) => sum + size, 0) !== rowCount ||
      parsed.preferredBlockSizes.some((size) => !Number.isInteger(size) || size < 1 || size > 3)
    ) {
      return {
        applied: false,
        called: true,
        reasons: ["Gemini returned invalid row-group sizes"]
      };
    }

    const planned = planSubtitleGroup(group.rows, {
      preferredBlockSizes: parsed.preferredBlockSizes,
      extraProtectedPhrases: parsed.protectedPhrases,
      styleProfile: options.styleProfile,
      allowTripleRepeat: options.styleProfile?.repeat?.allowTripleRepeat === true
    });

    if (planned.flagged) {
      return {
        applied: false,
        called: true,
        reasons: ["Gemini planning hints still could not produce a valid local arrangement"]
      };
    }

    return {
      applied: true,
      called: true,
      rows: planned.rows,
      protectedPhrases: parsed.protectedPhrases,
      preferredBlockSizes: parsed.preferredBlockSizes,
      reasons: []
    };
  } catch (error) {
    return {
      applied: false,
      called: true,
      reasons: [error.message]
    };
  }
}

function applyPlanningHintResult(group, parsed) {
  if (
    !parsed ||
    !Array.isArray(parsed.protectedPhrases) ||
    !Array.isArray(parsed.preferredBlockSizes) ||
    !Array.isArray(parsed.keepSingleRows) ||
    !Array.isArray(parsed.mergeWithNextRows)
  ) {
    return {
      applied: false,
      called: true,
      reasons: ["Gemini returned invalid planning JSON"],
      protectedPhrases: [],
      preferredBlockSizes: [],
      keepSingleRows: [],
      mergeWithNextRows: []
    };
  }

  const rowCount = group.rows?.length || 0;
  const validRowNumbers = new Set((group.rows || []).map((row) => row.rowNumber));
  const preferredBlockSizes = parsed.preferredBlockSizes.filter((size) => Number.isInteger(size));
  const blockSizesAreUsable =
    preferredBlockSizes.length > 0 &&
    preferredBlockSizes.every((size) => size >= 1 && size <= 3) &&
    preferredBlockSizes.reduce((sum, size) => sum + size, 0) === rowCount;

  const protectedPhrases = parsed.protectedPhrases
    .map((phrase) => normalizePersianSpacing(phrase))
    .filter(Boolean);
  const keepSingleRows = parsed.keepSingleRows.filter((rowNumber) => validRowNumbers.has(rowNumber));
  const mergeWithNextRows = parsed.mergeWithNextRows.filter((rowNumber) => validRowNumbers.has(rowNumber));

  if (!blockSizesAreUsable && protectedPhrases.length === 0 && keepSingleRows.length === 0 && mergeWithNextRows.length === 0) {
    return {
      applied: false,
      called: true,
      reasons: ["Gemini planning hints were unusable"],
      protectedPhrases: [],
      preferredBlockSizes: [],
      keepSingleRows: [],
      mergeWithNextRows: []
    };
  }

  return {
    applied: true,
    called: true,
    reasons: [],
    protectedPhrases,
    preferredBlockSizes: blockSizesAreUsable ? preferredBlockSizes : [],
    keepSingleRows,
    mergeWithNextRows
  };
}

async function reviewEditedRowsWithGemini(client, group, baseRows, options = {}, context = {}) {
  const provider = getProvider(options);
  try {
    const response = await generateStructuredContent(client, {
      model: options.model || getDefaultModel(provider),
      contents: buildEditingPrompt(group, baseRows, context),
      schemaName: "subtitle_editor",
      schema: buildEditingSchema(),
      temperature: 0.35
    }, options.rateLimitState);

    return applyEditedRowsResult(group, baseRows, safeJsonParse(response.text), options);
  } catch (error) {
    return {
      applied: false,
      called: true,
      edited: false,
      reasons: [error.message],
      editSuggestions: []
    };
  }
}

function buildPlannerSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      preferredBlockSizes: {
        type: "array",
        items: { type: "integer" }
      },
      keepSingleRows: {
        type: "array",
        items: { type: "integer" }
      },
      mergeWithNextRows: {
        type: "array",
        items: { type: "integer" }
      },
      protectedPhrases: {
        type: "array",
        items: { type: "string" }
      }
    },
    required: ["preferredBlockSizes", "keepSingleRows", "mergeWithNextRows", "protectedPhrases"]
  };
}

function buildCandidateRankingSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      selectedCandidateIndex: {
        type: "integer"
      },
      protectedPhrases: {
        type: "array",
        items: { type: "string" }
      },
      rationale: {
        type: "string"
      }
    },
    required: ["selectedCandidateIndex", "protectedPhrases"]
  };
}

function buildEditingSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      editedRows: {
        type: "array",
        items: { type: "string" }
      },
      protectedPhrases: {
        type: "array",
        items: { type: "string" }
      },
      suggestions: {
        type: "array",
        items: { type: "string" }
      }
    },
    required: ["editedRows", "protectedPhrases"]
  };
}

function buildBatchReviewSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      groups: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            rowRange: { type: "string" },
            protectedPhrases: {
              type: "array",
              items: { type: "string" }
            },
            preferredBlockSizes: {
              type: "array",
              items: { type: "integer" }
            },
            keepSingleRows: {
              type: "array",
              items: { type: "integer" }
            },
            mergeWithNextRows: {
              type: "array",
              items: { type: "integer" }
            },
            selectedCandidateIndex: {
              type: ["integer", "null"]
            },
            editedRows: {
              type: ["array", "null"],
              items: { type: "string" }
            },
            suggestions: {
              type: "array",
              items: { type: "string" }
            },
            rationale: { type: "string" }
          },
          required: [
            "rowRange",
            "protectedPhrases",
            "preferredBlockSizes",
            "keepSingleRows",
            "mergeWithNextRows",
            "selectedCandidateIndex",
            "editedRows",
            "suggestions"
          ]
        }
      }
    },
    required: ["groups"]
  };
}

function applyCandidateRankingResult(group, parsed, options = {}) {
  if (
    !parsed ||
    !Number.isInteger(parsed.selectedCandidateIndex) ||
    !Array.isArray(parsed.protectedPhrases)
  ) {
    return {
      applied: false,
      called: true,
      reasons: ["Gemini returned invalid candidate-ranking JSON"]
    };
  }

  const candidate = group.candidatePlans?.[parsed.selectedCandidateIndex];
  if (!candidate || !Array.isArray(candidate.rows) || candidate.rows.length !== group.rows.length) {
    return {
      applied: false,
      called: true,
      reasons: ["Gemini selected an out-of-range candidate layout"]
    };
  }

  const bestCandidate = group.candidatePlans?.[0] || null;
  const selectedStylePenalty = candidate.score?.stylePenalty || 0;
  const bestStylePenalty = bestCandidate?.score?.stylePenalty || 0;
  const selectedBlockCount = candidate.score?.blockCount || 0;
  const bestBlockCount = bestCandidate?.score?.blockCount || 0;
  if (
    bestCandidate &&
    parsed.selectedCandidateIndex !== 0 &&
    (selectedStylePenalty > bestStylePenalty + 2 ||
      (selectedStylePenalty > bestStylePenalty && selectedBlockCount > bestBlockCount))
  ) {
    return {
      applied: false,
      called: true,
      reasons: ["Gemini selected a materially worse local candidate than the planner's best layout"]
    };
  }

  if (
    parsed.protectedPhrases.length > 0 &&
    planSubtitleGroup(group.rows, {
      preferredBlockSizes: candidate.blocks.map((block) => block.rowNumbers.length),
      extraProtectedPhrases: parsed.protectedPhrases,
      styleProfile: options.styleProfile,
      allowTripleRepeat: options.styleProfile?.repeat?.allowTripleRepeat === true
    }).flagged
  ) {
    return {
      applied: false,
      called: true,
      reasons: ["Gemini chose a candidate that became invalid after protected-phrase validation"]
    };
  }

  return {
    applied: true,
    called: true,
    rows: candidate.rows.map((row) => ({ ...row })),
    protectedPhrases: parsed.protectedPhrases,
    preferredBlockSizes: candidate.blocks.map((block) => block.rowNumbers.length),
    reasons: parsed.rationale ? [parsed.rationale] : []
  };
}

function applyEditedRowsResult(group, baseRows, parsed, options = {}) {
  if (!parsed || !Array.isArray(parsed.editedRows) || !Array.isArray(parsed.protectedPhrases)) {
    return {
      applied: false,
      called: true,
      edited: false,
      reasons: ["Gemini returned invalid editing JSON"],
      editSuggestions: []
    };
  }

  if (parsed.editedRows.length !== group.rows.length) {
    return {
      applied: false,
      called: true,
      edited: false,
      reasons: ["Gemini returned the wrong number of edited rows"],
      editSuggestions: []
    };
  }

  const rows = parsed.editedRows.map((text, index) => ({
    rowNumber: group.rows[index].rowNumber,
    persianText: normalizePersianSpacing(text),
    strategy: baseRows[index]?.strategy || "single"
  }));

  for (let index = 0; index < rows.length; index += 1) {
    const verdict = validateLineText(rows[index].persianText, {
      styleProfile: options.styleProfile,
      rowContext: {
        englishText: group.rows[index].englishText,
        rowType: classifyEnglishRowType(group.rows[index].englishText)
      }
    });
    if (!verdict.valid) {
      return {
        applied: false,
        called: true,
        edited: false,
        reasons: [`Gemini edited row ${group.rows[index].rowNumber} but it failed local validation`],
        editSuggestions: []
      };
    }

    rows[index].persianText = verdict.normalized;
  }

  if (
    parsed.protectedPhrases.length > 0 &&
    planHasProtectedBoundarySplit(rows, {
      extraProtectedPhrases: parsed.protectedPhrases
    })
  ) {
    return {
      applied: false,
      called: true,
      edited: false,
      reasons: ["Gemini edited rows split a protected phrase across a row boundary"],
      editSuggestions: []
    };
  }

  return {
    applied: true,
    called: true,
    edited: true,
    rows,
    protectedPhrases: parsed.protectedPhrases,
    reasons: [],
    editSuggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : []
  };
}

function rowRangeOfGroup(group) {
  const first = group.rows?.[0]?.rowNumber;
  const last = group.rows?.[group.rows.length - 1]?.rowNumber;
  if (!first || !last) {
    return "";
  }
  return first === last ? String(first) : `${first}-${last}`;
}

function shouldBatchReviewGroup(group) {
  return group.type === "subtitle" && group.rows.length >= 2;
}

function buildBatchReviewPrompt(groups) {
  const payload = groups.map((group) => ({
    rowRange: rowRangeOfGroup(group),
    englishRows: group.rows.map((row) => row.englishText),
    englishRowTypes: group.rows.map((row) => classifyEnglishRowType(row.englishText)),
    originalPersianRows: group.rows.map((row) => row.persianText),
    mergedPersianText: normalizePersianSpacing(group.rows.map((row) => row.persianText).join(" ")),
    currentDraftRows: group.draftRows.map((row) => row.persianText),
    currentBlockSizes: Array.isArray(group.geminiPreferredBlockSizes) && group.geminiPreferredBlockSizes.length > 0
      ? group.geminiPreferredBlockSizes
      : group.candidatePlans?.[0]?.blocks?.map((block) => block.rowNumbers.length) || [],
    candidateLayouts: (group.candidatePlans || []).slice(0, MAX_CANDIDATE_PLANS).map((candidate, index) => ({
      index,
      blockSizes: candidate.blocks.map((block) => block.rowNumbers.length),
      rows: candidate.rows.map((row) => row.persianText)
    })),
    learnedStyle: buildLearningSummary(group),
    protectedPhraseHints: extractProtectedPhraseHints(group)
  }));

  return [
    "You are reviewing multiple Persian subtitle groups in one batch.",
    'Return JSON only in the exact form {"groups":[...]} matching the provided groups by rowRange.',
    "Treat each group as one merged Persian sentence first, not as fixed original row splits.",
    "For each group you may provide:",
    "- protectedPhrases: Persian phrases or names that must stay together.",
    "- preferredBlockSizes: contiguous block sizes summing to the row count, each 1 to 3.",
    "- keepSingleRows: row numbers that should stay single if possible.",
    "- mergeWithNextRows: row numbers that should merge forward if possible.",
    "- selectedCandidateIndex: choose one of the provided candidate layouts if one is best, otherwise null.",
    "- editedRows: optional full-row Persian rewrite using the exact same row count, otherwise null.",
    "- suggestions: optional short notes.",
    "Goals:",
    "- Prefer natural Persian meaning and sentence flow.",
    "- First identify meaningful Persian phrases, compounds, and protected spans that should stay together.",
    "- Ignore the old Persian row breaks when planning; rebuild the best split from the merged sentence.",
    "- Use English row length as a timing hint: shorter English rows can carry repeated merged Persian blocks, while longer English rows can hold longer single lines.",
    "- Use wider token context to make fewer requests.",
    "- Keep source/meta rows separate from narration.",
    "- Keep names, fixed phrases, compounds, and noun-adjective units together.",
    "- You may improve the Persian translation, not just rearrange it, but keep the English meaning intact.",
    "",
    "Batch groups:",
    JSON.stringify(payload)
  ].join("\n");
}

function applyBatchReviewDecision(group, decision, options = {}) {
  let nextGroup = { ...group };
  const reasons = [];

  if (decision) {
    const planningResult = applyPlanningHintResult(group, {
      protectedPhrases: decision.protectedPhrases || [],
      preferredBlockSizes: decision.preferredBlockSizes || [],
      keepSingleRows: decision.keepSingleRows || [],
      mergeWithNextRows: decision.mergeWithNextRows || []
    });

    nextGroup = {
      ...nextGroup,
      geminiPlanningAttempted: true,
      geminiPlanningCalled: true,
      geminiPlanningApplied: planningResult.applied,
      geminiPlanningReasons: planningResult.reasons || [],
      geminiPlanningProtectedPhrases: planningResult.protectedPhrases || [],
      geminiPlanningPreferredBlockSizes: planningResult.preferredBlockSizes || [],
      geminiPlanningKeepSingleRows: planningResult.keepSingleRows || [],
      geminiPlanningMergeWithNextRows: planningResult.mergeWithNextRows || []
    };

    if (planningResult.applied) {
      const replanned = planSubtitleGroup(group.rows, {
        preferredBlockSizes: planningResult.preferredBlockSizes || [],
        extraProtectedPhrases: planningResult.protectedPhrases || [],
        preferredSingleRows: planningResult.keepSingleRows || [],
        preferredMergeWithNextRows: planningResult.mergeWithNextRows || [],
        styleProfile: options.styleProfile,
        allowTripleRepeat: options.styleProfile?.repeat?.allowTripleRepeat === true
      });

      if (!replanned.flagged) {
        nextGroup = {
          ...nextGroup,
          draftRows: replanned.rows,
          candidatePlans: replanned.candidatePlans || nextGroup.candidatePlans,
          geminiProtectedPhrases: planningResult.protectedPhrases || [],
          geminiPreferredBlockSizes: planningResult.preferredBlockSizes || [],
          flagged: replanned.flagged,
          ambiguous: replanned.ambiguous,
          changed: replanned.changed,
          reasons: replanned.reasons || []
        };
      }
    }

    if (Number.isInteger(decision.selectedCandidateIndex)) {
      const rankingResult = applyCandidateRankingResult(nextGroup, {
        selectedCandidateIndex: decision.selectedCandidateIndex,
        protectedPhrases: decision.protectedPhrases || [],
        rationale: decision.rationale || ""
      }, options);

      reasons.push(...(rankingResult.reasons || []));
      if (rankingResult.applied) {
        nextGroup = {
          ...nextGroup,
          draftRows: rankingResult.rows.map((row) => ({ ...row })),
          geminiProtectedPhrases: unique([
            ...(nextGroup.geminiProtectedPhrases || []),
            ...(rankingResult.protectedPhrases || [])
          ]),
          geminiPreferredBlockSizes: rankingResult.preferredBlockSizes || nextGroup.geminiPreferredBlockSizes || []
        };
      }
    }

    if (Array.isArray(decision.editedRows) && decision.editedRows.length > 0) {
      const editResult = applyEditedRowsResult(
        nextGroup,
        nextGroup.draftRows,
        {
          editedRows: decision.editedRows,
          protectedPhrases: decision.protectedPhrases || [],
          suggestions: decision.suggestions || []
        },
        options
      );

      reasons.push(...(editResult.reasons || []));
      if (editResult.applied) {
        nextGroup = {
          ...nextGroup,
          draftRows: editResult.rows.map((row) => ({ ...row })),
          geminiEdited: true,
          geminiEditSuggestions: editResult.editSuggestions || [],
          geminiProtectedPhrases: unique([
            ...(nextGroup.geminiProtectedPhrases || []),
            ...(editResult.protectedPhrases || [])
          ])
        };
      }
    }
  } else {
    reasons.push("AI batch response did not include this group");
  }

  return {
    ...nextGroup,
    geminiAttempted: true,
    geminiCalled: true,
    geminiApplied:
      (Boolean(decision) && (
      Boolean(nextGroup.geminiPlanningApplied) ||
      Boolean(nextGroup.geminiEdited) ||
      reasons.length === 0)),
    geminiProvider: getProvider(options),
    geminiModel: options.model || getDefaultModel(getProvider(options)),
    reasons: unique([...(nextGroup.reasons || []), ...reasons])
  };
}

async function reviewGroupsInBatches(groups, options = {}) {
  const provider = getProvider(options);
  const apiKey = getApiKeyForProvider(provider, options);
  if (!apiKey) {
    return groups;
  }

  const client = buildClient(provider, apiKey);
  const rateLimitState = {
    nextAllowedAt: 0,
    disabledReason: null
  };
  const batchSize = 8;
  const reviewed = [];

  for (let index = 0; index < groups.length; index += batchSize) {
    const batch = groups.slice(index, index + batchSize);
    const eligible = batch.filter(shouldBatchReviewGroup);
    if (eligible.length === 0 || rateLimitState.disabledReason) {
      reviewed.push(...batch);
      continue;
    }

    try {
      const response = await generateStructuredContent(client, {
        model: options.model || getDefaultModel(provider),
        contents: buildBatchReviewPrompt(eligible),
        schemaName: "subtitle_batch_review",
        schema: buildBatchReviewSchema(),
        temperature: 0.3
      }, rateLimitState);
      const parsed = safeJsonParse(response.text);
      const decisions = Array.isArray(parsed?.groups) ? parsed.groups : [];
      const byRange = new Map(decisions.map((decision) => [decision.rowRange, decision]));

      for (const group of batch) {
        if (!shouldBatchReviewGroup(group)) {
          reviewed.push(group);
          continue;
        }
        reviewed.push(applyBatchReviewDecision(group, byRange.get(rowRangeOfGroup(group)) || null, options));
      }
    } catch (error) {
      for (const group of batch) {
        if (!shouldBatchReviewGroup(group)) {
          reviewed.push(group);
          continue;
        }
        reviewed.push({
          ...group,
          geminiAttempted: true,
          geminiCalled: true,
          geminiApplied: false,
          geminiEdited: false,
          geminiProvider: provider,
          geminiModel: options.model || getDefaultModel(provider),
          reasons: unique([...(group.reasons || []), error.message])
        });
      }
    }
  }

  return reviewed;
}

function buildLearningSummary(group) {
  if (!group.styleProfile?.constraints?.overall) {
    return null;
  }

  return {
    profileId: group.styleProfile.profileId || "default",
    datasetItemCount: group.styleProfile.datasetItemCount,
    preferredCharRange: [
      group.styleProfile.constraints.overall.preferredCharMin,
      group.styleProfile.constraints.overall.preferredCharMax
    ],
    hardCharLimit: group.styleProfile.constraints.overall.hardCharMax,
    preferredWordMax: group.styleProfile.constraints.overall.preferredWordMax,
    repeatRates: group.styleProfile.repeat?.rates || {},
    titleDateMergeRate: group.styleProfile.titleDate?.mergeRate || 0
  };
}

function buildPlannerPrompt(group) {
  const protectedPhrases = extractProtectedPhraseHints(group);
  const previousEnglish = group.previousRows?.map((row) => row.englishText) || [];
  const nextEnglish = group.nextRows?.map((row) => row.englishText) || [];
  const rowTypes = group.rows.map((row) => classifyEnglishRowType(row.englishText));

  return [
    "You are planning Persian subtitle row arrangement and tokenizer protection.",
    'Return JSON only in the exact form {"preferredBlockSizes":[...],"keepSingleRows":[...],"mergeWithNextRows":[...],"protectedPhrases":[...]}',
    "Treat the subtitle group as one merged Persian sentence first, then decide the best split across rows.",
    "Hard rules:",
    "- Preserve the exact number of rows.",
    "- preferredBlockSizes must be contiguous row-group lengths whose sum equals the row count.",
    "- Each preferred block size must be 1, 2, or 3.",
    "- keepSingleRows must contain row numbers that should stay alone if possible.",
    "- mergeWithNextRows must contain row numbers whose text should merge forward with the next row if possible.",
    "- Prefer grouping rows so short Persian fragments merge naturally.",
    "- Ignore the original Persian row splitting as much as possible; rebuild the best layout from the merged sentence.",
    "- protectedPhrases must list Persian fixed expressions, meaningful phrases, compounds, noun-adjective units, or proper names that must stay together.",
    "- Use English row length as a timing hint when deciding which rows should carry repeated merged Persian text versus single longer lines.",
    "- Preserve semantic consistency across the full sentence group, not row-by-row literal matching.",
    "- Keep source/meta rows, URLs, and bracketed attribution separate from normal subtitle text whenever possible.",
    "- Include names like کریستف کلمب and phrases like در پی when they should never be split.",
    "- If the safest plan needs no special protection, return an empty protectedPhrases array.",
    "",
    "Previous English context:",
    JSON.stringify(previousEnglish),
    "",
    `English rows (${group.rows.length}):`,
    JSON.stringify(group.rows.map((row) => ({ rowNumber: row.rowNumber, englishText: row.englishText }))),
    "",
    "English row types:",
    JSON.stringify(rowTypes),
    "",
    "Next English context:",
    JSON.stringify(nextEnglish),
    "",
    "Original Persian rows:",
    JSON.stringify(group.rows.map((row) => ({ rowNumber: row.rowNumber, persianText: row.persianText }))),
    "",
    "Merged Persian text for the full group:",
    JSON.stringify(normalizePersianSpacing(group.rows.map((row) => row.persianText).join(" "))),
    "",
    "Offline draft rows:",
    JSON.stringify(group.draftRows.map((row) => row.persianText)),
    "",
    "Learned style summary:",
    JSON.stringify(buildLearningSummary(group)),
    "",
    "Protected phrase hints:",
    JSON.stringify(protectedPhrases)
  ].join("\n");
}

function buildCandidateRankingPrompt(group) {
  const protectedPhrases = extractProtectedPhraseHints(group);
  const previousEnglish = group.previousRows?.map((row) => row.englishText) || [];
  const nextEnglish = group.nextRows?.map((row) => row.englishText) || [];
  const rowTypes = group.rows.map((row) => classifyEnglishRowType(row.englishText));
  const candidates = group.candidatePlans.slice(0, MAX_CANDIDATE_PLANS).map((candidate, index) => ({
    index,
    blockSizes: candidate.blocks.map((block) => block.rowNumbers.length),
    rows: candidate.rows.map((row) => row.persianText)
  }));

  return [
    "You are ranking Persian subtitle layout candidates for one sentence group.",
    'Return JSON only in the exact form {"selectedCandidateIndex":0,"protectedPhrases":[...],"rationale":"..."}',
    "Hard rules:",
    "- Pick exactly one candidate index from the provided candidates.",
    "- Do not invent a new layout outside the candidate list.",
    "- protectedPhrases must list Persian expressions or names that should stay together.",
    "- Rank by Persian naturalness, meaning consistency, and avoiding awkward unfinished fragments.",
    "- Prefer candidates that merge smoothly across commas or connectors when the sentence clearly continues.",
    "- Prefer keeping source/meta rows, URLs, and bracketed attribution separate from normal subtitle narration.",
    "- Keep full-sentence flow in mind, not just the first rows.",
    "",
    "Previous English context:",
    JSON.stringify(previousEnglish),
    "",
    `English rows (${group.rows.length}):`,
    JSON.stringify(group.rows.map((row) => row.englishText)),
    "",
    "English row types:",
    JSON.stringify(rowTypes),
    "",
    "Next English context:",
    JSON.stringify(nextEnglish),
    "",
    "Original Persian rows:",
    JSON.stringify(group.rows.map((row) => row.persianText)),
    "",
    "Current offline draft rows:",
    JSON.stringify(group.draftRows.map((row) => row.persianText)),
    "",
    "Candidate layouts:",
    JSON.stringify(candidates),
    "",
    "Learned style summary:",
    JSON.stringify(buildLearningSummary(group)),
    "",
    "Protected phrase hints:",
    JSON.stringify(protectedPhrases)
  ].join("\n");
}

function buildEditingPrompt(group, baseRows, context = {}) {
  const rowTypes = group.rows.map((row) => classifyEnglishRowType(row.englishText));
  const previousEnglish = group.previousRows?.map((row) => row.englishText) || [];
  const nextEnglish = group.nextRows?.map((row) => row.englishText) || [];

  return [
    "You are editing Persian subtitle rows in a style-aware, conservative way.",
    'Return JSON only in the exact form {"editedRows":[...],"protectedPhrases":[...],"suggestions":[...]}',
    "Hard rules:",
    "- Preserve the exact number of rows.",
    "- editedRows must have exactly one Persian subtitle string for each row.",
    "- Keep names, fixed phrases, and compounds together when possible.",
    "- You may smooth or improve the Persian translation, not just rearrange it, but keep the English meaning intact.",
    "- Prefer natural broadcast-style Persian, not literal awkward wording.",
    "- Keep source/meta rows and URLs separate from narration.",
    "- Do not leave a row blank unless the current draft row is blank.",
    "- Keep each row concise enough to fit the local validator after editing.",
    "",
    "Previous English context:",
    JSON.stringify(previousEnglish),
    "",
    `English rows (${group.rows.length}):`,
    JSON.stringify(group.rows.map((row) => row.englishText)),
    "",
    "English row types:",
    JSON.stringify(rowTypes),
    "",
    "Next English context:",
    JSON.stringify(nextEnglish),
    "",
    "Original Persian rows:",
    JSON.stringify(group.rows.map((row) => row.persianText)),
    "",
    "Current safe draft rows:",
    JSON.stringify(baseRows.map((row) => row.persianText)),
    "",
    "Protected phrase hints:",
    JSON.stringify(unique([...(context.protectedPhrases || []), ...extractProtectedPhraseHints(group)])),
    "",
    "Learned style summary:",
    JSON.stringify(buildLearningSummary(group))
  ].join("\n");
}

function extractProtectedPhraseHints(group) {
  const source = group.rows.map((row) => row.persianText).join(" ");
  const hints = [];
  const patterns = [
    /در پی/g,
    /به دنبال/g,
    /به دلیل/g,
    /از سوی/g,
    /از طریق/g,
    /در حالی که/g,
    /کریستف کلمب/g,
    /کلمب کریستف/g,
    /کریستوفر کلمب/g
  ];

  for (const pattern of patterns) {
    const matches = source.match(pattern);
    if (matches) {
      hints.push(...matches);
    }
  }

  return [...new Set(hints)];
}

function hasProtectedPhraseBoundarySplit(group) {
  const hints = extractProtectedPhraseHints(group).map(normalizePersianSpacing);
  if (hints.length === 0 || !Array.isArray(group.draftRows) || group.draftRows.length < 2) {
    return false;
  }

  for (let index = 0; index < group.draftRows.length - 1; index += 1) {
    const leftTokens = normalizePersianSpacing(group.draftRows[index].persianText).split(/\s+/).filter(Boolean);
    const rightTokens = normalizePersianSpacing(group.draftRows[index + 1].persianText).split(/\s+/).filter(Boolean);
    if (leftTokens.length === 0 || rightTokens.length === 0) {
      continue;
    }

    const boundary = normalizePersianSpacing(
      `${leftTokens[leftTokens.length - 1]} ${rightTokens[0]}`
    );
    if (hints.includes(boundary)) {
      return true;
    }
  }

  return false;
}

function hasAwkwardSentenceFlow(group) {
  if (!Array.isArray(group.draftRows) || group.draftRows.length < 3) {
    return false;
  }

  const candidateCount = Array.isArray(group.candidatePlans) ? group.candidatePlans.length : 0;
  if (candidateCount < 2) {
    return false;
  }

  const profileId = group.styleProfile?.profileId || "default";
  const singleRows = group.draftRows.filter((row) => row.strategy === "single");
  const commaOrConnectorBreak = group.draftRows.slice(0, -1).some((row, index) => {
    const left = normalizePersianSpacing(row.persianText);
    const right = normalizePersianSpacing(group.draftRows[index + 1]?.persianText || "");
    const rightFirstWord = right.split(/\s+/).filter(Boolean)[0] || "";
    return /[،,:;]\s*$/.test(left) || ["اما", "که", "و", "یا", "زیرا", "ولی", "چون"].includes(rightFirstWord);
  });

  if (profileId === "nwn") {
    return (
      group.rows.length >= 4 ||
      singleRows.length >= 3 ||
      commaOrConnectorBreak ||
      singleRows.some((row) => countWords(row.persianText) <= 3)
    );
  }

  return commaOrConnectorBreak && singleRows.length >= 2;
}

function shouldAttemptGeminiEdit(group, options = {}) {
  if (options.enableGeminiEditing === false) {
    return false;
  }

  if (group.rows.length < 2) {
    return false;
  }

  return (
    group.flagged ||
    hasAwkwardSentenceFlow(group) ||
    group.styleProfile?.profileId === "nwn" ||
    (group.ambiguous && Array.isArray(group.candidatePlans) && group.candidatePlans.length >= 2)
  );
}

function shouldReviewWithGemini(group) {
  return (
    group.flagged ||
    hasProtectedPhraseBoundarySplit(group) ||
    hasAwkwardSentenceFlow(group) ||
    (group.ambiguous && Array.isArray(group.candidatePlans) && group.candidatePlans.length >= 2) ||
    shouldAttemptGeminiEdit(group)
  );
}

async function reviewFlaggedGroups(groups, options) {
  const reviewed = [];
  let attemptedGroups = 0;
  const rateLimitState = {
    nextAllowedAt: 0,
    disabledReason: null
  };

  for (const group of groups) {
    if (
      !shouldReviewWithGemini(group) ||
      rateLimitState.disabledReason
    ) {
      reviewed.push(group);
      continue;
    }

    attemptedGroups += 1;
    const result = await reviewFlaggedGroup(group, {
      ...options,
      rateLimitState
    });
    if (!result.applied) {
      reviewed.push({
        ...group,
        geminiAttempted: true,
        geminiCalled: Boolean(group.geminiCalled) || result.called,
        geminiApplied: false,
        geminiEdited: false,
        geminiEditSuggestions: [],
        geminiProvider: getProvider(options),
        geminiModel: options.model || getDefaultModel(getProvider(options)),
        geminiProtectedPhrases: group.geminiProtectedPhrases || [],
        geminiPreferredBlockSizes: group.geminiPreferredBlockSizes || [],
        reasons: unique([...(group.reasons || []), ...(group.geminiPlanningReasons || []), ...result.reasons])
      });
      continue;
    }

    reviewed.push({
      ...group,
      flagged: false,
      reasons: [],
      geminiAttempted: true,
      geminiCalled: Boolean(group.geminiCalled) || result.called,
      geminiApplied: true,
      geminiEdited: Boolean(result.edited),
      geminiEditSuggestions: result.editSuggestions || [],
      geminiProvider: getProvider(options),
      geminiModel: options.model || getDefaultModel(getProvider(options)),
      geminiProtectedPhrases: unique([
        ...(group.geminiProtectedPhrases || []),
        ...(result.protectedPhrases || [])
      ]),
      geminiPreferredBlockSizes:
        result.preferredBlockSizes?.length > 0
          ? result.preferredBlockSizes
          : group.geminiPreferredBlockSizes || [],
      draftRows: result.rows.map((row) => ({ ...row }))
    });
  }

  return reviewed;
}

async function applyGeminiPlanningHints(groups, options = {}) {
  if (options.mode !== "ai" && options.mode !== "gemini") {
    return groups;
  }

  const rateLimitState = {
    nextAllowedAt: 0,
    disabledReason: null
  };
  let attemptedGroups = 0;
  const enriched = [];

  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (group.type !== "subtitle" || group.rows.length < 2) {
      enriched.push(group);
      continue;
    }

    if (rateLimitState.disabledReason) {
      enriched.push(group);
      continue;
    }

    const contextGroup = {
      ...group,
      styleProfile: options.styleProfile,
      draftRows: group.rows.map((row) => ({
        rowNumber: row.rowNumber,
        persianText: normalizePersianSpacing(row.persianText),
        strategy: "single"
      })),
      previousRows: groups
        .slice(Math.max(0, index - 1), index)
        .flatMap((entry) => (entry.type === "subtitle" ? entry.rows : []))
        .slice(-2),
      nextRows: groups
        .slice(index + 1, index + 2)
        .flatMap((entry) => (entry.type === "subtitle" ? entry.rows : []))
        .slice(0, 2)
    };

    attemptedGroups += 1;
    const hints = await fetchPlanningHintsForGroup(contextGroup, {
      ...options,
      rateLimitState
    });

    enriched.push({
      ...group,
      geminiPlanningAttempted: true,
      geminiPlanningCalled: hints.called,
      geminiPlanningApplied: hints.applied,
      geminiPlanningReasons: hints.reasons || [],
      geminiPlanningProtectedPhrases: hints.protectedPhrases || [],
      geminiPlanningPreferredBlockSizes: hints.preferredBlockSizes || [],
      geminiPlanningKeepSingleRows: hints.keepSingleRows || [],
      geminiPlanningMergeWithNextRows: hints.mergeWithNextRows || []
    });
  }

  return enriched;
}

module.exports = {
  applyGeminiPlanningHints,
  applyPlanningHintResult,
  applyCandidateRankingResult,
  applyEditedRowsResult,
  buildCandidateRankingPrompt,
  buildCandidateRankingSchema,
  buildEditingPrompt,
  buildEditingSchema,
  buildBatchReviewSchema,
  buildPlannerPrompt,
  reviewFlaggedGroup,
  reviewFlaggedGroups,
  reviewGroupsInBatches,
  shouldReviewWithGemini
};
