/* eslint-disable @typescript-eslint/no-explicit-any */
import * as bitcoin from "bitcoinjs-lib";
import bs58 from "bs58";
import { padStart } from "lodash";
import { DerivationModes } from "./types";
import { Currency, ICrypto } from "./crypto/types";
import cryptoFactory from "./crypto/factory";
import { fallbackValidateAddress } from "./crypto/base";
import { UnsupportedDerivation } from "../../../errors";

export function parseHexString(str: any) {
  const result: Array<number> = [];
  while (str.length >= 2) {
    result.push(parseInt(str.substring(0, 2), 16));
    // eslint-disable-next-line no-param-reassign
    str = str.substring(2, str.length);
  }
  return result;
}

export function encodeBase58Check(vchIn: any) {
  // eslint-disable-next-line no-param-reassign
  vchIn = parseHexString(vchIn);
  let chksum = bitcoin.crypto.sha256(Buffer.from(vchIn));
  chksum = bitcoin.crypto.sha256(chksum);
  chksum = chksum.slice(0, 4);
  const hash = vchIn.concat(Array.from(chksum));
  return bs58.encode(hash);
}

export function toHexDigit(number: any) {
  const digits = "0123456789abcdef";
  // eslint-disable-next-line no-bitwise
  return digits.charAt(number >> 4) + digits.charAt(number & 0x0f);
}

export function toHexInt(number: any) {
  return (
    // eslint-disable-next-line no-bitwise
    toHexDigit((number >> 24) & 0xff) +
    // eslint-disable-next-line no-bitwise
    toHexDigit((number >> 16) & 0xff) +
    // eslint-disable-next-line no-bitwise
    toHexDigit((number >> 8) & 0xff) +
    // eslint-disable-next-line no-bitwise
    toHexDigit(number & 0xff)
  );
}

export function compressPublicKey(publicKey: any) {
  let compressedKeyIndex;
  if (publicKey.substring(0, 2) !== "04") {
    // eslint-disable-next-line no-throw-literal
    throw new Error("Invalid public key format");
  }
  if (parseInt(publicKey.substring(128, 130), 16) % 2 !== 0) {
    compressedKeyIndex = "03";
  } else {
    compressedKeyIndex = "02";
  }
  const result = compressedKeyIndex + publicKey.substring(2, 66);
  return result;
}

export function createXPUB(
  depth: any,
  fingerprint: any,
  childnum: any,
  chaincode: any,
  publicKey: any,
  network: any
) {
  let xpub = toHexInt(network);
  xpub += padStart(depth.toString(16), 2, "0");
  xpub += padStart(fingerprint.toString(16), 8, "0");
  xpub += padStart(childnum.toString(16), 8, "0");
  xpub += chaincode;
  xpub += publicKey;
  return xpub;
}

export function byteSize(count: number) {
  if (count < 0xfd) {
    return 1;
  }
  if (count <= 0xffff) {
    return 3;
  }
  if (count <= 0xffffffff) {
    return 5;
  }
  return 9;
}

const baseByte = 4;
function fixedWeight(currency: ICrypto, derivationMode: string): number {
  let fixedWeight = 4 * baseByte; // Transaction version
  if (currency.network.usesTimestampedTransaction) fixedWeight += 4 * baseByte; // Timestamp
  fixedWeight += 4 * baseByte; // Timelock
  if (derivationMode !== DerivationModes.LEGACY) {
    fixedWeight += 2; // Segwit marker & segwit flag, 1 WU per byte
  }
  return fixedWeight;
}

function inputWeight(derivationMode: string): number {
  let inputWeight = (32 + 4 + 1 + 4) * baseByte;
  if (derivationMode === DerivationModes.TAPROOT) {
    inputWeight += 1 + 1 + 65;
  } else if (derivationMode === DerivationModes.NATIVE_SEGWIT) {
    inputWeight += 1 + 1 + 72 + 1 + 33;
  } else if (derivationMode === DerivationModes.SEGWIT) {
    inputWeight += 22 * baseByte + 1 + 1 + 72 + 1 + 33;
  } else if (derivationMode === DerivationModes.LEGACY) {
    inputWeight += 107 * baseByte;
  } else {
    throw UnsupportedDerivation(`Derivation mode ${derivationMode} unknown`);
  }
  return inputWeight;
}

function outputWeight(derivationMode: string): number {
  let outputSize = 8 + 1; // amount + script size
  if (derivationMode === DerivationModes.TAPROOT) {
    outputSize += 34; // "1" + PUSH32 + <32 bytes>
  } else if (derivationMode === DerivationModes.NATIVE_SEGWIT) {
    outputSize += 22; // "0" + PUSH20 + <20 bytes>
  } else if (derivationMode === DerivationModes.SEGWIT) {
    outputSize += 23; // HASH160 + PUSH20 + <20 bytes> + EQUAL
  } else if (derivationMode === DerivationModes.LEGACY) {
    outputSize += 25; // DUP + HASH160 + PUSH20 + <20 bytes> + EQUALVERIFY + CHECKSIG
  } else {
    throw UnsupportedDerivation(derivationMode);
  }
  return outputSize * 4;
}

export function outputSize(currency: ICrypto, addr: string): number {
  const scriptLen = currency.toOutputScript(addr).length;
  return 1 + 8 + scriptLen;
}

/**
 * Calculates the maximun size of an imaginary transaction in virtual bytes
 * (vB). 1vB = 4 WU (weight units). If a cryptocurrency doesn't use segwit, then
 * 1 byte = 1 vB. Weight units are used for segwit transactions, where certain
 * bytes of the transaction is counted as 4 WU and some as 1 WU. The resulting
 * size is then ceil(totalWU/4) vB.
 *
 * refer to https://medium.com/coinmonks/on-bitcoin-transaction-sizes-part-2-9445373d17f4
 * and https://bitcoin.stackexchange.com/questions/96017/what-are-the-sizes-of-single-sig-and-2-of-3-multisig-taproot-inputs
 * and https://bitcoinops.org/en/tools/calc-size/
 *
 * Suggested improvement: I assume that these calculations won't be exactly
 * correct for altcoins (but I don't know). Therefore we should move this
 * functionality into ICrypto, to make it easier to provide slightly different
 * calculations for different cryptocurrencies.
 *
 * The reason for the name maxTxSize, instead of just txSize, is that the size
 * of modern ecdsa signatures aren't know beforehand. They are either 71 or
 * 72 bytes. This function always count with 72 byte signatures.
 *
 * The size of schnorr signatures is expected to be 65 bytes, since the Bitcoin
 * hardware app appends the optional sighash type 01 at the end of the
 * signature. If the app removes that optional byte, this functions should be
 * updated to use 64 byte schnorr signatures, even if 65 still is an acceptable
 * maximum.
 *
 * @param inputCount Number of inputs of the imaginary transaction
 * @param outputAddrs The addresses of the outputs, excluding change.
 * @param includeChange Indicates whether we should add a change output. The
 * change output will have the same derivation mode as the inputs. See
 * derivationMode parameter.
 * @param currency The currency for which the calculation is done.
 * @param derivationMode The derivation mode used for calculating the size of
 * the inputs.
 */
export function maxTxSize(
  inputCount: number,
  outputAddrs: string[],
  includeChange: boolean,
  currency: ICrypto,
  derivationMode: string
): number {
  const fixed = fixedWeight(currency, derivationMode);

  let outputsWeight = byteSize(outputAddrs.length) * baseByte; // Number of outputs;
  outputAddrs.forEach((addr) => {
    outputsWeight += outputSize(currency, addr) * baseByte;
  });
  if (includeChange) {
    outputsWeight += outputWeight(derivationMode);
  }

  // Input: 32 PrevTxHash + 4 Index + 1 scriptSigLength + 4 sequence
  let inputsWeight = byteSize(inputCount) * baseByte; // Number of inputs
  inputsWeight += inputWeight(derivationMode) * inputCount;

  const txWeight = fixed + inputsWeight + outputsWeight;
  return txWeight / 4;
}

export function maxTxSizeCeil(
  inputCount: number,
  outputAddrs: string[],
  includeChange: boolean,
  currency: ICrypto,
  derivationMode: string
): number {
  const s = maxTxSize(
    inputCount,
    outputAddrs,
    includeChange,
    currency,
    derivationMode
  );
  return Math.ceil(s);
}

// refer to https://github.com/LedgerHQ/lib-ledger-core/blob/fc9d762b83fc2b269d072b662065747a64ab2816/core/src/wallet/bitcoin/api_impl/BitcoinLikeTransactionApi.cpp#L253
export function computeDustAmount(currency: ICrypto, txSize: number) {
  let dustAmount = currency.network.dustThreshold;
  switch (currency.network.dustPolicy) {
    case "PER_KBYTE":
      dustAmount = (dustAmount * txSize) / 1000;
      break;
    case "PER_BYTE":
      dustAmount *= txSize;
      break;
    default:
      break;
  }
  return dustAmount;
}

export function isValidAddress(address: string, currency?: Currency) {
  if (!currency) {
    // If the caller doesn't provide the currency, we'll
    // fallback to a pre-taproot basic validation that doesn't
    // check every aspect of the address
    return fallbackValidateAddress(address);
  }
  const crypto = cryptoFactory(currency);
  return crypto.validateAddress(address);
}

export function isTaprootAddress(address: string, currency?: Currency) {
  if (currency === "bitcoin") {
    return cryptoFactory("bitcoin").isTaprootAddress(address);
  } else if (currency === "bitcoin_testnet") {
    return cryptoFactory("bitcoin_testnet").isTaprootAddress(address);
  } else {
    return false;
  }
}
