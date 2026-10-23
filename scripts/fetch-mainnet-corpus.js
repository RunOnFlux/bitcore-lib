'use strict';

/**
 * Writes test/data/flux-mainnet/corpus.json: raw Flux mainnet blocks and
 * transactions from the public Insight explorer, with the hash, merkle root
 * and txids the explorer reports for each block.
 *
 * Usage: node scripts/fetch-mainnet-corpus.js [heights...]
 *   With no heights it fetches the most recent blocks and a spread of
 *   heights across the chain. Transactions listed in EXTRA_TXIDS are fetched
 *   as raw transactions; the explorer serves no raw fluxnode transactions,
 *   which come from their blocks. Requests are sequential and spaced out.
 */

var fs = require('fs');
var path = require('path');

var API = 'https://explorer.runonflux.io/api';
var OUT = path.resolve(__dirname, '..', 'test', 'data', 'flux-mainnet', 'corpus.json');
var DELAY_MS = 300;
var RECENT = 40;
var SPREAD = [
  1, 2, 1000, 50000, 100000, 150000, 200000, 249999, 250000, 250001, 300000,
  372500, 400000, 500000, 558000, 600000, 700000, 800000, 835554, 900000,
  1000000, 1100000, 1200000, 1300000, 1400000, 1500000, 1600000, 1700000,
  1800000, 1900000, 2000000, 2100000, 2200000, 2300000, 2400000, 2500000,
  2600000, 2700000, 2800000, 2900000, 3000000
];
var EXTRA_TXIDS = [
  '3780a12dc2fd722b282ccfbabaa399ade2a3ccbb29553e2f9d61512ac1b202a1',
  'c8db9d1c3f03d5d78854a492f6d04b3db93bd7ac96a77e6fd062b88c1254ec0b',
  '02f9e86fb8fae75b0a62c07f3df245fbec37862be76bffe8919d783e465731bf',
  'f3764dadff4450c161d305b7981a415b9c2c97e979a404e976a6579e4827bdf6'
];

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

async function get(route) {
  await sleep(DELAY_MS);
  var res = await fetch(API + route);
  if (!res.ok) {
    throw new Error(route + ': HTTP ' + res.status);
  }
  return res.json();
}

async function fetchBlock(hash) {
  var raw = await get('/rawblock/' + hash);
  var info = await get('/block/' + hash);
  return {
    height: info.height,
    hash: info.hash,
    version: info.version,
    merkleroot: info.merkleroot,
    txids: info.tx,
    rawblock: raw.rawblock
  };
}

async function main() {
  var heights = process.argv.slice(2).map(Number);
  var listed = heights.length > 0;
  var corpus = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { blocks: [], txs: [] };
  var have = {};
  corpus.blocks.forEach(function(b) { have[b.hash] = true; });
  var haveTx = {};
  corpus.txs.forEach(function(t) { haveTx[t.txid] = true; });

  var hashes = [];
  if (!listed) {
    var recent = await get('/blocks?limit=' + RECENT);
    recent.blocks.forEach(function(b) { hashes.push(b.hash); });
    heights = SPREAD;
  }
  for (var i = 0; i < heights.length; i++) {
    var index = await get('/block-index/' + heights[i]);
    hashes.push(index.blockHash);
  }

  for (var j = 0; j < hashes.length; j++) {
    if (!have[hashes[j]]) {
      corpus.blocks.push(await fetchBlock(hashes[j]));
      have[hashes[j]] = true;
    }
  }
  for (var k = 0; k < EXTRA_TXIDS.length; k++) {
    if (!haveTx[EXTRA_TXIDS[k]]) {
      var raw = await get('/rawtx/' + EXTRA_TXIDS[k]);
      corpus.txs.push({ txid: EXTRA_TXIDS[k], rawtx: raw.rawtx });
    }
  }

  corpus.blocks.sort(function(a, b) { return a.height - b.height; });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(corpus, null, 1) + '\n');
  console.log(corpus.blocks.length + ' blocks, ' + corpus.txs.length + ' extra transactions');
}

main().catch(function(err) {
  console.error(err);
  process.exitCode = 1;
});
