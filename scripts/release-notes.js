#!/usr/bin/env node
/**
 * release-notes.js
 *
 * Prints the CHANGELOG.md section of one version -- the text under
 * `## [<version>] - <date>`, up to the next `## [` heading -- as the notes of
 * its GitHub release (publish.yml). Fails when the section is missing, has
 * no date, or is empty, so a release is never published without its notes:
 * `npm run check` runs it for package.json's version (`check:changelog`), so
 * a version bump without its dated CHANGELOG section fails in the pull
 * request, not at publish time.
 *
 * Usage:
 *   node scripts/release-notes.js                 package.json's version
 *   node scripts/release-notes.js 0.7.0           that version
 *   node scripts/release-notes.js 0.7.0 --check   check only, print nothing
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * The notes of `version` in `changelog`: the lines between its
 * `## [<version>] - <YYYY-MM-DD>` heading and the next `## [` heading,
 * without the blank lines around them.
 *
 * @param {string} changelog - CHANGELOG.md's text
 * @param {string} version - Such as `0.7.0`
 * @returns {string}
 * @throws {Error} When the version has no section, no date, or no notes
 */
function releaseNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start === -1) throw new Error(`CHANGELOG.md has no section for ${version}: add '## [${version}] - <date>'`);
  if (!/^## \[[^\]]+\] - \d{4}-\d{2}-\d{2}\s*$/.test(lines[start])) {
    throw new Error(`CHANGELOG.md's section for ${version} has no date: write '## [${version}] - YYYY-MM-DD'`);
  }
  const next = lines.findIndex((line, i) => i > start && line.startsWith("## ["));
  const notes = lines.slice(start + 1, next === -1 ? undefined : next).join("\n").trim();
  if (!notes) throw new Error(`CHANGELOG.md's section for ${version} is empty`);
  return notes;
}

if (require.main === module) {
  const root = path.join(__dirname, "..");
  const args = process.argv.slice(2);
  const version = args.find((a) => !a.startsWith("--")) ?? JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  try {
    const notes = releaseNotes(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), version);
    if (args.includes("--check")) console.log(`CHANGELOG.md has the notes for ${version}`);
    else process.stdout.write(`${notes}\n`);
  } catch (err) {
    console.error(/** @type {Error} */ (err).message);
    process.exitCode = 1;
  }
}

module.exports = { releaseNotes };
