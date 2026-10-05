// @ts-check
/**
 * @fileoverview Unit tests for scripts/release-notes.js: a version's notes,
 * taken from its CHANGELOG.md section for its GitHub release.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { releaseNotes } = require("../../scripts/release-notes.js");

const CHANGELOG = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "### Added",
  "",
  "- Not released yet",
  "",
  "## [0.2.0] - 2026-10-05",
  "",
  "### Added",
  "",
  "- Something new",
  "",
  "### Fixed",
  "",
  "- Something broken",
  "",
  "## [0.1.0] - 2026-09-01",
  "",
  "- The first release",
  "",
].join("\n");

describe("releaseNotes", () => {
  it("gives a version's section, without its heading or the next one", () => {
    assert.equal(releaseNotes(CHANGELOG, "0.2.0"), "### Added\n\n- Something new\n\n### Fixed\n\n- Something broken");
  });

  it("gives the last section, up to the end of the file", () => {
    assert.equal(releaseNotes(CHANGELOG, "0.1.0"), "- The first release");
  });

  it("reads a file with Windows line endings", () => {
    assert.equal(releaseNotes(CHANGELOG.replace(/\n/g, "\r\n"), "0.1.0"), "- The first release");
  });

  it("refuses a version without a section, a date or notes", () => {
    assert.throws(() => releaseNotes(CHANGELOG, "0.3.0"), /no section for 0\.3\.0/);
    assert.throws(() => releaseNotes(CHANGELOG, "0.2"), /no section for 0\.2/, "not a prefix of another version");
    assert.throws(() => releaseNotes(CHANGELOG.replace("## [0.2.0] - 2026-10-05", "## [0.2.0]"), "0.2.0"), /has no date/);
    assert.throws(() => releaseNotes(CHANGELOG.replace("- The first release", ""), "0.1.0"), /is empty/);
  });
});
