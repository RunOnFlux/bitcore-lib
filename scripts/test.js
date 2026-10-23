'use strict';

/**
 * Runs every test file under test/ in its own mocha process and checks each
 * outcome against test/inherited-failures.json.
 *
 * The inherited suite carries upstream Bitcoin expectations that Flux's
 * address, network, header and sighash formats do not meet. The manifest
 * lists, per file, the tests that fail at runonflux/bitcore-lib 8f5453f and
 * the files that throw while loading. The run fails when:
 *   - a test that is not listed does not pass;
 *   - a listed test passes or a listed file loads (the manifest is stale);
 *   - a file that is not listed as a load failure does not load.
 *
 * Usage: node scripts/test.js [--update]
 *   --update rewrites the manifest from the current outcomes.
 */

var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var TEST_DIR = path.join(ROOT, 'test');
var MANIFEST = path.join(TEST_DIR, 'inherited-failures.json');
var SKIP_DIRS = ['data', 'fixtures'];

var mochaPackage = require.resolve('mocha/package.json');
var MOCHA = path.join(path.dirname(mochaPackage), require(mochaPackage).bin.mocha);

function listTestFiles(dir) {
  var files = [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function(entry) {
    var full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (dir !== TEST_DIR || SKIP_DIRS.indexOf(entry.name) === -1) {
        files = files.concat(listTestFiles(full));
      }
    } else if (entry.name.slice(-3) === '.js') {
      files.push(path.relative(ROOT, full).split(path.sep).join('/'));
    }
  });
  return files.sort();
}

function runFile(file, outDir) {
  var out = path.join(outDir, file.replace(/[\/.]/g, '_') + '.json');
  var result = childProcess.spawnSync(process.execPath, [
    MOCHA, '--no-config', '--timeout', '5000',
    '--reporter', 'json', '--reporter-option', 'output=' + out, file
  ], { cwd: ROOT, encoding: 'utf8' });
  var report;
  try {
    report = JSON.parse(fs.readFileSync(out, 'utf8'));
  } catch (e) {
    return { loadError: (result.stderr || result.stdout || '').trim().split('\n').slice(0, 3).join('\n') };
  }
  return {
    passed: report.passes.map(function(t) { return t.fullTitle; }),
    failed: report.failures.map(function(t) { return t.fullTitle + ' :: ' + ((t.err && t.err.message) || ''); }),
    failedTitles: report.failures.map(function(t) { return t.fullTitle; }),
    pending: report.pending.map(function(t) { return t.fullTitle; })
  };
}

function countOf(list) {
  var counts = {};
  list.forEach(function(title) {
    counts[title] = (counts[title] || 0) + 1;
  });
  return counts;
}

function main() {
  var update = process.argv.indexOf('--update') !== -1;
  var manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : { loadErrors: [], failures: {} };
  var outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitcore-lib-test-'));
  var problems = [];
  var totals = { passed: 0, failed: 0, pending: 0, expectedFailures: 0, loadErrors: 0 };
  var next = { loadErrors: [], failures: {} };

  listTestFiles(TEST_DIR).forEach(function(file) {
    var result = runFile(file, outDir);
    var expectLoadError = manifest.loadErrors.indexOf(file) !== -1;
    if (result.loadError !== undefined) {
      totals.loadErrors++;
      next.loadErrors.push(file);
      if (!expectLoadError) {
        problems.push(file + ': does not load\n' + result.loadError);
      }
      return;
    }
    if (expectLoadError) {
      problems.push(file + ': listed as a load failure but loads');
    }

    var expected = countOf(manifest.failures[file] || []);
    var failed = countOf(result.failedTitles);
    var passed = countOf(result.passed);
    totals.passed += result.passed.length;
    totals.pending += result.pending.length;
    if (result.failedTitles.length) {
      next.failures[file] = result.failedTitles;
    }

    result.failedTitles.forEach(function(title, i) {
      if (expected[title]) {
        expected[title]--;
        totals.expectedFailures++;
      } else {
        totals.failed++;
        problems.push(file + ': ' + result.failed[i]);
      }
    });
    Object.keys(expected).forEach(function(title) {
      if (expected[title] > 0 && !failed[title] && passed[title]) {
        problems.push(file + ': listed as failing but passes: ' + title);
      } else if (expected[title] > 0 && !failed[title]) {
        problems.push(file + ': listed as failing but did not run: ' + title);
      }
    });
  });

  fs.rmSync(outDir, { recursive: true, force: true });

  if (update) {
    fs.writeFileSync(MANIFEST, JSON.stringify(next, null, 2) + '\n');
    console.log('Wrote ' + path.relative(ROOT, MANIFEST));
    return 0;
  }

  console.log(totals.passed + ' passing, ' + totals.pending + ' pending, ' +
    totals.expectedFailures + ' failing as listed, ' + totals.failed + ' failing unlisted, ' +
    totals.loadErrors + ' files failing to load');
  if (problems.length) {
    console.error('\n' + problems.join('\n'));
    return 1;
  }
  return 0;
}

process.exitCode = main();
