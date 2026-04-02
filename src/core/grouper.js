const {
  classifyEnglishRowType,
  hasPersian,
  isBlankText,
  isLikelyHeader,
  isLikelySpeakerCue,
  isSentenceEnding
} = require("./utils");

function findSubtitleStartIndex(rows) {
  const index = rows.findIndex(
    (row) => hasPersian(row.persianText) && !isBlankText(row.englishText)
  );
  return index === -1 ? 0 : index;
}

function classifyRow(row, subtitleStartIndex) {
  if (row.index < subtitleStartIndex) {
    return "skip";
  }

  if (row.isBlankRow) {
    return "blank";
  }

  if (isBlankText(row.persianText)) {
    return "locked";
  }

  if (
    isLikelyHeader(row.englishText) || isLikelySpeakerCue(row.englishText)
  ) {
    return "locked";
  }

  if (classifyEnglishRowType(row.englishText) === "source") {
    return "meta";
  }

  return "subtitle";
}

function buildSentenceGroups(rows) {
  const subtitleStartIndex = findSubtitleStartIndex(rows);
  const groups = [];
  let current = null;

  function flushCurrent() {
    if (current && current.rows.length > 0) {
      groups.push(current);
    }
    current = null;
  }

  for (const row of rows) {
    const kind = classifyRow(row, subtitleStartIndex);

    if (kind === "skip" || kind === "blank" || kind === "locked" || kind === "meta") {
      flushCurrent();
      groups.push({
        type: kind,
        rows: [row]
      });
      continue;
    }

    if (!current) {
      current = { type: "subtitle", rows: [] };
    }

    current.rows.push(row);

    if (isSentenceEnding(row.englishText)) {
      flushCurrent();
    }
  }

  flushCurrent();
  return groups;
}

module.exports = {
  buildSentenceGroups,
  classifyRow,
  findSubtitleStartIndex
};
