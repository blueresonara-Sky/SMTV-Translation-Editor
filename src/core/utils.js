function normalizeWhitespace(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePersianSpacing(text) {
  return normalizeWhitespace(text)
    .replace(/\s+([،؛؟!,.:\]])/g, "$1")
    .replace(/([\[("«])\s+/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function countWords(text) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return 0;
  }

  return normalized.split(/\s+/).length;
}

function countCharacters(text) {
  return normalizeWhitespace(text).length;
}

function hasPersian(text) {
  return /[\u0600-\u06ff]/.test(text || "");
}

function hasLatin(text) {
  return /[A-Za-z]/.test(text || "");
}

function isBlankText(text) {
  return normalizeWhitespace(text).length === 0;
}

function isSentenceEnding(text) {
  return /[.!?؟…]["')\]»]*\s*$/.test(normalizeWhitespace(text));
}

function isLikelyHeader(text) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return false;
  }

  if (/^(show|airdate|your language)/i.test(normalized)) {
    return true;
  }

  if (normalized.length > 40 && normalized === normalized.toUpperCase()) {
    return true;
  }

  return false;
}

function isLikelySpeakerCue(text) {
  return /:\s*$/.test(normalizeWhitespace(text));
}

function isSourceLikeText(text) {
  const normalized = normalizeWhitespace(text);
  return /^[[(（].{1,80}[\])）]$/.test(normalized);
}

function isUrlLikeText(text) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return false;
  }

  return /^(?:https?:\/\/|www\.|[A-Za-z0-9-]+\.(?:com|org|net|tv|ir|vn|news|co)(?:\/|$))/i.test(
    normalized
  );
}

function isMetaLikeText(text) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return false;
  }

  if (isSourceLikeText(normalized) || isUrlLikeText(normalized)) {
    return true;
  }

  if (/^(?:source|video|footage|courtesy|credit)s?:/i.test(normalized)) {
    return true;
  }

  const lettersOnly = normalized.replace(/[^A-Za-z]/g, "");
  if (
    lettersOnly.length >= 4 &&
    lettersOnly === lettersOnly.toUpperCase() &&
    normalized.split(/\s+/).length <= 4
  ) {
    return true;
  }

  return false;
}

function isDateLikeText(text) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return false;
  }

  return /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|march|april|june|july|august|september|october|november|december)\b/i.test(
    normalized
  ) || /\b\d{4}\b/.test(normalized);
}

function isTitleLikeText(text) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return false;
  }

  if (/news scroll|daily news/i.test(normalized)) {
    return true;
  }

  const lettersOnly = normalized.replace(/[^A-Za-z]/g, "");
  if (lettersOnly.length >= 8 && lettersOnly === lettersOnly.toUpperCase()) {
    return true;
  }

  return false;
}

function classifyEnglishRowType(text) {
  if (isMetaLikeText(text)) {
    return "source";
  }

  if (isDateLikeText(text)) {
    return "date";
  }

  if (isTitleLikeText(text)) {
    return "title";
  }

  return "normal";
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

function unique(items) {
  return [...new Set(items)];
}

module.exports = {
  countCharacters,
  countWords,
  hasLatin,
  hasPersian,
  classifyEnglishRowType,
  isBlankText,
  isDateLikeText,
  isLikelyHeader,
  isLikelySpeakerCue,
  isMetaLikeText,
  isSourceLikeText,
  isSentenceEnding,
  isTitleLikeText,
  isUrlLikeText,
  normalizePersianSpacing,
  normalizeWhitespace,
  safeJsonParse,
  unique
};
