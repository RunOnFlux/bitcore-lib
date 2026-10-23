Bitcore Flux Library
=======

A pure and powerful JavaScript Flux library.

## Principles

Flux is a powerful new peer-to-peer platform for the next generation of financial technology. The decentralized nature of the Flux network allows for highly resilient Flux infrastructure, and the developer community needs reliable, open-source tools to implement Flux apps and services.

## Get Started

```
git clone https://github.com/runonflux/bitcore-lib.git
cd bitcore-lib
npm install
```


## Documentation

The complete docs are hosted here: [bitcore documentation](http://bitcore.io/guide/). There's also a [bitcore API reference](http://bitcore.io/api/) available generated from the JSDocs of the project, where you'll find low-level details on each bitcore utility.

- [Read the Developer Guide](http://bitcore.io/guide/)
- [Read the API Reference](http://bitcore.io/api/)

To get community assistance and ask for help with implementation questions, please use our [community forums](https://forum.bitcore.io/).

## Examples

* [Generate a random address](https://github.com/runonflux/bitcore-lib/blob/master/docs/examples.md#generate-a-random-address)
* [Generate a address from a SHA256 hash](https://github.com/runonflux/bitcore-lib/blob/master/docs/examples.md#generate-a-address-from-a-sha256-hash)
* [Import an address via WIF](https://github.com/runonflux/bitcore-lib/blob/master/docs/examples.md#import-an-address-via-wif)
* [Create a Transaction](https://github.com/runonflux/bitcore-lib/blob/master/docs/examples.md#create-a-transaction)
* [Sign a Flux message](https://github.com/runonflux/bitcore-lib/blob/master/docs/examples.md#sign-a-bitcoin-message)
* [Verify a Flux message](https://github.com/runonflux/bitcore-lib/blob/master/docs/examples.md#verify-a-bitcoin-message)
* [Create an OP RETURN transaction](https://github.com/runonflux/bitcore-lib/blob/master/docs/examples.md#create-an-op-return-transaction)
* [Create a 2-of-3 multisig P2SH address](https://github.com/runonflux/bitcore-lib/blob/master/docs/examples.md#create-a-2-of-3-multisig-p2sh-address)
* [Spend from a 2-of-2 multisig P2SH address](https://github.com/runonflux/bitcore-lib/blob/master/docs/examples.md#spend-from-a-2-of-2-multisig-p2sh-address)


## Security

We're using Bitcore in production, as are [many others](http://bitcore.io#projects), but please use common sense when doing anything related to finances! We take no responsibility for your implementation decisions.

If you find a security issue, please email security@bitpay.com.

## Development & Tests

```sh
git clone https://github.com/runonflux/bitcore-lib
cd bitcore-lib
npm install
```

Requires Node.js 24 or later. Run all the tests:

```sh
npm test
```

`npm test` runs every file under `test/` in its own mocha process and checks
each outcome against `test/inherited-failures.json`, the inherited upstream
tests that fail at runonflux/bitcore-lib 8f5453f. `test/differential.js`
checks this library against bitcore-lib 8f5453f, installed as the
devDependency `bitcore-lib-8f5453f`, on Flux mainnet blocks and transactions
(`test/data/flux-mainnet/corpus.json`, written by
`scripts/fetch-mainnet-corpus.js`), keys, addresses, HD keys and signatures.
A single file runs with `npx mocha test/<file>.js`.

## License

Code released under [the MIT license](https://github.com/runonflux/bitcore-lib/blob/master/LICENSE).

Copyright 2013-2015 BitPay, Inc. Bitcore is a trademark maintained by BitPay, Inc.
