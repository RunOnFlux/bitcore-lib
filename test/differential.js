'use strict';

/**
 * Differential test against runonflux/bitcore-lib 8f5453f, installed as the
 * devDependency `bitcore-lib-8f5453f` with its own pinned dependencies.
 *
 * Every check runs the same operation through both libraries and requires
 * identical output: serialisations byte for byte, JSON, hashes, addresses,
 * keys, signatures, or the same error message when both throw.
 */

var crypto = require('crypto');
var expect = require('chai').expect;

var NEW = require('..');
var OLD = require('bitcore-lib-8f5453f');
var corpus = require('./data/flux-mainnet/corpus.json');

var NETWORKS = ['livenet', 'testnet'];

function seq(label, n) {
  var out = [];
  for (var i = 0; i < n; i++) {
    out.push(crypto.createHash('sha256').update(label + ':' + i).digest());
  }
  return out;
}

/**
 * Plain, comparable rendering of a value produced by either library:
 * Buffers become hex, BNs become signed hex, objects with toObject() are
 * rendered through it, and thrown errors become their message.
 */
function render(value, depth) {
  depth = depth || 0;
  if (depth > 12) {
    throw new Error('render: nesting too deep');
  }
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { hex: Buffer.from(value).toString('hex') };
  }
  if (Array.isArray(value.words) && typeof value.cmp === 'function') {
    return { bn: value.toString(16) };
  }
  if (Array.isArray(value)) {
    return value.map(function(v) { return render(v, depth + 1); });
  }
  if (typeof value.toObject === 'function') {
    return render(value.toObject(), depth + 1);
  }
  var out = {};
  Object.keys(value).sort().forEach(function(k) {
    out[k] = render(value[k], depth + 1);
  });
  return out;
}

/**
 * Whether OpenSSL accepts buf as a secp256k1 public key.
 */
function opensslAccepts(buf) {
  try {
    crypto.ECDH.convertKey(buf, 'secp256k1', undefined, 'hex', 'uncompressed');
    return true;
  } catch (e) {
    return false;
  }
}

function outcome(fn) {
  try {
    return { value: render(fn()) };
  } catch (e) {
    return { error: String(e && e.message) };
  }
}

/**
 * Runs fn(OLD) and fn(NEW) and requires identical outcomes. Returns the
 * outcome so callers can assert on it as well.
 */
function same(label, fn) {
  var o = outcome(function() { return fn(OLD); });
  var n = outcome(function() { return fn(NEW); });
  expect(n, label).to.deep.equal(o);
  return o;
}

describe('Differential against bitcore-lib 8f5453f', function() {

  this.timeout(600000);

  it('loads two distinct copies of the library', function() {
    expect(OLD).to.not.equal(NEW);
    expect(OLD.deps.bnjs).to.not.equal(NEW.deps.bnjs);
  });

  describe('Flux mainnet corpus', function() {

    var kinds = {};
    function kind(name) {
      kinds[name] = (kinds[name] || 0) + 1;
    }
    function txKind(tx) {
      if (tx.version === 5 || tx.version === 6) {
        var z = tx.zelnodeData;
        var name = 'v' + tx.version + (z.nType === 2 ? ' fluxnode start' : z.nType === 4 ? ' fluxnode confirm' : ' type ' + z.nType);
        if (tx.version === 6 && z.nType === 2) {
          name += (z.nFluxTxVersion & 0x02) ? ' p2sh' : ' p2pkh';
        }
        if (z.fUsingDelegates) {
          name += ' with delegates';
        }
        return name;
      }
      var parts = ['v' + tx.version];
      parts.push(tx.isCoinbase() ? 'coinbase' : 'transparent');
      if (tx.joinSplits && tx.joinSplits.length) {
        parts.push('sprout joinsplit');
      }
      if (tx.spendDescs && tx.spendDescs.length) {
        parts.push('sapling spend');
      }
      if (tx.outputDescs && tx.outputDescs.length) {
        parts.push('sapling output');
      }
      return parts.join(' ');
    }

    after(function() {
      console.log('      corpus: ' + corpus.blocks.length + ' blocks, ' + corpus.txs.length + ' raw transactions');
      Object.keys(kinds).sort().forEach(function(k) {
        console.log('        ' + kinds[k] + ' x ' + k);
      });
    });

    function checkTransaction(label, hex, txid) {
      var o = same(label + ' parse', function(lib) {
        var tx = new lib.Transaction(hex);
        return {
          hex: tx.toString(),
          hash: tx.hash,
          id: tx.id,
          json: JSON.stringify(tx.toJSON()),
          object: tx.toObject(),
          verify: outcome(function() { return tx.verify(); }),
          outputAmount: outcome(function() { return tx.outputAmount; }),
          coinbase: tx.isCoinbase(),
          lockTime: outcome(function() { return tx.getLockTime(); })
        };
      });
      expect(o.value.hex, label + ' round trip').to.equal(hex);
      if (txid) {
        expect(o.value.hash, label + ' txid').to.equal(txid);
      }

      same(label + ' from object', function(lib) {
        var tx = new lib.Transaction(hex);
        return new lib.Transaction(tx.toObject()).toString();
      });
      same(label + ' from buffer', function(lib) {
        return lib.Transaction.fromBuffer(Buffer.from(hex, 'hex')).toBuffer();
      });

      same(label + ' scripts', function(lib) {
        var tx = new lib.Transaction(hex);
        return {
          inputs: tx.inputs.map(function(input) {
            var script = outcome(function() { return input.script; });
            return {
              script: script,
              asm: outcome(function() { return input.script.toString(); }),
              type: outcome(function() { return input.script.classify(); }),
              addresses: NETWORKS.map(function(network) {
                return outcome(function() { return String(input.script.toAddress(network)); });
              })
            };
          }),
          outputs: tx.outputs.map(function(output) {
            return {
              asm: outcome(function() { return output.script.toString(); }),
              type: outcome(function() { return output.script.classify(); }),
              addresses: NETWORKS.map(function(network) {
                return outcome(function() { return String(output.script.toAddress(network)); });
              }),
              satoshis: output.satoshis
            };
          })
        };
      });

      same(label + ' input keys and signatures', function(lib) {
        var tx = new lib.Transaction(hex);
        return tx.inputs.map(function(input) {
          return outcome(function() {
            var chunks = input.script.chunks;
            if (chunks.length !== 2 || !chunks[0].buf || !chunks[1].buf) {
              return null;
            }
            var sig = lib.crypto.Signature.fromTxFormat(chunks[0].buf);
            var pub = new lib.PublicKey(chunks[1].buf);
            return {
              sig: sig.toString(),
              r: sig.r.toString(16),
              s: sig.s.toString(16),
              nhashtype: sig.nhashtype,
              lowS: sig.hasLowS(),
              isTxDER: lib.crypto.Signature.isTxDER(chunks[0].buf),
              pubkey: pub.toString(),
              pubkeyObject: pub.toObject(),
              addresses: NETWORKS.map(function(network) { return pub.toAddress(network).toString(); }),
              sighash: outcome(function() {
                var subscript = lib.Script.buildPublicKeyHashOut(pub);
                return lib.Transaction.sighash.sighash(tx, sig.nhashtype, tx.inputs.indexOf(input), subscript);
              })
            };
          });
        });
      });

      var tx = new OLD.Transaction(hex);
      if (tx.version === 5 || tx.version === 6) {
        same(label + ' fluxnode keys', function(lib) {
          var z = new lib.Transaction(hex).zelnodeData;
          var keys = {};
          ['collateralPublicKey', 'publicKey'].forEach(function(field) {
            if (z[field]) {
              keys[field] = outcome(function() {
                var pub = new lib.PublicKey(z[field]);
                return {
                  der: pub.toString(),
                  compressed: pub.compressed,
                  addresses: NETWORKS.map(function(network) { return pub.toAddress(network).toString(); })
                };
              });
            }
          });
          if (z.P2SHRedeemScript) {
            keys.redeemScript = outcome(function() {
              var script = new lib.Script(z.P2SHRedeemScript);
              return {
                asm: script.toString(),
                addresses: NETWORKS.map(function(network) {
                  return lib.Address.payingTo(script, network).toString();
                })
              };
            });
          }
          if (z.sig) {
            keys.sigRecovery = outcome(function() {
              if (z.sig.length !== 65) {
                return lib.crypto.Signature.fromDER(z.sig).toString();
              }
              var sig = lib.crypto.Signature.fromCompact(z.sig);
              var ecdsa = new lib.crypto.ECDSA();
              ecdsa.hashbuf = lib.crypto.Hash.sha256(z.sig);
              ecdsa.sig = sig;
              return { r: sig.r, s: sig.s, i: sig.i, compressed: sig.compressed, pub: ecdsa.toPublicKey().toString() };
            });
          }
          return keys;
        });
      }
      kind(txKind(tx));
    }

    corpus.blocks.forEach(function(entry) {
      it('block ' + entry.height + ' ' + entry.hash, function() {
        var o = same('block ' + entry.height, function(lib) {
          var block = lib.Block.fromString(entry.rawblock);
          return {
            hex: block.toString(),
            hash: block.hash,
            header: block.header.toObject(),
            headerHex: block.header.toString(),
            json: JSON.stringify(block.toJSON()),
            txids: block.transactions.map(function(tx) { return tx.hash; }),
            merkleRoot: block.getMerkleRoot(),
            validMerkleRoot: block.validMerkleRoot(),
            difficulty: outcome(function() { return block.header.getDifficulty(); }),
            target: outcome(function() { return block.header.getTargetDifficulty(); }),
            validProofOfWork: outcome(function() { return block.header.validProofOfWork(); }),
            ponHash: outcome(function() { return block.header.getPONHash(1); }),
            ponHashSlot: outcome(function() { return block.header.getPONHash(1588000000, 30); })
          };
        });
        expect(o.value.hex).to.equal(entry.rawblock);
        expect(o.value.hash).to.equal(entry.hash);
        expect(o.value.txids).to.deep.equal(entry.txids);

        same('block ' + entry.height + ' raw', function(lib) {
          var buf = Buffer.from(entry.rawblock, 'hex');
          return {
            header: lib.BlockHeader.fromBuffer(buf).toObject(),
            block: lib.Block.fromBuffer(buf).toBuffer()
          };
        });
        same('block ' + entry.height + ' from object', function(lib) {
          var block = lib.Block.fromString(entry.rawblock);
          return new lib.Block(block.toObject()).toString();
        });

        var block = OLD.Block.fromString(entry.rawblock);
        kind('block v' + block.header.version + (block.header.version >= 100 ? ' PoN' : ' PoW'));
        block.transactions.forEach(function(tx, i) {
          checkTransaction('block ' + entry.height + ' tx ' + i, tx.toString(), entry.txids[i]);
        });
      });
    });

    corpus.txs.forEach(function(entry) {
      it('raw transaction ' + entry.txid, function() {
        checkTransaction('tx ' + entry.txid, entry.rawtx, entry.txid);
      });
    });

    it('v6 fluxnode starts with delegates', function() {
      var starts = [];
      corpus.blocks.forEach(function(entry) {
        OLD.Block.fromString(entry.rawblock).transactions.forEach(function(tx) {
          if ((tx.version === 5 || tx.version === 6) && tx.zelnodeData.nType === 2) {
            starts.push(tx.toString());
          }
        });
      });
      expect(starts.length).to.be.above(0);
      var delegateKeys = seq('delegate', 3).map(function(d) {
        return new OLD.PrivateKey(d.toString('hex')).toPublicKey().toBuffer();
      });
      var variants = [
        { fUsingDelegates: false },
        { fUsingDelegates: true, delegateData: { nDelegateVersion: 1, nType: 0, delegates: [] } },
        { fUsingDelegates: true, delegateData: { nDelegateVersion: 1, nType: 1, delegates: delegateKeys.slice(0, 1) } },
        { fUsingDelegates: true, delegateData: { nDelegateVersion: 1, nType: 1, delegates: delegateKeys } }
      ];
      var built = 0;
      starts.forEach(function(hex, s) {
        variants.forEach(function(variant, v) {
          var label = 'start ' + s + ' variant ' + v;
          var o = same(label, function(lib) {
            var tx = new lib.Transaction(hex);
            var z = tx.zelnodeData;
            if (tx.version === 5) {
              tx.version = 6;
              z.nFluxTxVersion = 1;
            }
            z.nFluxTxVersion |= 0x0100;
            z.fUsingDelegates = variant.fUsingDelegates;
            if (variant.delegateData) {
              z.delegateData = {
                nDelegateVersion: variant.delegateData.nDelegateVersion,
                nType: variant.delegateData.nType,
                delegates: variant.delegateData.delegates.map(function(k) { return Buffer.from(k); })
              };
            }
            var out = tx.toString();
            var back = new lib.Transaction(out);
            return { hex: out, hash: back.hash, again: back.toString(), object: back.toObject() };
          });
          expect(o.value.again, label).to.equal(o.value.hex);
          built++;
        });
      });
      kinds['synthetic v6 fluxnode start with delegate flag (' + starts.length + ' starts x ' + variants.length + ' variants)'] = built;
    });
  });

  describe('BN', function() {
    var values = seq('bn', 200).map(function(b, i) {
      return b.slice(0, 1 + (i % 32));
    });
    values.push(Buffer.alloc(0), Buffer.from([0]), Buffer.from([0x80]), Buffer.from([0x00, 0x80]),
      Buffer.from([0xff, 0x7f]), Buffer.from([0x01, 0x00, 0x00, 0x80]));

    it('buffer, sign-magnitude and script number encodings', function() {
      values.forEach(function(buf, i) {
        same('bn ' + i, function(lib) {
          var BN = lib.crypto.BN;
          var bn = BN.fromBuffer(Buffer.from(buf));
          var neg = bn.neg();
          return {
            hex: bn.toString(16),
            dec: bn.toString(10),
            hex2: bn.toString('hex', 2),
            number: bn.toNumber(),
            negNumber: neg.toNumber(),
            buf: bn.toBuffer(),
            buf32: bn.toBuffer({ size: 32 }),
            buf4: bn.toBuffer({ size: 4 }),
            le: bn.toBuffer({ endian: 'little' }),
            le32: bn.toBuffer({ size: 32, endian: 'little' }),
            fromLE: BN.fromBuffer(Buffer.from(buf), { endian: 'little' }),
            sm: bn.toSM(),
            negSM: neg.toSM(),
            smLE: neg.toSM({ endian: 'little' }),
            fromSM: BN.fromSM(Buffer.from(buf)),
            fromSMLE: BN.fromSM(Buffer.from(buf), { endian: 'little' }),
            scriptNum: neg.toScriptNumBuffer(),
            fromScriptNum: outcome(function() { return BN.fromScriptNumBuffer(Buffer.from(buf), false); }),
            fromScriptNumMinimal: outcome(function() { return BN.fromScriptNumBuffer(Buffer.from(buf), true); }),
            fromScriptNum5: outcome(function() { return BN.fromScriptNumBuffer(Buffer.from(buf), true, 5); }),
            cmp: [bn.gt(neg), bn.gte(neg), bn.lt(neg), bn.cmp(BN.Zero), neg.cmp(BN.Minus1)],
            fromString: BN.fromString(bn.toString(10)),
            fromNumber: outcome(function() { return BN.fromNumber(bn.toNumber()); })
          };
        });
      });
    });

    it('arithmetic used by the library', function() {
      var n = OLD.crypto.Point.getN().toString(16);
      values.forEach(function(buf, i) {
        same('bn arithmetic ' + i, function(lib) {
          var BN = lib.crypto.BN;
          var N = new BN(n, 16);
          var bn = BN.fromBuffer(Buffer.from(buf));
          var two = new BN(2);
          return {
            add: bn.add(N),
            sub: bn.sub(N),
            mul: bn.mul(N),
            negModN: lib === OLD ? bn.neg().mod(N) : bn.neg().umod(N),
            invm: bn.cmp(BN.Zero) === 0 ? null : bn.invm(N),
            div: bn.div(two),
            lowS: lib.crypto.ECDSA.toLowS(bn)
          };
        });
      });
    });
  });

  describe('Base58', function() {
    it('encodes, decodes and checks alike', function() {
      var bufs = seq('base58', 64).map(function(b, i) {
        var zeros = Buffer.alloc(i % 5);
        return Buffer.concat([zeros, b.slice(0, i % 33)]);
      });
      bufs.push(Buffer.alloc(0), Buffer.alloc(1), Buffer.alloc(40), Buffer.from([0, 0, 1]), Buffer.alloc(25, 0xff));
      bufs.forEach(function(buf, i) {
        same('base58 ' + i, function(lib) {
          var str = lib.encoding.Base58.encode(buf);
          var check = lib.encoding.Base58Check.encode(buf);
          return {
            str: str,
            back: lib.encoding.Base58.decode(str),
            obj: new lib.encoding.Base58(buf).toString(),
            fromString: new lib.encoding.Base58(str).toBuffer(),
            check: check,
            checkBack: lib.encoding.Base58Check.decode(check),
            valid: lib.encoding.Base58.validCharacters(str),
            checkValid: lib.encoding.Base58Check.validChecksum(check),
            depsEncode: lib.deps.bs58.encode(buf),
            depsDecode: Buffer.from(lib.deps.bs58.decode(str))
          };
        });
      });
      var strings = ['', '1', '11', ' 1', '1 ', '0', 'O', 'I', 'l', '\u00e9', 'z', '2NEpo7TZRRrLZSi2U', '1111111111'];
      strings.forEach(function(str, i) {
        same('base58 string ' + i, function(lib) {
          return {
            decode: outcome(function() { return lib.encoding.Base58.decode(str); }),
            check: outcome(function() { return lib.encoding.Base58Check.decode(str); }),
            valid: lib.encoding.Base58.validCharacters(str),
            notString: outcome(function() { return lib.encoding.Base58.decode(Buffer.from(str)); }),
            notBuffer: outcome(function() { return lib.encoding.Base58.encode(str); })
          };
        });
      });
    });
  });

  describe('keys and addresses', function() {
    var N = OLD.crypto.Point.getN();
    var seeds = seq('privkey', 120).map(function(b) { return b.toString('hex'); });
    seeds.push('01', '02', '03', N.sub(new OLD.crypto.BN(1)).toString(16), N.sub(new OLD.crypto.BN(2)).toString(16),
      '0000000000000000000000000000000100000000000000000000000000000000', '00000000000000000000000000000000000000000000000000000000000000ff');

    it('private keys, WIF and public keys', function() {
      seeds.forEach(function(hex, i) {
        NETWORKS.forEach(function(network) {
          [true, false].forEach(function(compressed) {
            var label = 'key ' + i + ' ' + network + ' ' + compressed;
            var o = same(label, function(lib) {
              var bn = new lib.crypto.BN(hex, 16);
              var key = new lib.PrivateKey({ bn: bn, network: network, compressed: compressed });
              var wif = key.toWIF();
              var back = lib.PrivateKey.fromWIF(wif);
              var pub = key.toPublicKey();
              return {
                wif: wif,
                str: key.toString(),
                buf: key.toBuffer(),
                json: JSON.stringify(key.toJSON()),
                object: key.toObject(),
                backWif: back.toWIF(),
                backNetwork: back.network.name,
                backCompressed: back.compressed,
                fromString: new lib.PrivateKey(wif).toString(),
                pub: pub.toString(),
                pubObject: pub.toObject(),
                pubJson: JSON.stringify(pub.toJSON()),
                address: key.toAddress().toString(),
                pubAddress: pub.toAddress(network).toString(),
                address2: lib.Address.fromPublicKey(pub, network).toString(),
                pubFromDER: new lib.PublicKey(pub.toBuffer()).toString(),
                pubFromObject: new lib.PublicKey(pub.toObject()).toString(),
                pubFromX: lib.PublicKey.fromX(pub.point.getY().isOdd(), pub.point.getX()).toString(),
                point: { x: pub.point.getX(), y: pub.point.getY() },
                compressedPoint: lib.crypto.Point.pointToCompressed(pub.point),
                validWif: lib.PrivateKey.isValid(wif),
                validWifOtherNet: lib.PrivateKey.isValid(wif, network === 'livenet' ? 'testnet' : 'livenet'),
                validPub: lib.PublicKey.isValid(pub.toString()),
                p2pkh: lib.Script.buildPublicKeyHashOut(pub).toString(),
                p2pk: lib.Script.buildPublicKeyOut(pub).toString()
              };
            });
            expect(o.error, label).to.equal(undefined);
          });
        });
      });
    });

    it('WIF from plain numbers and random keys', function() {
      same('wif helpers', function(lib) {
        return [
          lib.PrivateKey.fromString(seeds[0]).toString(),
          new lib.PrivateKey(seeds[1], 'testnet').toWIF(),
          lib.PrivateKey.fromObject({ bn: seeds[2], compressed: false, network: 'livenet' }).toWIF(),
          outcome(function() { return new lib.PrivateKey('00'); }),
          outcome(function() { return new lib.PrivateKey(N.toString(16)); }),
          outcome(function() { return lib.PrivateKey.fromWIF('notawif'); })
        ];
      });
    });

    it('addresses and P2SH multisig', function() {
      var keyHex = seeds.slice(0, 15);
      for (var i = 0; i + 3 <= keyHex.length; i += 3) {
        NETWORKS.forEach(function(network) {
          same('multisig ' + i + ' ' + network, function(lib) {
            var pubs = keyHex.slice(i, i + 3).map(function(hex) {
              return new lib.PrivateKey(hex, network).toPublicKey();
            });
            var addr2of3 = lib.Address.createMultisig(pubs, 2, network);
            var addr1of1 = lib.Address.createMultisig(pubs.slice(0, 1), 1, network);
            var redeem = lib.Script.buildMultisigOut(pubs, 2);
            return {
              addr2of3: addr2of3.toString(),
              addr1of1: addr1of1.toString(),
              obj: addr2of3.toObject(),
              buf: addr2of3.toBuffer(),
              redeem: redeem.toString(),
              redeemHex: redeem.toHex(),
              scriptHashOut: lib.Script.buildScriptHashOut(redeem).toString(),
              payingTo: lib.Address.payingTo(redeem, network).toString(),
              isP2SH: addr2of3.isPayToScriptHash(),
              fromString: lib.Address.fromString(addr2of3.toString()).toString(),
              valid: lib.Address.isValid(addr2of3.toString(), network),
              validOther: lib.Address.isValid(addr2of3.toString(), network === 'livenet' ? 'testnet' : 'livenet'),
              p2pkhFromHash: lib.Address.fromPublicKeyHash(pubs[0]._getID(), network).toString(),
              outScript: lib.Script.fromAddress(addr2of3).toString()
            };
          });
        });
      }
    });

    it('address validation on mutated strings', function() {
      var addrs = [];
      seeds.slice(0, 20).forEach(function(hex) {
        NETWORKS.forEach(function(network) {
          addrs.push(new OLD.PrivateKey(hex, network).toAddress().toString());
        });
      });
      addrs.forEach(function(addr, i) {
        var mutated = [addr, addr.slice(1), addr + '1', addr.slice(0, -1) + (addr.slice(-1) === 'a' ? 'b' : 'a'),
          addr.replace(/^t1/, 't3'), addr.replace(/^tm/, 't1'), addr.toLowerCase(), '1' + addr.slice(2)];
        same('address ' + i, function(lib) {
          return mutated.map(function(m) {
            return [
              lib.Address.isValid(m),
              lib.Address.isValid(m, 'livenet'),
              lib.Address.isValid(m, 'testnet'),
              outcome(function() { return lib.Address.getValidationError(m); }),
              outcome(function() { return lib.Address.fromString(m).toObject(); })
            ];
          });
        });
      });
    });

    it('public key parsing and validation', function() {
      var inputs = seq('pubkey', 80).map(function(b, i) {
        var prefix = [0x02, 0x03, 0x04, 0x05][i % 4];
        return Buffer.concat([Buffer.from([prefix]), b, i % 4 === 2 ? seq('y', 1)[0] : Buffer.alloc(0)]);
      });
      inputs.push(Buffer.alloc(33), Buffer.alloc(65), Buffer.from('02' + 'ff'.repeat(32), 'hex'));
      inputs.forEach(function(buf, i) {
        if ((buf[0] === 0x02 || buf[0] === 0x03) && buf.length === 33 && !opensslAccepts(buf)) {
          return;
        }
        var xOnCurve = opensslAccepts(Buffer.concat([Buffer.from([0x03]), buf.slice(1, 33)]));
        same('pubkey ' + i, function(lib) {
          return {
            valid: lib.PublicKey.isValid(buf.toString('hex')),
            error: outcome(function() { return lib.PublicKey.getValidationError(buf.toString('hex')); }),
            parsed: outcome(function() { return new lib.PublicKey(buf).toString(); }),
            point: outcome(function() {
              return new lib.crypto.Point(new lib.crypto.BN(buf.slice(1, 33)), new lib.crypto.BN(buf.slice(1, 33))).getX();
            }),
            fromX: xOnCurve ? outcome(function() {
              return lib.crypto.Point.fromX(true, new lib.crypto.BN(buf.slice(1, 33))).getY();
            }) : 'off curve'
          };
        });
      });
    });

    it('rejects compressed keys whose x has no curve point, which 8f5453f accepts', function() {
      var rejected = 0;
      seq('offcurve', 200).forEach(function(x, i) {
        var buf = Buffer.concat([Buffer.from([i % 2 ? 0x03 : 0x02]), x]);
        if (opensslAccepts(buf)) {
          same('on-curve x ' + i, function(lib) { return new lib.PublicKey(buf).toObject(); });
          return;
        }
        rejected++;
        expect(NEW.PublicKey.isValid(buf.toString('hex')), 'x ' + i).to.equal(false);
        expect(function() { return new NEW.PublicKey(buf); }).to.throw('Point does not lie on the curve');
        expect(function() { return NEW.crypto.Point.fromX(i % 2 === 1, new NEW.crypto.BN(x)); })
          .to.throw('Point does not lie on the curve');
        expect(OLD.PublicKey.isValid(buf.toString('hex')), 'x ' + i + ' at 8f5453f').to.equal(true);
      });
      expect(rejected).to.be.above(50);
    });

    it('rejects point coordinates at or above the field prime', function() {
      var P = 'fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f';
      var bases = seq('fieldkey', 20).map(function(b) {
        return new OLD.PrivateKey(b.toString('hex')).toPublicKey().point;
      });
      bases.forEach(function(point, i) {
        var x = point.getX().toString(16);
        var y = point.getY().toString(16);
        same('field ' + i, function(lib) {
          var BN = lib.crypto.BN;
          var Point = lib.crypto.Point;
          var p = new BN(P, 16);
          var X = new BN(x, 16);
          var Y = new BN(y, 16);
          var run = function(fn) {
            return outcome(function() {
              var q = fn();
              return { x: q.getX(), y: q.getY() };
            });
          };
          return [
            run(function() { return Point.fromX(Y.isOdd(), X.add(p)); }),
            run(function() { return Point.fromX(!Y.isOdd(), X.add(p)); }),
            run(function() { return Point.fromX(true, p); }),
            run(function() { return Point.fromX(true, p.add(new BN(i + 1))); }),
            run(function() { return new Point(X.add(p), Y); }),
            run(function() { return new Point(X, Y.add(p)); }),
            run(function() { return new Point(X.add(p), Y.add(p)); }),
            run(function() { return new Point(X.add(p).add(p), Y); }),
            run(function() { return new Point(X.toString(16), Y.toString(16)); }),
            run(function() { return new Point(X.add(p).toString(16), Y.toString(16)); }),
            run(function() { return new Point(new BN(0), Y.add(p)); }),
            outcome(function() {
              var buf = Buffer.concat([Buffer.from([0x04]), X.add(p).toBuffer({ size: 32 }), Y.toBuffer({ size: 32 })]);
              return new lib.PublicKey(buf).toString();
            })
          ];
        });
      });
    });

    it('point arithmetic', function() {
      // elliptic multiplies by non-negative scalars only; neither version
      // gives k * P for a negative k.
      var scalars = ['0', '1', '2', 'n-1', 'n', 'n+1', '2^256+5'].concat(seq('scalar', 10).map(function(b) {
        return b.toString('hex');
      }));
      same('point arithmetic', function(lib) {
        var BN = lib.crypto.BN;
        var Point = lib.crypto.Point;
        var n = Point.getN();
        var toScalar = function(s) {
          var table = { 'n-1': n.sub(new BN(1)), n: n, 'n+1': n.add(new BN(1)), '2^256+5': new BN(1).ushln ?
            new BN(1).ushln(256).add(new BN(5)) : new BN(1).shln(256).add(new BN(5)) };
          if (table[s]) {
            return table[s];
          }
          return /^[0-9]$/.test(s) ? new BN(Number(s)) : new BN(s, 16);
        };
        var render = function(fn) {
          return outcome(function() {
            var q = fn();
            return q.isInfinity() ? 'infinity' : { x: q.getX(), y: q.getY() };
          });
        };
        var G = Point.getG();
        var Q = new lib.PrivateKey(seq('pointkey', 1)[0].toString('hex')).toPublicKey().point;
        return scalars.map(function(s) {
          var k = toScalar(s);
          return [
            render(function() { return G.mul(k); }),
            render(function() { return Q.mul(k); }),
            render(function() { return G.mulAdd(k, Q, new BN(3)); }),
            render(function() { return G.mul(k).add(Q); }),
            outcome(function() { return G.mul(k).eq(Q.mul(k)); }),
            outcome(function() { return lib.crypto.Point.pointToCompressed(Q.mul(k)); })
          ];
        });
      });
    });

    it('HD keys', function() {
      var paths = ['m', 'm/0', "m/0'", "m/0'/1", "m/0'/1/2'", "m/0'/1/2'/2/1000000000", "m/44'/19167'/0'/0/5",
        "m/44'/19167'/0'/1/0", 'm/2147483647', "m/2147483647'/1/2147483646'"];
      seq('hdseed', 12).forEach(function(seed, i) {
        NETWORKS.forEach(function(network) {
          same('hd ' + i + ' ' + network, function(lib) {
            var root = lib.HDPrivateKey.fromSeed(seed.toString('hex'), network);
            var xpub = root.hdPublicKey;
            return {
              xprv: root.toString(),
              xpub: xpub.toString(),
              object: root.toObject(),
              pubObject: xpub.toObject(),
              buffer: root.toBuffer(),
              back: new lib.HDPrivateKey(root.toString()).toString(),
              backPub: new lib.HDPublicKey(xpub.toString()).toString(),
              derived: paths.map(function(path) {
                var child = root.derive(path);
                return {
                  xprv: child.toString(),
                  xpub: child.hdPublicKey.toString(),
                  wif: child.privateKey.toWIF(),
                  address: child.privateKey.toAddress().toString(),
                  fingerprint: child.fingerPrint,
                  pubDerived: outcome(function() { return xpub.derive(path).toString(); })
                };
              }),
              indexes: [0, 1, 2147483647, 2147483648, 4294967295].map(function(index) {
                return outcome(function() { return root.derive(index).toString(); });
              }),
              valid: lib.HDPrivateKey.isValidSerialized(root.toString()),
              validPub: lib.HDPublicKey.isValidSerialized(xpub.toString())
            };
          });
        });
      });
    });
  });

  describe('URI, Unit and Opcode', function() {
    it('renders URIs, units and opcodes alike', function() {
      var key = new OLD.PrivateKey(seq('uri', 1)[0].toString('hex'));
      NETWORKS.forEach(function(network) {
        var address = new OLD.PrivateKey(key.toString(), network).toAddress().toString();
        same('uri ' + network, function(lib) {
          var uri = new lib.URI({ address: address, amount: 123456789, message: 'm s', label: 'l&', r: 'https://x/y', other: 'o', 'req-x': 'z' });
          return {
            str: uri.toString(),
            json: uri.toJSON(),
            object: uri.toObject(),
            parse: outcome(function() { return new lib.URI(uri.toString()).toObject(); }),
            valid: lib.URI.isValid(uri.toString()),
            inspect: uri.inspect()
          };
        });
      });
      same('units', function(lib) {
        return [0, 1, 12345678, 2100000000000000].map(function(sat) {
          var unit = lib.Unit.fromSatoshis(sat);
          return [unit.toBTC(), unit.toMilis(), unit.toBits(), unit.toString(), unit.toObject(), unit.atRate(123.45)];
        });
      });
      same('opcodes', function(lib) {
        return {
          map: lib.Opcode.map,
          reverse: lib.Opcode.reverseMap,
          dup: lib.Opcode.OP_DUP,
          small: [0, 1, 16].map(function(n) { return lib.Opcode.smallInt(n).toString(); })
        };
      });
    });
  });

  describe('signatures', function() {
    var keys = seq('sigkey', 16).map(function(b) { return b.toString('hex'); });
    keys.push('01', OLD.crypto.Point.getN().sub(new OLD.crypto.BN(1)).toString(16));
    var hashes = seq('sighash', 6);
    hashes.push(Buffer.alloc(32), Buffer.alloc(32, 0xff));

    it('deterministic ECDSA, recovery, low S and cross verification', function() {
      keys.forEach(function(keyHex, k) {
        hashes.forEach(function(hash, h) {
          ['big', 'little'].forEach(function(endian) {
            [true, false].forEach(function(compressed) {
              var label = 'sig key ' + k + ' hash ' + h + ' ' + endian + ' ' + compressed;
              var sigs = {};
              var o = same(label, function(lib) {
                var key = new lib.PrivateKey({ bn: new lib.crypto.BN(keyHex, 16), compressed: compressed, network: 'livenet' });
                var ecdsa = new lib.crypto.ECDSA();
                ecdsa.hashbuf = hash;
                ecdsa.endian = endian;
                ecdsa.privkey = key;
                ecdsa.pubkey = key.toPublicKey();
                ecdsa.deterministicK();
                var k1 = ecdsa.k;
                ecdsa.sign();
                // calci() recovers from a big-endian hash only
                var calci = endian === 'big' ? ecdsa.calci().sig.i : null;
                var sig = ecdsa.sig;
                if (sig.i === undefined) {
                  sig.i = 0;
                }
                sigs[lib === OLD ? 'old' : 'new'] = sig.toString();
                var recover = new lib.crypto.ECDSA();
                recover.hashbuf = hash;
                recover.endian = endian;
                recover.sig = lib.crypto.Signature.fromCompact(sig.toCompact());
                var highS = new lib.crypto.Signature({ r: sig.r, s: lib.crypto.Point.getN().sub(sig.s) });
                var withHashType = new lib.crypto.Signature({ r: sig.r, s: sig.s, nhashtype: 0x01 });
                return {
                  k: k1,
                  k2: new lib.crypto.ECDSA({ hashbuf: hash, privkey: key, endian: endian }).deterministicK(2).k,
                  der: sig.toDER(),
                  compact: sig.toCompact(),
                  calci: calci,
                  str: ecdsa.toString(),
                  fromDER: lib.crypto.Signature.fromDER(sig.toDER()).toString(),
                  fromStrictDER: lib.crypto.Signature.fromDER(sig.toDER(), true).toString(),
                  txFormat: withHashType.toTxFormat(),
                  isTxDER: lib.crypto.Signature.isTxDER(withHashType.toTxFormat()),
                  lowS: sig.hasLowS(),
                  highSLowS: highS.hasLowS(),
                  verify: lib.crypto.ECDSA.verify(hash, sig, key.toPublicKey(), endian),
                  verifyHighS: lib.crypto.ECDSA.verify(hash, highS, key.toPublicKey(), endian),
                  verifyOtherEndian: lib.crypto.ECDSA.verify(hash, sig, key.toPublicKey(), endian === 'big' ? 'little' : 'big'),
                  sigError: new lib.crypto.ECDSA({ hashbuf: hash, sig: highS, pubkey: key.toPublicKey(), endian: endian }).sigError(),
                  recovered: recover.toPublicKey().toString(),
                  recoverAll: [0, 1, 2, 3].map(function(i) {
                    return outcome(function() {
                      var e = new lib.crypto.ECDSA();
                      e.hashbuf = hash;
                      e.sig = new lib.crypto.Signature({ r: sig.r, s: sig.s, i: i, compressed: compressed });
                      var x = i > 1 ? sig.r.add(lib.crypto.Point.getN()) : sig.r;
                      var aboveP = x.cmp(new lib.crypto.BN('fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f', 16)) >= 0;
                      var onCurve = !aboveP && opensslAccepts(Buffer.concat([Buffer.from([i % 2 ? 0x03 : 0x02]), x.toBuffer({ size: 32 })]));
                      return aboveP || onCurve ? e.toPublicKey().toString() : 'off curve';
                    });
                  }),
                  staticSign: lib.crypto.ECDSA.sign(hash, key, endian).toString()
                };
              });
              expect(o.error, label).to.equal(undefined);
              expect(o.value.verify, label).to.equal(true);
              same(label + ' cross verify', function(lib) {
                var other = lib === OLD ? sigs.new : sigs.old;
                var key = new lib.PrivateKey({ bn: new lib.crypto.BN(keyHex, 16), compressed: compressed, network: 'livenet' });
                var sig = lib.crypto.Signature.fromString(other);
                return lib.crypto.ECDSA.verify(hash, sig, key.toPublicKey(), endian);
              });
            });
          });
        });
      });
    });

    it('rejects malformed signatures alike', function() {
      var der = OLD.crypto.ECDSA.sign(hashes[0], new OLD.PrivateKey(keys[0])).toDER();
      var cases = [Buffer.alloc(0), der.slice(0, 8), Buffer.concat([der, Buffer.from([0])])];
      for (var i = 0; i < der.length; i++) {
        var copy = Buffer.from(der);
        copy[i] ^= 0x80;
        cases.push(copy);
      }
      cases.forEach(function(buf, i) {
        same('malformed ' + i, function(lib) {
          return {
            der: outcome(function() { return lib.crypto.Signature.fromDER(buf).toString(); }),
            strict: outcome(function() { return lib.crypto.Signature.fromDER(buf, true).toString(); }),
            lax: outcome(function() { return lib.crypto.Signature.fromDER(buf, false).toString(); }),
            isTxDER: lib.crypto.Signature.isTxDER(Buffer.concat([buf, Buffer.from([1])])),
            verify: outcome(function() {
              return lib.crypto.ECDSA.verify(hashes[0], lib.crypto.Signature.fromDER(buf, false), new lib.PrivateKey(keys[0]).toPublicKey());
            })
          };
        });
      });
    });

    it('signs and verifies transactions alike', function() {
      keys.slice(0, 10).forEach(function(keyHex, k) {
        NETWORKS.forEach(function(network) {
          var label = 'transaction ' + k + ' ' + network;
          var o = same(label, function(lib) {
            var key = new lib.PrivateKey(keyHex, network);
            var other = new lib.PrivateKey(keys[(k + 1) % keys.length], network);
            var multi = [key, other, new lib.PrivateKey(keys[(k + 2) % keys.length], network)];
            var multiPubs = multi.map(function(p) { return p.toPublicKey(); });
            var p2shAddress = lib.Address.createMultisig(multiPubs, 2, network);
            var utxos = [{
              txId: crypto.createHash('sha256').update('utxo' + k).digest('hex'),
              outputIndex: k,
              address: key.toAddress().toString(),
              script: lib.Script.buildPublicKeyHashOut(key.toAddress()).toString(),
              satoshis: 100000 + k
            }, {
              txId: crypto.createHash('sha256').update('utxo2' + k).digest('hex'),
              outputIndex: 1,
              address: p2shAddress.toString(),
              script: lib.Script.buildScriptHashOut(p2shAddress).toString(),
              satoshis: 2500000
            }];
            var tx = new lib.Transaction()
              .from(utxos[0])
              .from(utxos[1], multiPubs, 2)
              .to(other.toAddress(), 50000)
              .to(p2shAddress, 1000000)
              .addData('flux differential ' + k)
              .change(key.toAddress())
              .fee(10000)
              .lockUntilBlockHeight(1000 + k)
              .sort()
              .sign([key, other]);
            var interpreter = new lib.Script.Interpreter();
            var flags = lib.Script.Interpreter.SCRIPT_VERIFY_P2SH | lib.Script.Interpreter.SCRIPT_VERIFY_STRICTENC;
            return {
              hex: tx.toString(),
              hash: tx.hash,
              object: tx.toObject(),
              fee: tx.getFee(),
              changeIndex: tx._changeIndex,
              signed: tx.isFullySigned(),
              verify: outcome(function() { return tx.verify(); }),
              serialize: outcome(function() { return tx.serialize(); }),
              valid: tx.inputs.map(function(input, i) {
                return interpreter.verify(input.script, input.output.script, tx, i, flags);
              }),
              sighashes: [0x01, 0x02, 0x03, 0x81, 0x82, 0x83].map(function(type) {
                return tx.inputs.map(function(input, i) {
                  return lib.Transaction.sighash.sighash(tx, type, i, input.output.script);
                });
              })
            };
          });
          expect(o.error, label).to.equal(undefined);
          expect(o.value.signed, label).to.equal(true);
          expect(o.value.valid[0], label + ' p2pkh input').to.equal(true);
        });
      });
    });
  });
});
