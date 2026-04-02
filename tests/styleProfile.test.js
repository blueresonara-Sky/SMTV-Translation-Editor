const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildConstraintStats,
  buildRepeatMetrics,
  inferLearningCategory
} = require("../src/core/styleProfile");
const { validateLineText } = require("../src/core/validator");

test("buildConstraintStats derives learned limits from observed lines", () => {
  const stats = buildConstraintStats({
    charCounts: [28, 31, 35, 42, 47, 49],
    wordCounts: [5, 6, 7, 8, 9, 10],
    lineCount: 6
  });

  assert.ok(stats.preferredCharMax >= 42);
  assert.ok(stats.hardCharMax >= 49);
  assert.ok(stats.preferredWordMax >= 8);
});

test("buildRepeatMetrics marks triple repeat as disallowed when absent", () => {
  const repeat = buildRepeatMetrics({
    "1": 70,
    "2": 30,
    "3": 0,
    "4": 0
  });

  assert.equal(repeat.allowTripleRepeat, false);
  assert.equal(repeat.rates["2"], 0.3);
});

test("validateLineText uses learned hard char limit when provided", () => {
  const verdict = validateLineText("one two three four five six seven eight", {
    styleProfile: {
      constraints: {
        overall: {
          preferredCharMin: 12,
          preferredCharTarget: 24,
          preferredCharMax: 45,
          softCharMax: 48,
          hardCharMax: 55,
          preferredWordTarget: 6,
          preferredWordMax: 9,
          hardWordMax: 12
        },
        byRowType: {}
      }
    }
  });

  assert.equal(verdict.valid, true);
  assert.equal(verdict.limits.hardCharMax, 55);
});

test("inferLearningCategory routes known prefixes to their category profiles", () => {
  assert.equal(inferLearningCategory("D:\\Downloads\\Translation\\NWN 3092 sf1 - table fix1_PER.docx"), "nwn");
  assert.equal(inferLearningCategory("D:\\Downloads\\Translation\\News Scroll NS 3098 - table_PER.docx"), "nwn");
  assert.equal(inferLearningCategory("D:\\Downloads\\Translation\\BMD 3098 something.docx"), "bmd");
  assert.equal(inferLearningCategory("D:\\Downloads\\Translation\\AW 3020 something.docx"), "bmd");
  assert.equal(inferLearningCategory("D:\\Downloads\\Translation\\LS 2833 something.docx"), "bmd");
  assert.equal(inferLearningCategory("D:\\Downloads\\Translation\\UL 3091 something.docx"), "bmd");
});
