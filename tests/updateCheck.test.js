const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildUpdateStatus,
  compareVersions,
  normalizeVersion
} = require("../src/core/updateCheck");

test("normalizeVersion trims a leading v", () => {
  assert.equal(normalizeVersion("v0.1.0"), "0.1.0");
});

test("compareVersions detects a newer release", () => {
  assert.equal(compareVersions("0.1.1", "0.1.0"), 1);
  assert.equal(compareVersions("0.1.0", "0.1.1"), -1);
  assert.equal(compareVersions("0.1.0", "0.1.0"), 0);
});

test("buildUpdateStatus reports update available", () => {
  const status = buildUpdateStatus("0.1.0", {
    tag_name: "v0.2.0",
    html_url: "https://github.com/example/releases/tag/v0.2.0"
  });

  assert.equal(status.status, "update-available");
  assert.equal(status.latestVersion, "0.2.0");
});

test("buildUpdateStatus reports current version is up to date", () => {
  const status = buildUpdateStatus("0.1.0", {
    tag_name: "v0.1.0",
    html_url: "https://github.com/example/releases/tag/v0.1.0"
  });

  assert.equal(status.status, "up-to-date");
  assert.match(status.message, /Up to date/i);
});
