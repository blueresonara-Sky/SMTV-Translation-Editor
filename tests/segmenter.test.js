const test = require("node:test");
const assert = require("node:assert/strict");
const {
  planHasProtectedBoundarySplit,
  planSubtitleGroup,
  planSubtitleGroupCandidates,
  splitTextIntoLines,
  tokenizeUnits
} = require("../src/core/segmenter");
const { validateLineText } = require("../src/core/validator");

test("validateLineText allows more than 9 words when chars stay within 45", () => {
  const verdict = validateLineText("یک دو سه چهار پنج شش هفت هشت نه ده");
  assert.equal(verdict.valid, true);
});

test("validateLineText rejects a line over 45 characters even if word count is low", () => {
  const verdict = validateLineText("این جمله با تعداد واژه کم از چهل و پنج نویسه بیشتر است");
  assert.equal(verdict.valid, false);
});

test("tokenizeUnits keeps quoted phrases together", () => {
  const units = tokenizeUnits('او گفت "صبح بخیر" و رفت');
  assert.ok(units.some((unit) => unit.includes("صبح") && unit.includes("بخیر")));
});

test("tokenizeUnits keeps protected Persian phrases together", () => {
  const units = tokenizeUnits("در پی این خبر کریستف کلمب بازگشت");
  assert.ok(units.includes("در پی"));
  assert.ok(units.includes("کریستف کلمب"));
});

test("tokenizeUnits keeps noun-adjective phrases together when they form a nominal unit", () => {
  const units = tokenizeUnits("مردم شگفت‌انگیز مغولستان در نیروی خدای قادر مطلق");
  assert.ok(units.includes("مردم شگفت‌انگیز مغولستان"));
  assert.ok(units.includes("خدای قادر مطلق"));
});

test("tokenizeUnits keeps Gemini-suggested protected phrases together", () => {
  const units = tokenizeUnits("alpha foo bar omega", {
    extraProtectedPhrases: ["foo bar"]
  });
  assert.ok(units.some((unit) => unit.includes("foo bar")));
});

test("splitTextIntoLines uses the requested number of rows", () => {
  const lines = splitTextIntoLines(
    "این یک جمله نمونه برای تقسیم شدن بین دو خط است",
    2,
    ["This is a sample sentence", "for splitting into two lines."]
  );

  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => validateLineText(line).valid));
});

test("planSubtitleGroup prefers repeating a valid merged two-row line", () => {
  const result = planSubtitleGroup([
    {
      rowNumber: 10,
      englishText: "Traveling by open-air boat",
      persianText: "وقتی با قایق روباز"
    },
    {
      rowNumber: 11,
      englishText: "between islands.",
      persianText: "میان جزیره‌ها می‌روید"
    }
  ]);

  assert.equal(result.flagged, false);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].persianText, result.rows[1].persianText);
});

test("planSubtitleGroup falls back to split lines when the merged line is too long", () => {
  const result = planSubtitleGroup([
    {
      rowNumber: 20,
      englishText: "This line is quite long",
      persianText: "این یک جمله نمونه بسیار بلند برای"
    },
    {
      rowNumber: 21,
      englishText: "and continues even more.",
      persianText: "آزمایش حالت تقسیم بر اساس طول متن است"
    }
  ]);

  assert.equal(result.rows.length, 2);
  assert.notEqual(result.rows[0].persianText, result.rows[1].persianText);
});

test("planSubtitleGroup can keep row 1 alone and merge rows 2 and 3", () => {
  const result = planSubtitleGroup([
    {
      rowNumber: 30,
      englishText: "First row stays alone.",
      persianText: "alpha beta gamma delta epsilon zeta thetaa"
    },
    {
      rowNumber: 31,
      englishText: "Second row",
      persianText: "eta"
    },
    {
      rowNumber: 32,
      englishText: "Third row.",
      persianText: "iota kappa"
    }
  ]);

  assert.equal(result.flagged, false);
  assert.equal(result.rows.length, 3);
  assert.equal(result.rows[0].strategy, "single");
  assert.equal(result.rows[1].strategy, "repeat");
  assert.equal(result.rows[2].strategy, "repeat");
  assert.equal(result.rows[1].persianText, result.rows[2].persianText);
});

test("planSubtitleGroup respects preferred block sizes", () => {
  const result = planSubtitleGroup(
    [
      {
        rowNumber: 40,
        englishText: "First row stays alone.",
        persianText: "alpha beta gamma delta epsilon zeta thetaa"
      },
      {
        rowNumber: 41,
        englishText: "Second row",
        persianText: "eta"
      },
      {
        rowNumber: 42,
        englishText: "Third row.",
        persianText: "iota kappa"
      }
    ],
    { preferredBlockSizes: [1, 2] }
  );

  assert.equal(result.flagged, false);
  assert.equal(result.rows[0].strategy, "single");
  assert.equal(result.rows[1].strategy, "repeat");
  assert.equal(result.rows[2].strategy, "repeat");
});

test("preferred block sizes are ignored when they split a protected phrase", () => {
  const result = planSubtitleGroup(
    [
      {
        rowNumber: 50,
        englishText: "Christopher",
        persianText: "foo"
      },
      {
        rowNumber: 51,
        englishText: "Columbus.",
        persianText: "bar baz"
      }
    ],
    {
      preferredBlockSizes: [1, 1],
      extraProtectedPhrases: ["foo bar"]
    }
  );

  assert.equal(result.flagged, false);
  assert.equal(result.rows[0].persianText, "foo bar");
  assert.equal(result.rows[1].persianText, "baz");
  assert.equal(result.rows[0].strategy, "single");
  assert.equal(result.rows[1].strategy, "single");
});

test("planHasProtectedBoundarySplit detects a broken protected phrase", () => {
  const broken = planHasProtectedBoundarySplit(
    [
      { persianText: "foo" },
      { persianText: "bar baz" }
    ],
    { extraProtectedPhrases: ["foo bar"] }
  );

  assert.equal(broken, true);
});

test("planSubtitleGroup does not use a three-row repeat by default", () => {
  const result = planSubtitleGroup([
    {
      rowNumber: 60,
      englishText: "Row one",
      persianText: "alpha"
    },
    {
      rowNumber: 61,
      englishText: "Row two",
      persianText: "beta"
    },
    {
      rowNumber: 62,
      englishText: "Row three.",
      persianText: "gamma"
    }
  ]);

  assert.equal(result.rows.length, 3);
  assert.notEqual(new Set(result.rows.map((row) => row.persianText)).size, 1);
});

test("planSubtitleGroup can merge a short title row with its date row", () => {
  const result = planSubtitleGroup([
    {
      rowNumber: 70,
      englishText: "DAILY NEWS Stream -",
      persianText: "\u0627\u062e\u0628\u0627\u0631 \u0631\u0648\u0632\u0627\u0646\u0647 \u2013"
    },
    {
      rowNumber: 71,
      englishText: "March 28, 2026",
      persianText: "\u06f2\u06f8 \u0645\u0627\u0631\u0633 \u06f2\u06f0\u06f2\u06f6"
    }
  ]);

  assert.equal(result.flagged, false);
  assert.equal(result.rows[0].persianText, result.rows[1].persianText);
});

test("planSubtitleGroupCandidates exposes alternative valid layouts for ambiguous groups", () => {
  const candidates = planSubtitleGroupCandidates([
    {
      rowNumber: 80,
      englishText: "First row",
      persianText: "short bit"
    },
    {
      rowNumber: 81,
      englishText: "Second row",
      persianText: "middle"
    },
    {
      rowNumber: 82,
      englishText: "Third row.",
      persianText: "ending words"
    }
  ]);

  assert.ok(candidates.length >= 2);
  assert.ok(candidates[0].blocks.length >= 1);
  assert.equal(candidates[0].rows.length, 3);
});

test("planSubtitleGroup considers the full sentence and can prefer a middle merge", () => {
  const result = planSubtitleGroup(
    [
      {
        rowNumber: 90,
        englishText: "Lead-in line.",
        persianText: "alpha beta gamma delta epsilon zeta"
      },
      {
        rowNumber: 91,
        englishText: "Christopher",
        persianText: "foo"
      },
      {
        rowNumber: 92,
        englishText: "Columbus",
        persianText: "bar"
      },
      {
        rowNumber: 93,
        englishText: "returned",
        persianText: "baz"
      },
      {
        rowNumber: 94,
        englishText: "today.",
        persianText: "qux quux"
      }
    ],
    {
      extraProtectedPhrases: ["foo bar"]
    }
  );

  assert.equal(result.flagged, false);
  assert.equal(result.rows[0].strategy, "single");
  assert.equal(result.rows[1].strategy, "repeat");
  assert.equal(result.rows[2].strategy, "repeat");
  assert.equal(result.rows[1].persianText, result.rows[2].persianText);
  assert.equal(result.rows[3].strategy, "repeat");
  assert.equal(result.rows[4].strategy, "repeat");
});

test("planSubtitleGroup can merge forward across a comma when the next line continues the sentence", () => {
  const result = planSubtitleGroup([
    {
      rowNumber: 100,
      englishText: "Lead line stays alone.",
      persianText: "alpha beta gamma delta epsilon zeta"
    },
    {
      rowNumber: 101,
      englishText: "He said,",
      persianText: "foo,"
    },
    {
      rowNumber: 102,
      englishText: "that he should leave.",
      persianText: "bar baz"
    }
  ]);

  assert.equal(result.flagged, false);
  assert.equal(result.rows[0].strategy, "single");
  assert.equal(result.rows[1].strategy, "repeat");
  assert.equal(result.rows[2].strategy, "repeat");
  assert.equal(result.rows[1].persianText, "foo, bar baz");
});

test("planSubtitleGroup avoids keeping all three rows split in a mergeable comma-clause example", () => {
  const result = planSubtitleGroup([
    {
      rowNumber: 79,
      englishText: "SM: If you could see it,",
      persianText: "اگر می‌توانستید"
    },
    {
      rowNumber: 80,
      englishText: "it looked like there was mud",
      persianText: "ببینید، انگار گل‌ولای"
    },
    {
      rowNumber: 81,
      englishText: "mixed together with the food.",
      persianText: "با غذا قاطی شده بود."
    }
  ]);

  assert.equal(result.flagged, false);
  assert.ok(result.rows.some((row) => row.strategy === "repeat"));
});

test("planSubtitleGroupCandidates includes a comma-preserving five-row layout when later pair merges are valid", () => {
  const candidates = planSubtitleGroupCandidates(
    [
      {
        rowNumber: 548,
        englishText: "Under veterinary care,",
        persianText: "alpha beta gamma,"
      },
      {
        rowNumber: 549,
        englishText: "the bird-individual",
        persianText: "delta epsilon"
      },
      {
        rowNumber: 550,
        englishText: "recovered quickly and",
        persianText: "zeta eta theta"
      },
      {
        rowNumber: 551,
        englishText: "was awaiting release",
        persianText: "iota kappa lambda"
      },
      {
        rowNumber: 552,
        englishText: "back into the wild.",
        persianText: "mu nu xi."
      }
    ],
    {
      styleProfile: {
        profileId: "nwn",
        constraints: {
          overall: {
            preferredCharMin: 20,
            preferredCharTarget: 30,
            preferredCharMax: 45,
            softCharMax: 45,
            hardCharMax: 60,
            preferredWordTarget: 6,
            preferredWordMax: 9,
            hardWordMax: 12
          }
        },
        repeat: {
          rates: { "1": 0.5, "2": 0.5, "3": 0, "4": 0 },
          allowTripleRepeat: false
        },
        titleDate: { mergeRate: 0 }
      }
    }
  );

  const desired = candidates.find((candidate) => {
    const rows = candidate.rows;
    return (
      rows[0]?.strategy === "single" &&
      rows[1]?.persianText === rows[2]?.persianText &&
      rows[3]?.persianText === rows[4]?.persianText
    );
  });

  assert.ok(desired);
});

test("planSubtitleGroup prefers keeping a strong comma row single when later pairs merge better", () => {
  const result = planSubtitleGroup(
    [
      {
        rowNumber: 548,
        englishText: "Under veterinary care,",
        persianText: "alpha beta gamma,"
      },
      {
        rowNumber: 549,
        englishText: "the bird-individual",
        persianText: "delta epsilon"
      },
      {
        rowNumber: 550,
        englishText: "recovered quickly and",
        persianText: "zeta eta theta"
      },
      {
        rowNumber: 551,
        englishText: "was awaiting release",
        persianText: "iota kappa lambda"
      },
      {
        rowNumber: 552,
        englishText: "back into the wild.",
        persianText: "mu nu xi."
      }
    ],
    {
      styleProfile: {
        profileId: "nwn",
        constraints: {
          overall: {
            preferredCharMin: 20,
            preferredCharTarget: 30,
            preferredCharMax: 45,
            softCharMax: 45,
            hardCharMax: 60,
            preferredWordTarget: 6,
            preferredWordMax: 9,
            hardWordMax: 12
          }
        },
        repeat: {
          rates: { "1": 0.5, "2": 0.5, "3": 0, "4": 0 },
          allowTripleRepeat: false
        },
        titleDate: { mergeRate: 0 }
      }
    }
  );

  assert.equal(result.rows[0].strategy, "single");
  assert.equal(result.rows[1].strategy, "repeat");
  assert.equal(result.rows[2].strategy, "repeat");
  assert.equal(result.rows[3].strategy, "repeat");
  assert.equal(result.rows[4].strategy, "repeat");
});

test("planSubtitleGroup exposes a full-group reallocation candidate that ignores original row-local text", () => {
  const result = planSubtitleGroup(
    [
      {
        rowNumber: 200,
        englishText: "This is a considerably longer English row than the others.",
        persianText: "alpha"
      },
      {
        rowNumber: 201,
        englishText: "short",
        persianText: "beta"
      },
      {
        rowNumber: 202,
        englishText: "tiny.",
        persianText: "gamma delta"
      }
    ],
    {
      preferredBlockSizes: [1, 2]
    }
  );

  assert.equal(result.flagged, false);
  assert.ok(
    result.candidatePlans.some((candidate) =>
      candidate.rows[0]?.persianText === "alpha beta" &&
      candidate.rows[0]?.strategy === "repeat" &&
      candidate.rows[1]?.persianText === "alpha beta" &&
      candidate.rows[2]?.persianText === "gamma delta"
    )
  );
});
