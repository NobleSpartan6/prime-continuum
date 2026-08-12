const { realpathSync } = require("node:fs");
const { resolve, sep } = require("node:path");

const ownPath = realpathSync(__filename);
const values = process.argv.slice(1);
let ownIndex = -1;
for (let index = 0; index < values.length; index += 1) {
  try {
    if (realpathSync(values[index]) === ownPath) ownIndex = index;
  } catch {
    // Ignore non-path options while locating the verified shim.
  }
}
const target = values[ownIndex + 1];
if (ownIndex < 0 || !target) throw new Error("Verified Electron Node shim target is missing.");
const targetPath = realpathSync(resolve(target));
const expectedSuffix = ["playwright-core", "lib", "entry", "cliDaemon.js"].join(sep);
if (!targetPath.endsWith(expectedSuffix)) throw new Error("Verified Electron Node shim target is not allowed.");

// Commander detects process.versions.electron and strips only argv[0]. Omit
// the script locator so the daemon receives exactly its documented args.
process.argv = [process.execPath, ...values.slice(ownIndex + 2)];
require(targetPath);
