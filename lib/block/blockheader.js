'use strict';

var _ = require('lodash');
var BN = require('../crypto/bn');
var BufferUtil = require('../util/buffer');
var BufferReader = require('../encoding/bufferreader');
var BufferWriter = require('../encoding/bufferwriter');
var Hash = require('../crypto/hash');
var JSUtil = require('../util/js');
var $ = require('../util/preconditions');

// Mainnet 0x1f07ffff, Testnet 0x2007ffff
var GENESIS_BITS = 0x1f07ffff;

// PON blocks use version 100 - high enough that POW miners won't accidentally use it
var PON_VERSION = 100;

/**
 * Calculate PON hash for Proof of Node blocks
 * @param {Object} collateral - The collateral outpoint {hash: Buffer, index: number}
 * @param {Buffer} prevBlockHash - The previous block hash
 * @param {Number} slot - The slot number
 * @returns {Buffer} - The PON hash
 */
var GetPONHash = function(collateral, prevBlockHash, slot) {
  // Create a deterministic hash from the three inputs
  // This ensures that the same fluxnode will always get the same hash for the same slot
  var bw = new BufferWriter();

  // Add collateral outpoint (txid + vout index)
  if (collateral) {
    bw.write(collateral.hash || Buffer.alloc(32));
    bw.writeUInt32LE(collateral.index || 0);
  } else {
    bw.write(Buffer.alloc(32));
    bw.writeUInt32LE(0);
  }

  // Add previous block hash for unpredictability
  bw.write(prevBlockHash);

  // Add slot number to ensure different hash for each slot
  bw.writeUInt32LE(slot);

  return Hash.sha256sha256(bw.concat());
};

/**
 * Calculate slot number for PON blocks
 * @param {Number} blockTime - The block timestamp
 * @param {Number} genesisTime - The genesis block timestamp
 * @param {Number} slotDuration - Slot duration in seconds (typically 30)
 * @returns {Number} - The slot number
 */
var GetSlotNumber = function(blockTime, genesisTime, slotDuration) {
  slotDuration = slotDuration || 30;  // Default 30 seconds per slot
  return Math.floor((blockTime - genesisTime) / slotDuration);
};

/**
 * Instantiate a BlockHeader from a Buffer, JSON object, or Object with
 * the properties of the BlockHeader
 *
 * @param {*} - A Buffer, JSON string, or Object
 * @returns {BlockHeader} - An instance of block header
 * @constructor
 */
var BlockHeader = function BlockHeader(arg) {
  if (!(this instanceof BlockHeader)) {
    return new BlockHeader(arg);
  }
  var info = BlockHeader._from(arg);
  this.version = info.version;
  this.prevHash = info.prevHash;
  this.merkleRoot = info.merkleRoot;
  this.reserved = info.reserved;  // hashFinalSaplingRoot for PON
  this.time = info.time;
  this.timestamp = info.time;
  this.bits = info.bits;

  // POW fields (version < 100)
  this.nonce = info.nonce;
  this.solution = info.solution;

  // PON fields (version >= 100)
  this.nodesCollateral = info.nodesCollateral;  // The UTXO used as collateral
  this.vchBlockSig = info.vchBlockSig;  // Signature proving ownership

  if (info.hash) {
    $.checkState(
      this.hash === info.hash,
      'Argument object hash property does not match block hash.'
    );
  }

  return this;
};

/**
 * @param {*} - A Buffer, JSON string or Object
 * @returns {Object} - An object representing block header data
 * @throws {TypeError} - If the argument was not recognized
 * @private
 */
BlockHeader._from = function _from(arg) {
  var info = {};
  if (BufferUtil.isBuffer(arg)) {
    info = BlockHeader._fromBufferReader(BufferReader(arg));
  } else if (_.isObject(arg)) {
    info = BlockHeader._fromObject(arg);
  } else {
    throw new TypeError('Unrecognized argument for BlockHeader');
  }
  return info;
};

/**
 * @param {Object} - A JSON string
 * @returns {Object} - An object representing block header data
 * @private
 */
BlockHeader._fromObject = function _fromObject(data) {
  $.checkArgument(data, 'data is required');
  var prevHash = data.prevHash;
  var merkleRoot = data.merkleRoot;
  var reserved = data.reserved || data.hashFinalSaplingRoot;  // Support both names
  var nonce = data.nonce;
  var solution = data.solution;
  var nodesCollateral = data.nodesCollateral;
  var vchBlockSig = data.vchBlockSig;

  if (_.isString(data.prevHash)) {
    prevHash = BufferUtil.reverse(Buffer.from(data.prevHash, 'hex'));
  }
  if (_.isString(data.merkleRoot)) {
    merkleRoot = BufferUtil.reverse(Buffer.from(data.merkleRoot, 'hex'));
  }
  if (_.isString(data.reserved) || _.isString(data.hashFinalSaplingRoot)) {
    reserved = BufferUtil.reverse(Buffer.from(data.reserved || data.hashFinalSaplingRoot, 'hex'));
  }
  if (_.isString(data.nonce)) {
    nonce = BufferUtil.reverse(Buffer.from(data.nonce, 'hex'));
  }
  if (_.isString(data.solution)) {
    solution = Buffer.from(data.solution, 'hex');
  }
  if (_.isString(data.vchBlockSig)) {
    vchBlockSig = Buffer.from(data.vchBlockSig, 'hex');
  }

  var info = {
    hash: data.hash,
    version: data.version,
    prevHash: prevHash,
    merkleRoot: merkleRoot,
    reserved: reserved,
    time: data.time,
    timestamp: data.time,
    bits: data.bits,
    nonce: nonce,
    solution: solution,
    nodesCollateral: nodesCollateral,
    vchBlockSig: vchBlockSig
  };
  return info;
};

/**
 * @param {Object} - A plain JavaScript object
 * @returns {BlockHeader} - An instance of block header
 */
BlockHeader.fromObject = function fromObject(obj) {
  var info = BlockHeader._fromObject(obj);
  return new BlockHeader(info);
};

/**
 * @param {Binary} - Raw block binary data or buffer
 * @returns {BlockHeader} - An instance of block header
 */
BlockHeader.fromRawBlock = function fromRawBlock(data) {
  if (!BufferUtil.isBuffer(data)) {
    data = Buffer.from(data, 'binary');
  }
  var br = BufferReader(data);
  br.pos = BlockHeader.Constants.START_OF_HEADER;
  var info = BlockHeader._fromBufferReader(br);
  return new BlockHeader(info);
};

/**
 * @param {Buffer} - A buffer of the block header
 * @returns {BlockHeader} - An instance of block header
 */
BlockHeader.fromBuffer = function fromBuffer(buf) {
  var info = BlockHeader._fromBufferReader(BufferReader(buf));
  return new BlockHeader(info);
};

/**
 * @param {string} - A hex encoded buffer of the block header
 * @returns {BlockHeader} - An instance of block header
 */
BlockHeader.fromString = function fromString(str) {
  var buf = Buffer.from(str, 'hex');
  return BlockHeader.fromBuffer(buf);
};

/**
 * @param {BufferReader} - A BufferReader of the block header
 * @returns {Object} - An object representing block header data
 * @private
 */
BlockHeader._fromBufferReader = function _fromBufferReader(br) {
  var info = {};
  info.version = br.readUInt32LE();
  info.prevHash = br.read(32);
  info.merkleRoot = br.read(32);
  info.reserved = br.read(32);  // hashFinalSaplingRoot
  info.time = br.readUInt32LE();
  info.bits = br.readUInt32LE();

  // Serialize based on version
  if (info.version >= PON_VERSION) {
    // PON block
    // Read collateral outpoint (hash + index)
    var collateralHash = br.read(32);
    var collateralIndex = br.readUInt32LE();
    info.nodesCollateral = {
      hash: collateralHash,
      index: collateralIndex
    };

    // Read block signature
    var sigLength = br.readVarintNum();
    info.vchBlockSig = br.read(sigLength);
  } else {
    // POW block
    info.nonce = br.read(32);
    var lenSolution = br.readVarintNum();
    info.solution = br.read(lenSolution);
  }

  return info;
};

/**
 * @param {BufferReader} - A BufferReader of the block header
 * @returns {BlockHeader} - An instance of block header
 */
BlockHeader.fromBufferReader = function fromBufferReader(br) {
  var info = BlockHeader._fromBufferReader(br);
  return new BlockHeader(info);
};

/**
 * @returns {Object} - A plain object of the BlockHeader
 */
BlockHeader.prototype.toObject = BlockHeader.prototype.toJSON = function toObject() {
  var obj = {
    hash: this.hash,
    version: this.version,
    prevHash: BufferUtil.reverse(this.prevHash).toString('hex'),
    merkleRoot: BufferUtil.reverse(this.merkleRoot).toString('hex'),
    reserved: BufferUtil.reverse(this.reserved).toString('hex'),
    hashFinalSaplingRoot: BufferUtil.reverse(this.reserved).toString('hex'),  // Alias for reserved
    time: this.time,
    bits: this.bits
  };

  if (this.version >= PON_VERSION) {
    // PON block fields
    if (this.nodesCollateral) {
      obj.nodesCollateral = {
        hash: BufferUtil.reverse(this.nodesCollateral.hash).toString('hex'),
        index: this.nodesCollateral.index
      };
    }
    if (this.vchBlockSig) {
      obj.vchBlockSig = this.vchBlockSig.toString('hex');
    }
  } else {
    // POW block fields
    if (this.nonce) {
      obj.nonce = BufferUtil.reverse(this.nonce).toString('hex');
    }
    if (this.solution) {
      obj.solution = this.solution.toString('hex');
    }
  }

  return obj;
};

/**
 * @returns {Buffer} - A Buffer of the BlockHeader
 */
BlockHeader.prototype.toBuffer = function toBuffer() {
  return this.toBufferWriter().concat();
};

/**
 * @returns {string} - A hex encoded string of the BlockHeader
 */
BlockHeader.prototype.toString = function toString() {
  return this.toBuffer().toString('hex');
};

/**
 * @param {BufferWriter} - An existing instance BufferWriter
 * @returns {BufferWriter} - An instance of BufferWriter representation of the BlockHeader
 */
BlockHeader.prototype.toBufferWriter = function toBufferWriter(bw, forHash) {
  if (!bw) {
    bw = new BufferWriter();
  }
  bw.writeUInt32LE(this.version);
  bw.write(this.prevHash);
  bw.write(this.merkleRoot);
  bw.write(this.reserved);  // hashFinalSaplingRoot
  bw.writeUInt32LE(this.time);
  bw.writeUInt32LE(this.bits);

  // Serialize based on version
  if (this.version >= PON_VERSION) {
    // PON block
    if (this.nodesCollateral) {
      bw.write(this.nodesCollateral.hash || Buffer.alloc(32));
      bw.writeUInt32LE(this.nodesCollateral.index || 0);
    } else {
      bw.write(Buffer.alloc(32));  // Empty hash
      bw.writeUInt32LE(0);  // Index 0
    }

    // Exclude signature when computing hash for signing (forHash parameter)
    // This prevents circular dependency when signing the block
    if (!forHash && this.vchBlockSig) {
      bw.writeVarintNum(this.vchBlockSig.length);
      bw.write(this.vchBlockSig);
    } else if (!forHash) {
      bw.writeVarintNum(0);  // Empty signature
    }
  } else {
    // POW block
    bw.write(this.nonce || Buffer.alloc(32));
    if (this.solution) {
      bw.writeVarintNum(this.solution.length);
      bw.write(this.solution);
    } else {
      bw.writeVarintNum(0);
    }
  }

  return bw;
};

/**
 * Returns the target difficulty for this block
 * @param {Number} bits
 * @returns {BN} An instance of BN with the decoded difficulty bits
 */
BlockHeader.prototype.getTargetDifficulty = function getTargetDifficulty(bits) {
  bits = bits || this.bits;

  var target = new BN(bits & 0xffffff);
  var mov = 8 * ((bits >>> 24) - 3);
  while (mov-- > 0) {
    target = target.mul(new BN(2));
  }
  return target;
};

/**
 * @link https://en.bitcoin.it/wiki/Difficulty
 * @return {Number}
 */
BlockHeader.prototype.getDifficulty = function getDifficulty() {
  var difficulty1TargetBN = this.getTargetDifficulty(GENESIS_BITS).mul(new BN(Math.pow(10, 8)));
  var currentTargetBN = this.getTargetDifficulty();

  var difficultyString = difficulty1TargetBN.div(currentTargetBN).toString(10);
  var decimalPos = difficultyString.length - 8;
  difficultyString = difficultyString.slice(0, decimalPos) + '.' + difficultyString.slice(decimalPos);

  return parseFloat(difficultyString);
};

/**
 * Get PON hash for this block header
 * @param {Number} genesisTime - Genesis block timestamp (required for PON blocks)
 * @param {Number} slotDuration - Slot duration in seconds (default 30)
 * @returns {Buffer} - The PON hash
 */
BlockHeader.prototype.getPONHash = function(genesisTime, slotDuration) {
  if (this.version < PON_VERSION) {
    throw new Error('getPONHash can only be called on PON blocks (version >= ' + PON_VERSION + ')');
  }

  var slot = GetSlotNumber(this.time, genesisTime, slotDuration);
  return GetPONHash(this.nodesCollateral, this.prevHash, slot);
};

/**
 * @returns {Buffer} - The little endian hash buffer of the header
 */
BlockHeader.prototype._getHash = function hash() {
  if (this.version >= PON_VERSION) {
    // PON blocks use a different hash calculation
    // Since we don't have chain params here, we can't compute the actual PON hash
    // The caller should use getPONHash() method with proper genesis time
    // For compatibility, we still return a hash based on header data

    // WARNING: This is not the actual block hash for PON blocks!
    // Use getPONHash(genesisTime) for the correct hash
    var buf = this.toBufferWriter(null, true).concat();  // true = forHash (excludes signature)
    return Hash.sha256sha256(buf);
  } else {
    // POW blocks use standard double SHA256 of the serialized header
    var buf = this.toBuffer();
    return Hash.sha256sha256(buf);
  }
};

var idProperty = {
  configurable: false,
  enumerable: true,
  /**
   * @returns {string} - The big endian hash buffer of the header
   */
  get: function() {
    if (!this._id) {
      this._id = BufferReader(this._getHash()).readReverse().toString('hex');
    }
    return this._id;
  },
  set: _.noop
};
Object.defineProperty(BlockHeader.prototype, 'id', idProperty);
Object.defineProperty(BlockHeader.prototype, 'hash', idProperty);

/**
 * @returns {Boolean} - If timestamp is not too far in the future
 */
BlockHeader.prototype.validTimestamp = function validTimestamp() {
  var currentTime = Math.round(new Date().getTime() / 1000);
  if (this.time > currentTime + BlockHeader.Constants.MAX_TIME_OFFSET) {
    return false;
  }
  return true;
};

/**
 * @returns {Boolean} - If the proof-of-work hash satisfies the target difficulty
 */
BlockHeader.prototype.validProofOfWork = function validProofOfWork() {
  if (this.version >= PON_VERSION) {
    // PON blocks don't use proof of work
    // They use deterministic slot-based selection
    // Validation would require checking:
    // 1. The node had valid collateral
    // 2. The node was selected for this slot
    // 3. The signature is valid
    // This requires external chain state, so we can't validate here
    return true;  // Assume valid, actual validation happens at higher level
  }

  // POW validation for traditional blocks
  var pow = new BN(this.id, 'hex');
  var target = this.getTargetDifficulty();

  if (pow.cmp(target) > 0) {
    return false;
  }
  return true;
};

/**
 * @returns {string} - A string formatted for the console
 */
BlockHeader.prototype.inspect = function inspect() {
  return '<BlockHeader ' + this.id + '>';
};

BlockHeader.Constants = {
  START_OF_HEADER: 8, // Start buffer position in raw block data
  MAX_TIME_OFFSET: 2 * 60 * 60, // The max a timestamp can be in the future
  LARGEST_HASH: new BN('10000000000000000000000000000000000000000000000000000000000000000', 'hex'),
  PON_VERSION: PON_VERSION,  // Export PON version constant
  DEFAULT_SLOT_DURATION: 30  // Default 30 seconds per slot
};

// Export helper functions
BlockHeader.GetPONHash = GetPONHash;
BlockHeader.GetSlotNumber = GetSlotNumber;

module.exports = BlockHeader;
