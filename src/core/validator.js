const {
  classifyEnglishRowType,
  countCharacters,
  countWords,
  isBlankText,
  normalizePersianSpacing
} = require("./utils");

function resolveLineConstraints(styleProfile, rowContext = {}) {
  const defaults = {
    preferredCharMin: 12,
    preferredCharTarget: 28,
    preferredCharMax: 45,
    softCharMax: 45,
    hardCharMax: 45,
    preferredWordTarget: 6,
    preferredWordMax: 9,
    hardWordMax: 12
  };

  if (!styleProfile?.constraints?.overall) {
    return defaults;
  }

  const rowType =
    rowContext.rowType ||
    (typeof rowContext.englishText === "string"
      ? classifyEnglishRowType(rowContext.englishText)
      : null);
  const scoped =
    rowType &&
    styleProfile.constraints.byRowType?.[rowType] &&
    styleProfile.constraints.byRowType[rowType].lineCount >= 10
      ? styleProfile.constraints.byRowType[rowType]
      : null;

  return {
    ...defaults,
    ...styleProfile.constraints.overall,
    ...(scoped || {})
  };
}

function validateLineText(text, options = {}) {
  const normalized = normalizePersianSpacing(text);
  const wordCount = countWords(normalized);
  const charCount = countCharacters(normalized);
  const limits = resolveLineConstraints(options.styleProfile, options.rowContext);
  const valid = charCount <= limits.hardCharMax;

  return {
    valid,
    normalized,
    wordCount,
    charCount,
    limits,
    reason: valid
      ? null
      : `Line exceeds the learned hard limit (${wordCount} words, ${charCount} chars, max ${limits.hardCharMax})`
  };
}

function validateRowRewrite(originalRow, nextText, options = {}) {
  if (
    normalizePersianSpacing(nextText) === normalizePersianSpacing(originalRow.persianText)
  ) {
    return { valid: true, reason: null };
  }

  if (originalRow.isBlankRow) {
    return {
      valid: isBlankText(nextText),
      reason: isBlankText(nextText) ? null : "Blank input row must remain blank"
    };
  }

  if (isBlankText(nextText)) {
    return { valid: true, reason: null };
  }

  return validateLineText(nextText, {
    ...options,
    rowContext: { englishText: originalRow.englishText }
  });
}

function validateFinalRows(originalRows, rewrittenRows, options = {}) {
  if (originalRows.length !== rewrittenRows.length) {
    return {
      valid: false,
      reasons: ["Output row count does not match input row count"]
    };
  }

  const reasons = [];

  for (let index = 0; index < originalRows.length; index += 1) {
    const verdict = validateRowRewrite(
      originalRows[index],
      rewrittenRows[index].persianText,
      options
    );
    if (!verdict.valid) {
      reasons.push(`Row ${originalRows[index].rowNumber}: ${verdict.reason}`);
    }
  }

  return {
    valid: reasons.length === 0,
    reasons
  };
}

module.exports = {
  resolveLineConstraints,
  validateFinalRows,
  validateLineText,
  validateRowRewrite
};
