const {
  classifyEnglishRowType,
  countCharacters,
  countWords,
  isBlankText,
  normalizePersianSpacing,
  unique
} = require("./utils");
const { resolveLineConstraints, validateLineText } = require("./validator");

const AUXILIARY_RE =
  /^(?:است|هست|بود|شد|شده|شوند|شده‌اند|می‌شود|می‌شوند|می‌کند|می‌کنند|می‌کنید|می‌کرد|می‌کردند|نمی‌شود|نمی‌کنند|خواهد|خواهند|کرد|کرده|کردند|گرفت|گرفته|گرفتند)$/;

const PROTECTED_PHRASES = [
  ["در", "پی"],
  ["به", "دنبال"],
  ["به", "دلیل"],
  ["به", "خاطر"],
  ["از", "سوی"],
  ["از", "طریق"],
  ["در", "واقع"],
  ["در", "حالی"],
  ["در", "حالی", "که"],
  ["درحالی", "که"],
  ["درحالیکه"],
  ["برای", "مثال"],
  ["کریستف", "کلمب"],
  ["کلمب", "کریستف"],
  ["کریستوفر", "کلمب"]
];

const CONNECTOR_WORDS = new Set([
  "و",
  "یا",
  "اما",
  "که",
  "تا",
  "در",
  "از",
  "به",
  "با",
  "برای",
  "بر",
  "اگر",
  "زیرا",
  "ولی",
  "چون"
]);

const ADJECTIVE_HINT_WORDS = new Set([
  "شگفت‌انگیز",
  "شگفت‌انگيز",
  "قادر",
  "مطلق",
  "قدیمی",
  "قديمي",
  "جدید",
  "جديد",
  "رایگان",
  "رايگان",
  "قابل‌اعتماد",
  "بین‌المللی",
  "بین‌المللى",
  "کم‌برخوردار",
  "بازنشسته",
  "طبیعی",
  "طبيعی",
  "نادِر",
  "نادر",
  "پایدار",
  "پايدار",
  "الهی",
  "الهی",
  "الهی",
  "خدایی",
  "خدايی"
]);

const RIGHT_FRAGMENT_START_WORDS = new Set([
  "اما",
  "اگر",
  "که",
  "برای",
  "با",
  "به",
  "از",
  "و",
  "یا",
  "زیرا",
  "ولی",
  "چون",
  "تا",
  "در",
  "روی",
  "مثل",
  "هنوز"
]);

const CONTINUATION_CONNECTOR_WORDS = new Set([
  "اما",
  "که",
  "و",
  "یا",
  "زیرا",
  "ولی",
  "چون",
  "تا",
  "هنوز"
]);

const LEFT_FRAGMENT_END_WORDS = new Set([
  "با",
  "به",
  "از",
  "در",
  "برای",
  "تا",
  "مثل",
  "اگر",
  "که",
  "اما"
]);

const MAX_GLOBAL_REPARTITION_ROWS = 6;

function normalizeJoinedText(parts) {
  return normalizePersianSpacing(parts.filter(Boolean).join(" "));
}

function buildProtectedPhraseTable(extraProtectedPhrases, words = []) {
  const extras = extraProtectedPhrases
    .map((phrase) => normalizePersianSpacing(phrase).split(/\s+/).filter(Boolean))
    .filter((phrase) => phrase.length > 1);

  return [...PROTECTED_PHRASES, ...extras, ...deriveHeuristicProtectedPhrases(words)].sort(
    (left, right) => right.length - left.length
  );
}

function normalizeComparableToken(token) {
  return String(token || "")
    .replace(/[،؛؟!,.:"«»()[\]-]/g, "")
    .trim()
    .toLowerCase();
}

function isPotentialAdjectiveToken(token) {
  const normalized = normalizeComparableToken(token);
  if (!normalized) {
    return false;
  }

  if (ADJECTIVE_HINT_WORDS.has(normalized)) {
    return true;
  }

  return /(انه|مند|وار|آمیز|انگیز|آسا|گونه|گونه‌ای|گونۀ)$/u.test(normalized);
}

function isPotentialContentToken(token) {
  const normalized = normalizeComparableToken(token);
  if (!normalized) {
    return false;
  }

  if (CONNECTOR_WORDS.has(normalized) || AUXILIARY_RE.test(normalized) || /^(?:می|نمی)$/.test(normalized)) {
    return false;
  }

  return /[\u0600-\u06ffA-Za-z]/.test(normalized);
}

function deriveHeuristicProtectedPhrases(words) {
  const phrases = [];

  for (let index = 0; index < words.length - 1; index += 1) {
    const first = words[index];
    const second = words[index + 1];
    const third = words[index + 2];

    if (isPotentialContentToken(first) && isPotentialAdjectiveToken(second)) {
      phrases.push([first, second]);

      if (third && (isPotentialContentToken(third) || isPotentialAdjectiveToken(third))) {
        phrases.push([first, second, third]);
      }
    }

    if (isPotentialAdjectiveToken(first) && isPotentialAdjectiveToken(second)) {
      phrases.push([first, second]);
    }
  }

  return unique(
    phrases
      .map((phrase) => phrase.map(normalizeComparableToken))
      .filter((phrase) => phrase.length > 1 && phrase.every(Boolean))
      .map((phrase) => phrase.join(" "))
  ).map((phrase) => phrase.split(" "));
}

function matchProtectedPhrase(words, startIndex, protectedPhrases) {
  for (const phrase of protectedPhrases) {
    if (startIndex + phrase.length > words.length) {
      continue;
    }

    const matches = phrase.every((token, offset) => {
      return normalizeComparableToken(words[startIndex + offset]) === token;
    });

    if (matches) {
      return phrase;
    }
  }

  return null;
}

function shouldStickTogether(current, next, chunk) {
  const cleanCurrent = current.replace(/[،؛؟!,.:"«»()[\]-]/g, "");
  const cleanNext = next.replace(/[،؛؟!,.:"«»()[\]-]/g, "");
  const quoteBalance = chunk.join(" ").split(/[«"]/).length - 1;

  if (quoteBalance % 2 === 1) {
    return true;
  }

  if (/[A-Za-z]/.test(cleanCurrent) && /[A-Za-z]/.test(cleanNext)) {
    return true;
  }

  if (/\d/.test(cleanCurrent) && cleanNext.length <= 4) {
    return true;
  }

  if (cleanCurrent.endsWith("ِ") || cleanCurrent.endsWith("‌")) {
    return true;
  }

  if (AUXILIARY_RE.test(cleanNext) || /^(?:می‌|نمی‌)/.test(cleanNext)) {
    return true;
  }

  return false;
}

function tokenizeUnits(text, options = {}) {
  const words = normalizePersianSpacing(text).split(/\s+/).filter(Boolean);
  const units = [];
  const protectedPhrases = buildProtectedPhraseTable(options.extraProtectedPhrases || [], words);

  for (let index = 0; index < words.length; index += 1) {
    const protectedPhrase = matchProtectedPhrase(words, index, protectedPhrases);
    if (protectedPhrase) {
      units.push(words.slice(index, index + protectedPhrase.length).join(" "));
      index += protectedPhrase.length - 1;
      continue;
    }

    const chunk = [words[index]];
    while (
      index + 1 < words.length &&
      shouldStickTogether(chunk[chunk.length - 1], words[index + 1], chunk)
    ) {
      chunk.push(words[index + 1]);
      index += 1;
    }

    units.push(chunk.join(" "));
  }

  return units;
}

function smoothPersianText(text) {
  return normalizePersianSpacing(text)
    .replace(/\s+([،؛؟!,.])/g, "$1")
    .replace(/([«(\[])\s+/g, "$1")
    .replace(/\s+([)\]»])/g, "$1");
}

function splitTextIntoLines(text, lineCount, englishLines, options = {}) {
  const normalized = smoothPersianText(text);
  if (!normalized) {
    return Array.from({ length: lineCount }, () => "");
  }

  if (lineCount === 1) {
    return validateLineText(normalized, {
      ...options,
      rowContext: { englishText: englishLines[0] || "" }
    }).valid
      ? [normalized]
      : null;
  }

  const units = tokenizeUnits(normalized, options);
  if (units.length < lineCount) {
    return null;
  }

  const englishWeights = englishLines.map((line) =>
    Math.max(String(line || "").replace(/\s+/g, "").length, 1)
  );
  const totalWeight = englishWeights.reduce((sum, value) => sum + value, 0);
  const totalChars = normalized.length;
  const targets = englishWeights.map((weight) => (totalChars * weight) / totalWeight);
  const memo = new Map();

  function solve(startIndex, lineIndex) {
    const key = `${startIndex}:${lineIndex}`;
    if (memo.has(key)) {
      return memo.get(key);
    }

    const remainingLines = lineCount - lineIndex;
    const remainingUnits = units.length - startIndex;
    if (remainingUnits < remainingLines) {
      return null;
    }

    if (lineIndex === lineCount - 1) {
      const lastLine = smoothPersianText(units.slice(startIndex).join(" "));
      const verdict = validateLineText(lastLine, {
        ...options,
        rowContext: { englishText: englishLines[lineIndex] || "" }
      });
      if (!verdict.valid) {
        return null;
      }

      const result = {
        cost: lineCost(lastLine, targets[lineIndex], options, {
          englishText: englishLines[lineIndex] || ""
        }),
        lines: [verdict.normalized]
      };
      memo.set(key, result);
      return result;
    }

    let best = null;
    const maxEnd = units.length - (remainingLines - 1);
    for (let end = startIndex + 1; end <= maxEnd; end += 1) {
      const line = smoothPersianText(units.slice(startIndex, end).join(" "));
      const verdict = validateLineText(line, {
        ...options,
        rowContext: { englishText: englishLines[lineIndex] || "" }
      });
      if (!verdict.valid) {
        continue;
      }

      const rest = solve(end, lineIndex + 1);
      if (!rest) {
        continue;
      }

      const candidate = {
        cost:
          lineCost(verdict.normalized, targets[lineIndex], options, {
            englishText: englishLines[lineIndex] || ""
          }) + rest.cost,
        lines: [verdict.normalized, ...rest.lines]
      };

      if (!best || candidate.cost < best.cost) {
        best = candidate;
      }
    }

    memo.set(key, best);
    return best;
  }

  return solve(0, 0)?.lines || null;
}

function lineCost(line, targetChars, options = {}, rowContext = {}) {
  const difference = countCharacters(line) - targetChars;
  const limits = resolveLineConstraints(options.styleProfile, rowContext);
  const wordBias = Math.max(0, countWords(line) - limits.preferredWordMax);
  return difference * difference + wordBias * 4 + learnedLinePenalty(line, options, rowContext);
}

function learnedLinePenalty(line, options = {}, rowContext = {}) {
  if (!options.styleProfile) {
    return 0;
  }

  const limits = resolveLineConstraints(options.styleProfile, rowContext);
  const charCount = countCharacters(line);
  const wordCount = countWords(line);
  let penalty = 0;

  if (charCount < limits.preferredCharMin) {
    penalty += (limits.preferredCharMin - charCount) * 0.35;
  }

  if (charCount > limits.preferredCharMax) {
    penalty += (charCount - limits.preferredCharMax) * 0.8;
  }

  if (wordCount > limits.preferredWordMax) {
    penalty += (wordCount - limits.preferredWordMax) * 0.9;
  }

  if (charCount > limits.softCharMax) {
    penalty += (charCount - limits.softCharMax) * 1.25;
  }

  return penalty;
}

function isSentenceTerminal(text) {
  return /[.!?؟…]["')\]»]*\s*$/.test(normalizePersianSpacing(text));
}

function getProfileId(options = {}) {
  return options.styleProfile?.profileId || "default";
}

function getPlanningWeights(options = {}) {
  const profileId = getProfileId(options);
  const base = {
    boundaryMultiplier: 1,
    shortSingleContinuation: 3.5,
    shortSingleLeadin: 1.5,
    longSingleRunPenalty: 0,
    metaRepeatPenalty: 20,
    commaMergeReward: 1,
    splitAcrossContinuationPenalty: 2.5
  };

  if (profileId === "nwn") {
    return {
      ...base,
      boundaryMultiplier: 1.35,
      shortSingleContinuation: 5.75,
      shortSingleLeadin: 2.5,
      longSingleRunPenalty: 2.75,
      commaMergeReward: 1.75,
      splitAcrossContinuationPenalty: 4
    };
  }

  return base;
}

function isMetaRow(row) {
  return classifyEnglishRowType(row?.englishText || "") === "source";
}

function englishReadingLength(text) {
  return String(text || "").replace(/\s+/g, "").length;
}

function average(numbers) {
  if (!Array.isArray(numbers) || numbers.length === 0) {
    return 0;
  }

  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

function endsWithComma(text) {
  return /[،,:;]\s*$/.test(normalizePersianSpacing(text));
}

function isStrongStandaloneCommaClause(text, englishText = "") {
  const normalized = normalizePersianSpacing(text);
  if (!normalized || !(endsWithComma(normalized) || /[,:;]\s*$/.test(String(englishText || "").trim()))) {
    return false;
  }

  return countWords(normalized) >= 3 && countCharacters(normalized) >= 16;
}

function boundaryContinuationPenalty(leftText, rightText, options = {}) {
  const left = normalizePersianSpacing(leftText);
  const right = normalizePersianSpacing(rightText);
  if (!left || !right) {
    return 0;
  }

  const weights = getPlanningWeights(options);
  const leftWords = left.split(/\s+/).filter(Boolean);
  const rightWords = right.split(/\s+/).filter(Boolean);
  const leftLastWord = normalizeComparableToken(leftWords[leftWords.length - 1] || "");
  const rightFirstWord = normalizeComparableToken(rightWords[0] || "");
  let penalty = 0;

  if (endsWithComma(left)) {
    if (CONTINUATION_CONNECTOR_WORDS.has(rightFirstWord)) {
      penalty += 6;
    } else if (leftWords.length <= 2) {
      penalty += 4;
    } else {
      penalty += 1.25;
    }
  }

  if (!isSentenceTerminal(left) && CONTINUATION_CONNECTOR_WORDS.has(rightFirstWord)) {
    penalty += 3;
  }

  if (!isSentenceTerminal(left) && RIGHT_FRAGMENT_START_WORDS.has(rightFirstWord)) {
    penalty += 5;
  }

  if (!isSentenceTerminal(left) && LEFT_FRAGMENT_END_WORDS.has(leftLastWord)) {
    penalty += 4;
  }

  if (!isSentenceTerminal(left) && leftWords.length <= 3) {
    penalty += 3;
  }

  return penalty * weights.boundaryMultiplier;
}

function compareScores(left, right) {
  if (!left) {
    return -1;
  }

  if (!right) {
    return 1;
  }

  if ((left.stylePenalty || 0) !== (right.stylePenalty || 0)) {
    return (left.stylePenalty || 0) < (right.stylePenalty || 0) ? 1 : -1;
  }

  if (left.blockCount !== right.blockCount) {
    return left.blockCount < right.blockCount ? 1 : -1;
  }

  if (left.triplePenalty !== right.triplePenalty) {
    return left.triplePenalty < right.triplePenalty ? 1 : -1;
  }

  if (left.repeatedRows !== right.repeatedRows) {
    return left.repeatedRows > right.repeatedRows ? 1 : -1;
  }

  if (left.changedRows !== right.changedRows) {
    return left.changedRows < right.changedRows ? 1 : -1;
  }

  return 0;
}

function rowBoundaryPenalty(candidate, rowSlice, options = {}) {
  const weights = getPlanningWeights(options);
  let penalty = 0;
  const preferredSingleRows = new Set(options.preferredSingleRows || []);
  const preferredMergeWithNextRows = new Set(options.preferredMergeWithNextRows || []);

  if (rowSlice.some(isMetaRow) && candidate.strategy !== "single") {
    penalty += weights.metaRepeatPenalty;
  }

  if (candidate.strategy === "single" && rowSlice.length === 1) {
    const row = rowSlice[0];
    const line = candidate.lines[0];
    const rowType = classifyEnglishRowType(row.englishText);
    const limits = resolveLineConstraints(options.styleProfile, {
      englishText: row.englishText,
      rowType
    });
    const words = countWords(line);
    const chars = countCharacters(line);

    if (rowType === "normal" && !isSentenceTerminal(line)) {
      if (words <= 3 || chars < limits.preferredCharTarget) {
        penalty += weights.shortSingleContinuation;
      } else {
        penalty += weights.shortSingleLeadin;
      }
    }
  }

  if (candidate.strategy === "repeat" && rowSlice.length === 2) {
    const mergedLine = candidate.lines[0] || "";
    const originalFirst = normalizePersianSpacing(rowSlice[0]?.persianText || "");
    const englishFirst = rowSlice[0]?.englishText || "";
    const secondFirstWord = normalizeComparableToken(
      normalizePersianSpacing(rowSlice[1]?.persianText || "").split(/\s+/).filter(Boolean)[0] || ""
    );
    if (endsWithComma(originalFirst) || endsWithComma(mergedLine) || /[,:;]\s*$/.test(englishFirst.trim())) {
      penalty -= weights.commaMergeReward * 1.75;
    }

    if (
      isStrongStandaloneCommaClause(originalFirst, englishFirst) &&
      !CONTINUATION_CONNECTOR_WORDS.has(secondFirstWord) &&
      !RIGHT_FRAGMENT_START_WORDS.has(secondFirstWord)
    ) {
      penalty += 32;
    }

    if (
      (endsWithComma(originalFirst) || /[,:;]\s*$/.test(englishFirst.trim())) &&
      (CONTINUATION_CONNECTOR_WORDS.has(secondFirstWord) ||
        countWords(originalFirst) <= 3 ||
        countCharacters(originalFirst) < 16)
    ) {
      penalty -= weights.commaMergeReward * 2.5;
    }

    if (!isSentenceTerminal(originalFirst)) {
      penalty -= weights.shortSingleContinuation * 0.55;
    }

    if (
      classifyEnglishRowType(rowSlice[0].englishText) === "title" &&
      classifyEnglishRowType(rowSlice[1].englishText) === "date"
    ) {
      penalty -= 4;
    }

    if (
      countWords(normalizePersianSpacing(rowSlice[0].persianText)) <= 3 ||
      countWords(normalizePersianSpacing(rowSlice[1].persianText)) <= 3
    ) {
      penalty -= 1.25;
    }
  }

  if (rowSlice.length === 1 && preferredSingleRows.has(rowSlice[0].rowNumber)) {
    penalty -= 8;
  }

  if (candidate.strategy === "repeat" && rowSlice.length === 2 && preferredMergeWithNextRows.has(rowSlice[0].rowNumber)) {
    penalty -= 8;
  }

  if (candidate.strategy === "repeat" && rowSlice.length === 2 && preferredSingleRows.has(rowSlice[0].rowNumber)) {
    penalty += 10;
  }

  if (rowSlice.length === 1 && preferredMergeWithNextRows.has(rowSlice[0].rowNumber)) {
    penalty += 6;
  }

  return penalty;
}

function englishTimingAlignmentPenalty(candidate, rowSlice, options = {}) {
  const englishLengths = rowSlice.map((row) => englishReadingLength(row.englishText)).filter((value) => value > 0);
  if (englishLengths.length === 0) {
    return 0;
  }

  const overallMean = options.groupEnglishMean || average(englishLengths);
  const sliceMean = average(englishLengths);

  if (candidate.strategy === "single" && rowSlice.length === 1) {
    return englishLengths[0] < overallMean
      ? (overallMean - englishLengths[0]) * 0.15
      : -(englishLengths[0] - overallMean) * 0.08;
  }

  if (candidate.strategy === "repeat" && rowSlice.length === 2) {
    return sliceMean > overallMean
      ? (sliceMean - overallMean) * 0.1
      : -(overallMean - sliceMean) * 0.15;
  }

  return 0;
}

function candidateStylePenalty(candidate, rowSlice, options = {}) {
  let penalty = 0;

  for (let index = 0; index < candidate.lines.length; index += 1) {
    penalty += learnedLinePenalty(candidate.lines[index], options, {
      englishText: rowSlice[Math.min(index, rowSlice.length - 1)]?.englishText || ""
    });
  }

  for (let index = 0; index < candidate.lines.length - 1; index += 1) {
    penalty += boundaryContinuationPenalty(candidate.lines[index], candidate.lines[index + 1], options);
  }

  penalty += rowBoundaryPenalty(candidate, rowSlice, options);
  penalty += englishTimingAlignmentPenalty(candidate, rowSlice, options);

  if (options.styleProfile) {
    penalty += repeatStrategyPenalty(candidate.strategy, rowSlice, options.styleProfile);
    penalty += titleDateMergePenalty(candidate.strategy, rowSlice, options.styleProfile);
  }

  return penalty;
}

function buildHybridRepeatCandidates(rowSlice, mergedText, options = {}) {
  const candidates = [];
  const span = rowSlice.length;
  if (span < 3 || span > 4) {
    return candidates;
  }

  const layouts = [
    {
      englishLines: [
        rowSlice.slice(0, 2).map((row) => row.englishText).join(" "),
        ...rowSlice.slice(2).map((row) => row.englishText)
      ],
      expand(lines) {
        return [lines[0], lines[0], ...lines.slice(1)];
      },
      strategies: ["repeat", "repeat", ...Array.from({ length: span - 2 }, () => "split")]
    },
    {
      englishLines: [
        ...rowSlice.slice(0, -2).map((row) => row.englishText),
        rowSlice.slice(-2).map((row) => row.englishText).join(" ")
      ],
      expand(lines) {
        return [...lines.slice(0, -1), lines[lines.length - 1], lines[lines.length - 1]];
      },
      strategies: [...Array.from({ length: span - 2 }, () => "split"), "repeat", "repeat"]
    }
  ];

  for (const layout of layouts) {
    const splitLines = splitTextIntoLines(mergedText, span - 1, layout.englishLines, options);
    if (!splitLines) {
      continue;
    }

    const expandedLines = layout.expand(splitLines);
    candidates.push({
      strategy: "mixed",
      rowStrategies: layout.strategies,
      rows: rowSlice,
      lines: expandedLines,
      stylePenalty: candidateStylePenalty(
        {
          strategy: "mixed",
          rowStrategies: layout.strategies,
          lines: expandedLines
        },
        rowSlice,
        options
      ),
      reasons: []
    });
  }

  return candidates;
}

function repeatStrategyPenalty(strategy, rowSlice, styleProfile) {
  const rates = styleProfile?.repeat?.rates || {};
  const singleRate = rates["1"] || 0;

  if (strategy !== "repeat") {
    const repeatTwoRate = rates["2"] || 0;
    return repeatTwoRate > singleRate ? (repeatTwoRate - singleRate) * 1.25 : 0;
  }

  const observedRate = rates[String(Math.min(rowSlice.length, 4))] || 0;
  return singleRate > observedRate ? (singleRate - observedRate) * 2.5 : 0;
}

function titleDateMergePenalty(strategy, rowSlice, styleProfile) {
  if (!styleProfile || rowSlice.length !== 2) {
    return 0;
  }

  const mergeRate = styleProfile.titleDate?.mergeRate || 0;
  if (mergeRate <= 0.2) {
    return 0;
  }

  if (
    classifyEnglishRowType(rowSlice[0].englishText) === "title" &&
    classifyEnglishRowType(rowSlice[1].englishText) === "date"
  ) {
    return strategy === "repeat" ? 0 : mergeRate * 3;
  }

  return 0;
}

function buildRowsForBlock(block) {
  return block.rows.map((row, index) => ({
    rowNumber: row.rowNumber,
    persianText: block.lines[index],
    strategy: block.rowStrategies?.[index] || block.strategy
  }));
}

function countRepeatedRows(block, rowSlice) {
  if (Array.isArray(block.rowStrategies)) {
    return block.rowStrategies.filter((strategy) => strategy === "repeat").length;
  }

  return block.strategy === "repeat" ? rowSlice.length : 0;
}

function buildPlanSignature(plannedRows) {
  return plannedRows
    .map((row) => `${row.rowNumber}:${row.strategy}:${normalizePersianSpacing(row.persianText)}`)
    .join("|");
}

function combinePlanScore(block, rowSlice, currentRows, suffixPlan, options = {}) {
  const weights = getPlanningWeights(options);
  const nextBlock = suffixPlan.blocks?.[0] || null;
  const boundaryPenalty =
    currentRows.length > 0 && suffixPlan.rows.length > 0
      ? boundaryContinuationPenalty(
          currentRows[currentRows.length - 1].persianText,
          suffixPlan.rows[0].persianText,
          options
        )
      : 0;

  let commaBoundaryAdjustment = 0;
  if (currentRows.length > 0 && nextBlock?.rows?.length) {
    const leftOriginalRow = rowSlice[rowSlice.length - 1];
    const leftOutput = currentRows[currentRows.length - 1]?.persianText || "";
    const rightOutput = suffixPlan.rows[0]?.persianText || "";
    const rightFirstWord = normalizeComparableToken(
      normalizePersianSpacing(rightOutput).split(/\s+/).filter(Boolean)[0] || ""
    );

    if (
      leftOriginalRow &&
      isStrongStandaloneCommaClause(leftOutput, leftOriginalRow.englishText) &&
      currentRows.length === 1 &&
      rowSlice.length === 1 &&
      !CONTINUATION_CONNECTOR_WORDS.has(rightFirstWord) &&
      !RIGHT_FRAGMENT_START_WORDS.has(rightFirstWord)
    ) {
      commaBoundaryAdjustment -= weights.commaMergeReward * 8;
    }

    if (
      leftOriginalRow &&
      (endsWithComma(leftOutput) || /[,:;]\s*$/.test(String(leftOriginalRow.englishText || "").trim())) &&
      (CONTINUATION_CONNECTOR_WORDS.has(rightFirstWord) || countWords(leftOutput) <= 3)
    ) {
      commaBoundaryAdjustment += weights.commaMergeReward * 2;
    }
  }

  let stylePenalty =
    (suffixPlan.score?.stylePenalty || 0) +
    (block.stylePenalty || 0) +
    boundaryPenalty +
    commaBoundaryAdjustment;
  if (
    rowSlice.length === 1 &&
    suffixPlan.rows.length > 0 &&
    !isSentenceTerminal(currentRows[currentRows.length - 1].persianText)
  ) {
    stylePenalty += weights.longSingleRunPenalty;
  }

  return {
    stylePenalty,
    repeatedRows: (suffixPlan.score?.repeatedRows || 0) + countRepeatedRows(block, rowSlice),
    triplePenalty:
      (suffixPlan.score?.triplePenalty || 0) + (block.strategy === "repeat" && rowSlice.length === 3 ? 1 : 0),
    blockCount: (suffixPlan.score?.blockCount || 0) + 1,
    changedRows:
      (suffixPlan.score?.changedRows || 0) +
      block.lines.reduce(
        (sum, line, index) =>
          sum +
          (normalizePersianSpacing(line) !== normalizePersianSpacing(rowSlice[index].persianText) ? 1 : 0),
        0
      )
  };
}

function sortAndLimitPlanCandidates(candidates, limit = 12) {
  const deduped = new Map();

  for (const candidate of candidates) {
    const signature = buildPlanSignature(candidate.rows);
    const existing = deduped.get(signature);
    if (!existing || compareScores(candidate.score, existing.score) > 0) {
      deduped.set(signature, candidate);
    }
  }

  return [...deduped.values()]
    .sort((left, right) => (compareScores(left.score, right.score) > 0 ? -1 : 1))
    .slice(0, limit);
}

function summarizeCandidatePlans(candidates) {
  return candidates.map((candidate) => ({
      score: candidate.score,
      rows: candidate.rows,
      blocks: candidate.blocks.map((block) => ({
        strategy: block.strategy,
        rowStrategies: block.rowStrategies,
        rowNumbers: block.rows.map((row) => row.rowNumber),
        lines: block.lines
      }))
  }));
}

function buildBlockCandidates(rowSlice, mergedText, englishLines, options = {}) {
  const candidates = [];
  const span = rowSlice.length;
  const smoothedMergedText = smoothPersianText(mergedText);

  if (span === 1) {
    const original = smoothPersianText(rowSlice[0].persianText);
    const verdict = validateLineText(original, {
      ...options,
      rowContext: { englishText: rowSlice[0].englishText }
    });
    if (!isBlankText(original) && !verdict.valid) {
      return candidates;
    }

    candidates.push({
      strategy: "single",
      rowStrategies: ["single"],
      rows: rowSlice,
      lines: [original],
      stylePenalty: candidateStylePenalty(
        {
          strategy: "single",
          lines: [original]
        },
        rowSlice,
        options
      ),
      reasons: []
    });

    return candidates;
  }

  const mergedVerdict = validateLineText(smoothedMergedText, {
    ...options,
    rowContext: { englishText: rowSlice.map((row) => row.englishText).join(" ") }
  });

  if (
    span > 1 &&
    smoothedMergedText &&
    mergedVerdict.valid &&
    (span < 3 || options.allowTripleRepeat === true)
  ) {
    candidates.push({
      strategy: "repeat",
      rowStrategies: Array.from({ length: span }, () => "repeat"),
      rows: rowSlice,
      lines: Array.from({ length: span }, () => mergedVerdict.normalized),
      stylePenalty: candidateStylePenalty(
        {
          strategy: "repeat",
          lines: Array.from({ length: span }, () => mergedVerdict.normalized)
        },
        rowSlice,
        options
      ),
      reasons: []
    });
  }

  const splitLines = splitTextIntoLines(smoothedMergedText, span, englishLines, options);
  if (splitLines) {
    candidates.push({
      strategy: "split",
      rowStrategies: Array.from({ length: span }, () => "split"),
      rows: rowSlice,
      lines: splitLines,
      stylePenalty: candidateStylePenalty(
        {
          strategy: "split",
          lines: splitLines
        },
        rowSlice,
        options
      ),
      reasons: []
    });
  }

  candidates.push(...buildHybridRepeatCandidates(rowSlice, smoothedMergedText, options));

  return candidates;
}

function chooseBestCandidateForBlock(candidates, rowSlice) {
  if (!candidates || candidates.length === 0) {
    return null;
  }

  let best = null;
  for (const candidate of candidates) {
    const score = {
      stylePenalty: candidate.stylePenalty || 0,
      repeatedRows: countRepeatedRows(candidate, rowSlice),
      triplePenalty: candidate.strategy === "repeat" && rowSlice.length === 3 ? 1 : 0,
      blockCount: 1,
      changedRows: candidate.lines.reduce(
        (sum, line, index) =>
          sum +
          (normalizePersianSpacing(line) !== normalizePersianSpacing(rowSlice[index].persianText) ? 1 : 0),
        0
      )
    };

    if (!best || compareScores(score, best.score) > 0) {
      best = { candidate, score };
    }
  }

  return best?.candidate || null;
}

function getAllowedSpanSizes(options = {}) {
  return getProfileId(options) === "nwn" ? [1, 2, 3, 4] : [1, 2, 3];
}

function enumerateBlockSizePlans(totalRows, allowedSizes, current = [], plans = []) {
  if (totalRows === 0) {
    plans.push([...current]);
    return plans;
  }

  for (const size of allowedSizes) {
    if (size > totalRows) {
      continue;
    }

    current.push(size);
    enumerateBlockSizePlans(totalRows - size, allowedSizes, current, plans);
    current.pop();
  }

  return plans;
}

function buildGeneratedBlockCandidates(rowSlice, generatedText, options = {}) {
  const candidates = [];
  const span = rowSlice.length;
  const englishLines = rowSlice.map((row) => row.englishText);
  const smoothedText = smoothPersianText(generatedText);

  if (!smoothedText) {
    return candidates;
  }

  if (span === 1) {
    const verdict = validateLineText(smoothedText, {
      ...options,
      rowContext: { englishText: rowSlice[0].englishText }
    });
    if (!verdict.valid) {
      return candidates;
    }

    candidates.push({
      strategy: "single",
      rowStrategies: ["single"],
      rows: rowSlice,
      lines: [verdict.normalized],
      stylePenalty: candidateStylePenalty(
        {
          strategy: "single",
          lines: [verdict.normalized]
        },
        rowSlice,
        options
      ),
      reasons: []
    });

    return candidates;
  }

  const mergedVerdict = validateLineText(smoothedText, {
    ...options,
    rowContext: { englishText: englishLines.join(" ") }
  });

  if (
    mergedVerdict.valid &&
    (span < 3 || options.allowTripleRepeat === true)
  ) {
    candidates.push({
      strategy: "repeat",
      rowStrategies: Array.from({ length: span }, () => "repeat"),
      rows: rowSlice,
      lines: Array.from({ length: span }, () => mergedVerdict.normalized),
      stylePenalty: candidateStylePenalty(
        {
          strategy: "repeat",
          lines: Array.from({ length: span }, () => mergedVerdict.normalized)
        },
        rowSlice,
        options
      ),
      reasons: []
    });
  }

  const splitLines = splitTextIntoLines(smoothedText, span, englishLines, options);
  if (splitLines) {
    candidates.push({
      strategy: "split",
      rowStrategies: Array.from({ length: span }, () => "split"),
      rows: rowSlice,
      lines: splitLines,
      stylePenalty: candidateStylePenalty(
        {
          strategy: "split",
          lines: splitLines
        },
        rowSlice,
        options
      ),
      reasons: []
    });
  }

  return candidates;
}

function buildPlanFromBlocks(blocks, options = {}) {
  let suffixPlan = {
    blocks: [],
    rows: [],
    score: {
      stylePenalty: 0,
      repeatedRows: 0,
      triplePenalty: 0,
      blockCount: 0,
      changedRows: 0
    },
    reasons: []
  };

  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    const currentRows = buildRowsForBlock(block);
    suffixPlan = {
      blocks: [block, ...suffixPlan.blocks],
      rows: [...currentRows, ...suffixPlan.rows],
      score: combinePlanScore(block, block.rows, currentRows, suffixPlan, options),
      reasons: unique([...(block.reasons || []), ...(suffixPlan.reasons || [])])
    };
  }

  return suffixPlan;
}

function buildGlobalPartitionCandidates(rows, options = {}) {
  if (rows.length > MAX_GLOBAL_REPARTITION_ROWS) {
    return [];
  }

  const mergedText = normalizeJoinedText(rows.map((row) => row.persianText));
  if (!mergedText) {
    return [];
  }

  const allowedSizes = getAllowedSpanSizes(options);
  const partitions = enumerateBlockSizePlans(rows.length, allowedSizes);
  const candidates = [];

  for (const blockSizes of partitions) {
    const blockEnglishLines = [];
    let startIndex = 0;
    for (const size of blockSizes) {
      blockEnglishLines.push(rows.slice(startIndex, startIndex + size).map((row) => row.englishText).join(" "));
      startIndex += size;
    }

    const blockTexts = splitTextIntoLines(mergedText, blockSizes.length, blockEnglishLines, options);
    if (!blockTexts) {
      continue;
    }

    const blocks = [];
    startIndex = 0;
    let valid = true;

    for (let blockIndex = 0; blockIndex < blockSizes.length; blockIndex += 1) {
      const size = blockSizes[blockIndex];
      const rowSlice = rows.slice(startIndex, startIndex + size);
      const blockCandidate = chooseBestCandidateForBlock(
        buildGeneratedBlockCandidates(rowSlice, blockTexts[blockIndex], options),
        rowSlice
      );

      if (!blockCandidate) {
        valid = false;
        break;
      }

      blocks.push(blockCandidate);
      startIndex += size;
    }

    if (!valid) {
      continue;
    }

    const planned = buildPlanFromBlocks(blocks, options);
    if (planHasProtectedBoundarySplit(planned.rows, options)) {
      continue;
    }

    candidates.push(planned);
  }

  return candidates;
}

function planHasProtectedBoundarySplit(plannedRows, options = {}) {
  const allWords = plannedRows
    .flatMap((row) => normalizePersianSpacing(row.persianText).split(/\s+/).filter(Boolean));
  const protectedPhrases = buildProtectedPhraseTable(options.extraProtectedPhrases || [], allWords);
  if (protectedPhrases.length === 0 || plannedRows.length < 2) {
    return false;
  }

  const maxPhraseLength = Math.max(...protectedPhrases.map((phrase) => phrase.length));
  for (let index = 0; index < plannedRows.length - 1; index += 1) {
    const leftTokens = normalizePersianSpacing(plannedRows[index].persianText)
      .split(/\s+/)
      .filter(Boolean)
      .map(normalizeComparableToken)
      .filter(Boolean);
    const rightTokens = normalizePersianSpacing(plannedRows[index + 1].persianText)
      .split(/\s+/)
      .filter(Boolean)
      .map(normalizeComparableToken)
      .filter(Boolean);

    if (leftTokens.length === 0 || rightTokens.length === 0) {
      continue;
    }

    const tail = leftTokens.slice(-(maxPhraseLength - 1));
    const head = rightTokens.slice(0, maxPhraseLength - 1);
    const boundaryTokens = [...tail, ...head];

    for (const phrase of protectedPhrases) {
      for (let start = 0; start <= boundaryTokens.length - phrase.length; start += 1) {
        const windowTokens = boundaryTokens.slice(start, start + phrase.length);
        const splitPoint = tail.length - start;
        const crossesBoundary = splitPoint > 0 && splitPoint < phrase.length;

        if (
          crossesBoundary &&
          phrase.every((token, tokenIndex) => windowTokens[tokenIndex] === token)
        ) {
          return true;
        }
      }
    }
  }

  return false;
}

function planSubtitleGroupWithPreferredBlocks(rows, options = {}) {
  const preferredBlockSizes = Array.isArray(options.preferredBlockSizes)
    ? options.preferredBlockSizes
    : null;

  if (!preferredBlockSizes || preferredBlockSizes.length === 0) {
    return null;
  }

  if (
    preferredBlockSizes.some((size) => !Number.isInteger(size) || size < 1 || size > 3) ||
    preferredBlockSizes.reduce((sum, size) => sum + size, 0) !== rows.length
  ) {
    return null;
  }

  const mergedText = normalizeJoinedText(rows.map((row) => row.persianText));
  const blockEnglishLines = [];
  let startIndex = 0;
  for (const size of preferredBlockSizes) {
    blockEnglishLines.push(rows.slice(startIndex, startIndex + size).map((row) => row.englishText).join(" "));
    startIndex += size;
  }

  const blockTexts = splitTextIntoLines(mergedText, preferredBlockSizes.length, blockEnglishLines, options);
  if (!blockTexts) {
    return null;
  }

  const blocks = [];
  startIndex = 0;
  for (let blockIndex = 0; blockIndex < preferredBlockSizes.length; blockIndex += 1) {
    const size = preferredBlockSizes[blockIndex];
    const rowSlice = rows.slice(startIndex, startIndex + size);
    const candidate = chooseBestCandidateForBlock(
      buildGeneratedBlockCandidates(rowSlice, blockTexts[blockIndex], options),
      rowSlice
    );

    if (!candidate) {
      return null;
    }

    blocks.push(candidate);
    startIndex += size;
  }

  const planned = buildPlanFromBlocks(blocks, options);
  if (planHasProtectedBoundarySplit(planned.rows, options)) {
    return null;
  }

  return {
    changed: planned.rows.some(
      (row, index) =>
        normalizePersianSpacing(row.persianText) !== normalizePersianSpacing(rows[index].persianText)
    ),
    flagged: false,
    ambiguous: false,
    reasons: [],
    candidatePlans: summarizeCandidatePlans([planned]),
    rows: planned.rows
  };
}

function planSubtitleGroupCandidates(rows, options = {}) {
  const enrichedOptions = {
    ...options,
    groupEnglishMean: average(rows.map((row) => englishReadingLength(row.englishText)).filter((value) => value > 0))
  };
  const memo = new Map();
  const candidateLimit = enrichedOptions.candidateLimit || (getProfileId(enrichedOptions) === "nwn" ? 18 : 12);

  function solve(startIndex) {
    if (startIndex === rows.length) {
      return [
        {
          blocks: [],
          rows: [],
          score: {
            stylePenalty: 0,
            repeatedRows: 0,
            triplePenalty: 0,
            blockCount: 0,
            changedRows: 0
          },
          reasons: []
        }
      ];
    }

    if (memo.has(startIndex)) {
      return memo.get(startIndex);
    }

    const planCandidates = [];

    const spans = getAllowedSpanSizes(enrichedOptions);
    for (const span of spans) {
      if (startIndex + span > rows.length) {
        continue;
      }

      const rowSlice = rows.slice(startIndex, startIndex + span);
      const persianText = normalizeJoinedText(rowSlice.map((row) => row.persianText));
      const englishLines = rowSlice.map((row) => row.englishText);
      const blockCandidates = buildBlockCandidates(rowSlice, persianText, englishLines, enrichedOptions);
      const suffixPlans = solve(startIndex + span);

      for (const block of blockCandidates) {
        const currentRows = buildRowsForBlock(block);

        for (const suffixPlan of suffixPlans) {
          const combinedRows = [...currentRows, ...suffixPlan.rows];
          if (planHasProtectedBoundarySplit(combinedRows, enrichedOptions)) {
            continue;
          }

          planCandidates.push({
            blocks: [block, ...suffixPlan.blocks],
            rows: combinedRows,
            score: combinePlanScore(block, rowSlice, currentRows, suffixPlan, enrichedOptions),
            reasons: unique([...(block.reasons || []), ...(suffixPlan.reasons || [])])
          });
        }
      }
    }

    const ranked = sortAndLimitPlanCandidates(planCandidates, candidateLimit);
    memo.set(startIndex, ranked);
    return ranked;
  }

  const localCandidates = solve(0);
  const globalCandidates = buildGlobalPartitionCandidates(rows, enrichedOptions);
  return sortAndLimitPlanCandidates([...localCandidates, ...globalCandidates], candidateLimit);
}

function planSubtitleGroup(rows, options = {}) {
  const preferred = planSubtitleGroupWithPreferredBlocks(rows, options);
  if (preferred) {
    return preferred;
  }

  const candidates = planSubtitleGroupCandidates(rows, options);
  const planned = candidates[0] || null;

  if (!planned) {
    return {
      changed: false,
      flagged: true,
      ambiguous: false,
      reasons: ["No valid row arrangement found"],
      candidatePlans: [],
      rows: rows.map((row) => ({
        rowNumber: row.rowNumber,
        persianText: normalizePersianSpacing(row.persianText),
        strategy: "single"
      }))
    };
  }

  return {
    changed: planned.rows.some(
      (row, index) =>
        normalizePersianSpacing(row.persianText) !== normalizePersianSpacing(rows[index].persianText)
    ),
    flagged: planned.reasons.length > 0,
    ambiguous: candidates.length > 1,
    reasons: planned.reasons,
    candidatePlans: summarizeCandidatePlans(candidates.slice(0, 5)),
    rows: planned.rows
  };
}

module.exports = {
  normalizeJoinedText,
  planHasProtectedBoundarySplit,
  planSubtitleGroup,
  planSubtitleGroupCandidates,
  splitTextIntoLines,
  tokenizeUnits
};
