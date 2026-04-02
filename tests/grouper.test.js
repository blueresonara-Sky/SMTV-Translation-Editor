const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSentenceGroups } = require("../src/core/grouper");

test("buildSentenceGroups leaves headers alone and groups subtitle sentences", () => {
  const rows = [
    {
      index: 0,
      rowNumber: 1,
      englishText: "YOUR LANGUAGE:",
      persianText: "",
      isBlankRow: false,
      hasGrayHighlight: false
    },
    {
      index: 1,
      rowNumber: 2,
      englishText: "Traveling by open-air boat",
      persianText: "وقتی با قایق روباز",
      isBlankRow: false,
      hasGrayHighlight: false
    },
    {
      index: 2,
      rowNumber: 3,
      englishText: "between islands.",
      persianText: "میان جزیره‌ها می‌روید",
      isBlankRow: false,
      hasGrayHighlight: false
    },
    {
      index: 3,
      rowNumber: 4,
      englishText: "",
      persianText: "",
      isBlankRow: true,
      hasGrayHighlight: false
    }
  ];

  const groups = buildSentenceGroups(rows);
  assert.equal(groups[0].type, "skip");
  assert.equal(groups[1].type, "subtitle");
  assert.equal(groups[1].rows.length, 2);
  assert.equal(groups[2].type, "blank");
});

test("buildSentenceGroups isolates source/meta rows from subtitle sentence planning", () => {
  const rows = [
    {
      index: 0,
      rowNumber: 1,
      englishText: "Normal subtitle start",
      persianText: "شروع معمولی زیرنویس",
      isBlankRow: false,
      hasGrayHighlight: false
    },
    {
      index: 1,
      rowNumber: 2,
      englishText: "(VietnamPlus)",
      persianText: "(ویتنام پلاس)",
      isBlankRow: false,
      hasGrayHighlight: false
    },
    {
      index: 2,
      rowNumber: 3,
      englishText: "This sentence continues.",
      persianText: "ادامه جمله",
      isBlankRow: false,
      hasGrayHighlight: false
    }
  ];

  const groups = buildSentenceGroups(rows);
  assert.equal(groups[0].type, "subtitle");
  assert.equal(groups[0].rows.length, 1);
  assert.equal(groups[1].type, "meta");
  assert.equal(groups[2].type, "subtitle");
  assert.equal(groups[2].rows.length, 1);
});

test("buildSentenceGroups preserves rows with blank Persian text as locked", () => {
  const rows = [
    {
      index: 0,
      rowNumber: 1,
      englishText: "You all would have run off.",
      persianText: "همتان فرار کرده بودید.",
      isBlankRow: false,
      hasGrayHighlight: false
    },
    {
      index: 1,
      rowNumber: 2,
      englishText: "L490-532",
      persianText: "",
      isBlankRow: false,
      hasGrayHighlight: false
    }
  ];

  const groups = buildSentenceGroups(rows);
  assert.equal(groups[0].type, "subtitle");
  assert.equal(groups[0].rows.length, 1);
  assert.equal(groups[1].type, "locked");
  assert.equal(groups[1].rows.length, 1);
});
