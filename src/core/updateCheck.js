const GITHUB_OWNER = "blueresonara-Sky";
const GITHUB_REPO = "SMTV-Translation-Editor";
const GITHUB_LATEST_RELEASE_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const GITHUB_RELEASES_PAGE_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;

function normalizeVersion(value) {
  return String(value || "")
    .trim()
    .replace(/^v/i, "")
    .split(/[+-]/)[0];
}

function compareVersions(left, right) {
  const leftParts = normalizeVersion(left)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = normalizeVersion(right)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] || 0;
    const rightValue = rightParts[index] || 0;
    if (leftValue > rightValue) {
      return 1;
    }
    if (leftValue < rightValue) {
      return -1;
    }
  }

  return 0;
}

function buildUpdateStatus(currentVersion, release = null) {
  if (!release?.tag_name) {
    return {
      ok: false,
      status: "unknown",
      currentVersion,
      latestVersion: null,
      url: GITHUB_RELEASES_PAGE_URL,
      message: "Update status unavailable"
    };
  }

  const latestVersion = normalizeVersion(release.tag_name);
  const comparison = compareVersions(latestVersion, currentVersion);

  if (comparison > 0) {
    return {
      ok: true,
      status: "update-available",
      currentVersion,
      latestVersion,
      url: release.html_url || GITHUB_RELEASES_PAGE_URL,
      message: `Update available: v${latestVersion}`
    };
  }

  return {
    ok: true,
    status: "up-to-date",
    currentVersion,
    latestVersion,
    url: release.html_url || GITHUB_RELEASES_PAGE_URL,
    message: `Up to date: v${currentVersion}`
  };
}

async function fetchLatestRelease(fetchImpl = global.fetch) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Fetch is unavailable in this runtime.");
  }

  const response = await fetchImpl(GITHUB_LATEST_RELEASE_URL, {
    headers: {
      "User-Agent": "SMTV-Translation-Editor"
    }
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`GitHub update check failed with status ${response.status}.`);
  }

  return response.json();
}

async function checkForAppUpdate(currentVersion, fetchImpl = global.fetch) {
  try {
    const latestRelease = await fetchLatestRelease(fetchImpl);
    return buildUpdateStatus(currentVersion, latestRelease);
  } catch (error) {
    return {
      ok: false,
      status: "unknown",
      currentVersion,
      latestVersion: null,
      url: GITHUB_RELEASES_PAGE_URL,
      message: error.message || "Update status unavailable"
    };
  }
}

module.exports = {
  GITHUB_LATEST_RELEASE_URL,
  GITHUB_RELEASES_PAGE_URL,
  buildUpdateStatus,
  checkForAppUpdate,
  compareVersions,
  normalizeVersion
};
