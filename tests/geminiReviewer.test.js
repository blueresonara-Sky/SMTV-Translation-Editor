const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyPlanningHintResult,
  applyCandidateRankingResult,
  applyEditedRowsResult,
  shouldReviewWithGemini
} = require("../src/core/geminiReviewer");

test("shouldReviewWithGemini includes ambiguous groups with multiple candidate plans", () => {
  const reviewable = shouldReviewWithGemini({
    flagged: false,
    ambiguous: true,
    candidatePlans: [
      { rows: [{ persianText: "alpha" }], blocks: [{ rowNumbers: [1] }] },
      { rows: [{ persianText: "beta" }], blocks: [{ rowNumbers: [1] }] }
    ],
    draftRows: [{ persianText: "alpha" }],
    rows: [{ persianText: "alpha" }]
  });

  assert.equal(reviewable, true);
});

test("shouldReviewWithGemini includes awkward valid NWN groups with multiple singles", () => {
  const reviewable = shouldReviewWithGemini({
    flagged: false,
    ambiguous: false,
    styleProfile: { profileId: "nwn" },
    candidatePlans: [
      { rows: [{ persianText: "alpha" }], blocks: [{ rowNumbers: [1] }] },
      { rows: [{ persianText: "beta" }], blocks: [{ rowNumbers: [1] }] }
    ],
    draftRows: [
      { persianText: "اگر می‌توانستید", strategy: "single" },
      { persianText: "ببینید، انگار گل‌ولای", strategy: "single" },
      { persianText: "با غذا قاطی شده بود.", strategy: "single" },
      { persianText: "واقعاً عجیب بود.", strategy: "single" }
    ],
    rows: [
      { englishText: "If you could see it,", persianText: "اگر می‌توانستید" },
      { englishText: "it looked like there was mud", persianText: "ببینید، انگار گل‌ولای" },
      { englishText: "mixed together with the food", persianText: "با غذا قاطی شده بود." },
      { englishText: "It was really strange.", persianText: "واقعاً عجیب بود." }
    ]
  });

  assert.equal(reviewable, true);
});

test("applyCandidateRankingResult accepts a valid ranked candidate choice", () => {
  const result = applyCandidateRankingResult(
    {
      rows: [
        { rowNumber: 1, englishText: "A", persianText: "one" },
        { rowNumber: 2, englishText: "B", persianText: "two" }
      ],
      candidatePlans: [
        {
          rows: [
            { rowNumber: 1, persianText: "one", strategy: "single" },
            { rowNumber: 2, persianText: "two", strategy: "single" }
          ],
          blocks: [
            { rowNumbers: [1], lines: ["one"] },
            { rowNumbers: [2], lines: ["two"] }
          ]
        },
        {
          rows: [
            { rowNumber: 1, persianText: "one two", strategy: "repeat" },
            { rowNumber: 2, persianText: "one two", strategy: "repeat" }
          ],
          blocks: [{ rowNumbers: [1, 2], lines: ["one two", "one two"] }]
        }
      ]
    },
    {
      selectedCandidateIndex: 1,
      protectedPhrases: [],
      rationale: "Candidate 1 preserves the sentence more naturally."
    }
  );

  assert.equal(result.applied, true);
  assert.equal(result.called, true);
  assert.equal(result.rows[0].persianText, "one two");
  assert.deepEqual(result.preferredBlockSizes, [2]);
});

test("applyPlanningHintResult accepts valid tokenizer and planner hints", () => {
  const result = applyPlanningHintResult(
    {
      rows: [
        { rowNumber: 1, englishText: "Christopher", persianText: "کریستف" },
        { rowNumber: 2, englishText: "Columbus returned.", persianText: "کلمب بازگشت." }
      ]
    },
    {
      preferredBlockSizes: [2],
      keepSingleRows: [],
      mergeWithNextRows: [1],
      protectedPhrases: ["کریستف کلمب"]
    }
  );

  assert.equal(result.applied, true);
  assert.deepEqual(result.preferredBlockSizes, [2]);
  assert.deepEqual(result.protectedPhrases, ["کریستف کلمب"]);
  assert.deepEqual(result.keepSingleRows, []);
  assert.deepEqual(result.mergeWithNextRows, [1]);
});

test("applyCandidateRankingResult rejects out-of-range candidate picks", () => {
  const result = applyCandidateRankingResult(
    {
      rows: [{ rowNumber: 1, englishText: "A", persianText: "one" }],
      candidatePlans: [
        {
          rows: [{ rowNumber: 1, persianText: "one", strategy: "single" }],
          blocks: [{ rowNumbers: [1], lines: ["one"] }]
        }
      ]
    },
    {
      selectedCandidateIndex: 4,
      protectedPhrases: []
    }
  );

  assert.equal(result.applied, false);
  assert.equal(result.called, true);
  assert.match(result.reasons[0], /out-of-range/i);
});

test("applyCandidateRankingResult rejects materially worse AI picks than the local best candidate", () => {
  const result = applyCandidateRankingResult(
    {
      rows: [
        { rowNumber: 1, englishText: "A", persianText: "one" },
        { rowNumber: 2, englishText: "B", persianText: "two" }
      ],
      candidatePlans: [
        {
          score: { stylePenalty: 4, blockCount: 1 },
          rows: [
            { rowNumber: 1, persianText: "one two", strategy: "repeat" },
            { rowNumber: 2, persianText: "one two", strategy: "repeat" }
          ],
          blocks: [{ rowNumbers: [1, 2], lines: ["one two", "one two"] }]
        },
        {
          score: { stylePenalty: 10, blockCount: 2 },
          rows: [
            { rowNumber: 1, persianText: "one", strategy: "single" },
            { rowNumber: 2, persianText: "two", strategy: "single" }
          ],
          blocks: [
            { rowNumbers: [1], lines: ["one"] },
            { rowNumbers: [2], lines: ["two"] }
          ]
        }
      ]
    },
    {
      selectedCandidateIndex: 1,
      protectedPhrases: []
    }
  );

  assert.equal(result.applied, false);
  assert.equal(result.called, true);
  assert.match(result.reasons[0], /materially worse/i);
});

test("applyEditedRowsResult accepts a valid Gemini editing suggestion", () => {
  const result = applyEditedRowsResult(
    {
      rows: [
        { rowNumber: 1, englishText: "He brought the food,", persianText: "غذا را آورد،" },
        { rowNumber: 2, englishText: "but I could not eat it.", persianText: "اما نتوانستم آن را بخورم." }
      ]
    },
    [
      { rowNumber: 1, persianText: "غذا را آورد،", strategy: "single" },
      { rowNumber: 2, persianText: "اما نتوانستم آن را بخورم.", strategy: "single" }
    ],
    {
      editedRows: ["غذا را آورد، اما", "نتوانستم آن را بخورم."],
      protectedPhrases: [],
      suggestions: ["Shifted the connector to improve flow."]
    },
    {
      styleProfile: {
        constraints: {
          overall: {
            preferredCharMin: 12,
            preferredCharTarget: 28,
            preferredCharMax: 45,
            softCharMax: 45,
            hardCharMax: 45,
            preferredWordTarget: 6,
            preferredWordMax: 9,
            hardWordMax: 12
          }
        }
      }
    }
  );

  assert.equal(result.applied, true);
  assert.equal(result.edited, true);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.editSuggestions, ["Shifted the connector to improve flow."]);
});

test("applyEditedRowsResult rejects wrong row counts from Gemini editing", () => {
  const result = applyEditedRowsResult(
    {
      rows: [
        { rowNumber: 1, englishText: "A", persianText: "یک" },
        { rowNumber: 2, englishText: "B", persianText: "دو" }
      ]
    },
    [
      { rowNumber: 1, persianText: "یک", strategy: "single" },
      { rowNumber: 2, persianText: "دو", strategy: "single" }
    ],
    {
      editedRows: ["یک دو"],
      protectedPhrases: []
    },
    {
      styleProfile: {
        constraints: {
          overall: {
            preferredCharMin: 12,
            preferredCharTarget: 28,
            preferredCharMax: 45,
            softCharMax: 45,
            hardCharMax: 45,
            preferredWordTarget: 6,
            preferredWordMax: 9,
            hardWordMax: 12
          }
        }
      }
    }
  );

  assert.equal(result.applied, false);
  assert.match(result.reasons[0], /wrong number/i);
});
