const fs = require("fs/promises");
const path = require("path");
const { loadDocxSubtitleDocument } = require("./docx");
const { buildSentenceGroups } = require("./grouper");
const {
  classifyEnglishRowType,
  countCharacters,
  countWords,
  normalizePersianSpacing,
  normalizeWhitespace
} = require("./utils");

const DEFAULT_DATASET_ROOT = path.resolve(__dirname, "..", "..", "training-data", "style-only");
const DEFAULT_CATEGORY_DATA_ROOT = path.resolve(
  __dirname,
  "..",
  "..",
  "training-data",
  "category-style"
);
const DEFAULT_PROFILE_CACHE_PATH = path.join(DEFAULT_DATASET_ROOT, "style-profile.json");
const DEFAULT_PROFILE_VERSION = 1;

function getCandidateTrainingRoots(...relativeSegments) {
  const candidates = [
    path.resolve(__dirname, "..", "..", ...relativeSegments)
  ];

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "app.asar", ...relativeSegments));
    candidates.push(path.join(process.resourcesPath, ...relativeSegments));
  }

  if (process.execPath) {
    candidates.push(path.join(path.dirname(process.execPath), ...relativeSegments));
  }

  return [...new Set(candidates)];
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (_error) {
    return false;
  }
}

async function resolveExistingPath(...relativeSegments) {
  for (const candidate of getCandidateTrainingRoots(...relativeSegments)) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function loadShippedProfile(profileId, ...relativeSegments) {
  const profilePath = await resolveExistingPath(...relativeSegments, "style-profile.json");
  if (!profilePath) {
    return null;
  }

  try {
    return {
      ...(await readJson(profilePath)),
      profileId
    };
  } catch (_error) {
    return null;
  }
}

async function walkDocxFiles(rootPath, files = []) {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const absolutePath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      await walkDocxFiles(absolutePath, files);
      continue;
    }

    if (entry.isFile() && /\.docx$/i.test(entry.name)) {
      files.push(absolutePath);
    }
  }

  return files;
}

function quantile(values, ratio) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * ratio;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) {
    return sorted[lower];
  }

  const weight = index - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

function roundNumber(value, fallback = 0) {
  return Number.isFinite(value) ? Math.round(value) : fallback;
}

function maxValue(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }

  let maximum = values[0];
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] > maximum) {
      maximum = values[index];
    }
  }
  return maximum;
}

function createObservationBucket() {
  return {
    charCounts: [],
    wordCounts: [],
    lineCount: 0
  };
}

function addObservation(bucket, text) {
  const normalized = normalizePersianSpacing(text);
  if (!normalized) {
    return;
  }

  bucket.charCounts.push(countCharacters(normalized));
  bucket.wordCounts.push(countWords(normalized));
  bucket.lineCount += 1;
}

function buildConstraintStats(bucket) {
  if (!bucket || bucket.lineCount === 0) {
    return null;
  }

  const charQ25 = quantile(bucket.charCounts, 0.25);
  const charQ50 = quantile(bucket.charCounts, 0.5);
  const charQ90 = quantile(bucket.charCounts, 0.9);
  const charQ95 = quantile(bucket.charCounts, 0.95);
  const charMax = maxValue(bucket.charCounts);

  const wordQ50 = quantile(bucket.wordCounts, 0.5);
  const wordQ90 = quantile(bucket.wordCounts, 0.9);
  const wordMax = maxValue(bucket.wordCounts);

  return {
    lineCount: bucket.lineCount,
    preferredCharMin: Math.max(8, roundNumber(charQ25)),
    preferredCharTarget: Math.max(12, roundNumber(charQ50)),
    preferredCharMax: Math.max(24, roundNumber(charQ90)),
    softCharMax: Math.max(30, roundNumber(charQ95)),
    hardCharMax: Math.min(60, Math.max(45, roundNumber(Math.max(charQ95 + 2, charMax)))),
    preferredWordTarget: Math.max(2, roundNumber(wordQ50)),
    preferredWordMax: Math.max(4, roundNumber(wordQ90)),
    hardWordMax: Math.min(16, Math.max(9, roundNumber(Math.max(wordQ90 + 1, wordMax)))),
    observedCharMax: charMax,
    observedWordMax: wordMax
  };
}

function normalizeRunKey(value) {
  const numeric = Number.isInteger(value) ? value : Number(value || 0);
  return String(Math.min(Math.max(numeric, 1), 4));
}

function buildRepeatMetrics(runHistogram) {
  const keys = ["1", "2", "3", "4"];
  const total = keys.reduce((sum, key) => sum + (runHistogram[key] || 0), 0);
  const rates = Object.fromEntries(
    keys.map((key) => [key, total === 0 ? 0 : (runHistogram[key] || 0) / total])
  );

  return {
    histogram: Object.fromEntries(keys.map((key) => [key, runHistogram[key] || 0])),
    rates,
    allowTripleRepeat: rates["3"] >= 0.04 || rates["4"] > 0
  };
}

function buildTitleDateMetrics(totalPairs, mergedPairs) {
  return {
    observedPairs: totalPairs,
    mergedPairs,
    mergeRate: totalPairs === 0 ? 0 : mergedPairs / totalPairs
  };
}

function countMergedRun(rows, startIndex) {
  const text = normalizePersianSpacing(rows[startIndex].persianText);
  let span = 1;
  while (
    startIndex + span < rows.length &&
    normalizePersianSpacing(rows[startIndex + span].persianText) === text
  ) {
    span += 1;
  }
  return span;
}

function isTitleDatePair(rows, index) {
  if (index + 1 >= rows.length) {
    return false;
  }

  return (
    classifyEnglishRowType(rows[index].englishText) === "title" &&
    classifyEnglishRowType(rows[index + 1].englishText) === "date"
  );
}

async function collectDatasetFiles(datasetRoot) {
  const indexPath = path.join(datasetRoot, "index.json");

  try {
    const indexText = await fs.readFile(indexPath, "utf8");
    const parsed = JSON.parse(indexText);
    if (Array.isArray(parsed.items) && parsed.items.length > 0) {
      return parsed.items
        .map((item) => item?.copiedPath)
        .filter(Boolean)
        .map((filePath) => path.resolve(filePath));
    }
  } catch (_error) {
    // Fall back to scanning the dataset folders.
  }

  return walkDocxFiles(datasetRoot);
}

async function buildStyleProfile(datasetRoot = DEFAULT_DATASET_ROOT, options = {}) {
  const files = await collectDatasetFiles(datasetRoot);
  const existingFiles = [];

  for (const filePath of files) {
    try {
      await fs.access(filePath);
      existingFiles.push(filePath);
    } catch (_error) {
      // Ignore missing files in the manifest.
    }
  }

  const overall = createObservationBucket();
  const byRowType = {
    normal: createObservationBucket(),
    title: createObservationBucket(),
    date: createObservationBucket(),
    source: createObservationBucket()
  };
  const runHistogram = { "1": 0, "2": 0, "3": 0, "4": 0 };
  let subtitleGroupCount = 0;
  let subtitleRowCount = 0;
  let titleDatePairCount = 0;
  let titleDateMergedCount = 0;

  for (const filePath of existingFiles) {
    const model = await loadDocxSubtitleDocument(filePath);
    const groups = buildSentenceGroups(model.rows);

    for (const group of groups) {
      if (group.type !== "subtitle") {
        continue;
      }

      subtitleGroupCount += 1;
      const rows = group.rows;
      subtitleRowCount += rows.length;

      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const text = normalizePersianSpacing(row.persianText);
        if (!text) {
          continue;
        }

        addObservation(overall, text);
        const rowType = classifyEnglishRowType(row.englishText);
        addObservation(byRowType[rowType] || byRowType.normal, text);

        if (index > 0 && normalizePersianSpacing(rows[index - 1].persianText) === text) {
          continue;
        }

        const runSize = countMergedRun(rows, index);
        runHistogram[normalizeRunKey(runSize)] += 1;

        if (isTitleDatePair(rows, index)) {
          titleDatePairCount += 1;
          if (runSize >= 2) {
            titleDateMergedCount += 1;
          }
        }
      }
    }
  }

  const constraints = {
    overall: buildConstraintStats(overall),
    byRowType: Object.fromEntries(
      Object.entries(byRowType)
        .map(([key, bucket]) => [key, buildConstraintStats(bucket)])
        .filter(([, value]) => value)
    )
  };

  const repeat = buildRepeatMetrics(runHistogram);
  const titleDate = buildTitleDateMetrics(titleDatePairCount, titleDateMergedCount);

  return {
    version: DEFAULT_PROFILE_VERSION,
    generatedAt: new Date().toISOString(),
    profileId: options.profileId || "default",
    datasetRoot,
    datasetItemCount: existingFiles.length,
    subtitleGroupCount,
    subtitleRowCount,
    constraints,
    repeat,
    titleDate
  };
}

async function readJson(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content);
}

async function getDatasetFingerprint(datasetRoot) {
  const files = await collectDatasetFiles(datasetRoot);
  let latestMtimeMs = 0;
  let existingCount = 0;

  for (const filePath of files) {
    try {
      const stat = await fs.stat(filePath);
      existingCount += 1;
      latestMtimeMs = Math.max(latestMtimeMs, stat.mtimeMs);
    } catch (_error) {
      // Ignore missing files referenced by the manifest.
    }
  }

  return {
    existingCount,
    latestMtimeMs
  };
}

async function isProfileCacheFresh(cachePath, datasetRoot) {
  try {
    const cacheStat = await fs.stat(cachePath);
    const fingerprint = await getDatasetFingerprint(datasetRoot);
    if (fingerprint.existingCount === 0) {
      return true;
    }
    return (
      cacheStat.mtimeMs >= fingerprint.latestMtimeMs
    );
  } catch (_error) {
    return false;
  }
}

async function loadStyleProfile(options = {}) {
  const datasetRoot = options.datasetRoot || DEFAULT_DATASET_ROOT;
  const cachePath = options.cachePath || DEFAULT_PROFILE_CACHE_PATH;
  const profileId = options.profileId || "default";

  try {
    await fs.access(datasetRoot);
  } catch (_error) {
    return null;
  }

  if (!options.forceRefresh && (await isProfileCacheFresh(cachePath, datasetRoot))) {
    try {
      return {
        ...(await readJson(cachePath)),
        profileId
      };
    } catch (_error) {
      // Fall through and rebuild if the cache is unreadable.
    }
  }

  const profile = await buildStyleProfile(datasetRoot, { profileId });
  await fs.writeFile(cachePath, JSON.stringify(profile, null, 2), "utf8");
  return profile;
}

function inferLearningCategory(inputPath) {
  const baseName = path.basename(String(inputPath || "")).toUpperCase();

  if (/^NWN\b/.test(baseName) || /^NEWS SCROLL\b/.test(baseName)) {
    return "nwn";
  }

  return "bmd";
}

async function loadLearningProfileForInput(inputPath, options = {}) {
  const category = inferLearningCategory(inputPath);
  const shippedCategoryProfile = await loadShippedProfile(
    category,
    "training-data",
    "category-style",
    category
  );
  if (shippedCategoryProfile) {
    return shippedCategoryProfile;
  }

  const categoryRoot = await resolveExistingPath("training-data", "category-style", category);
  if (categoryRoot) {
    return loadStyleProfile({
      ...options,
      datasetRoot: categoryRoot,
      cachePath: path.join(categoryRoot, "style-profile.json"),
      profileId: category
    });
  }

  const shippedDefaultProfile = await loadShippedProfile("default", "training-data", "style-only");
  if (shippedDefaultProfile) {
    return shippedDefaultProfile;
  }

  return loadStyleProfile({
    ...options,
    datasetRoot: (await resolveExistingPath("training-data", "style-only")) || DEFAULT_DATASET_ROOT,
    profileId: "default"
  });
}

module.exports = {
  DEFAULT_CATEGORY_DATA_ROOT,
  DEFAULT_DATASET_ROOT,
  DEFAULT_PROFILE_CACHE_PATH,
  buildStyleProfile,
  buildConstraintStats,
  buildRepeatMetrics,
  inferLearningCategory,
  loadLearningProfileForInput,
  loadStyleProfile
};
