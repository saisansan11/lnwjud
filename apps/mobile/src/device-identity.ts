import { generate, getPublicKeyFixed, type CryptoError, type PublicKey } from '@pagopa/io-react-native-crypto';
import { parseCompanionPublicKeyJwk, type CompanionPublicKeyJwk } from '@lnwjud/companion-contracts';

export const COMPANION_DEVICE_KEY_TAG = 'lnwjud.companion.device-key.v1';

export async function ensureDevicePublicKey(): Promise<CompanionPublicKeyJwk> {
  try {
    await generate(COMPANION_DEVICE_KEY_TAG);
  } catch (error) {
    if (!isCryptoError(error) || error.message !== 'KEY_ALREADY_EXISTS') throw hardwareKeyError(error);
  }
  const key = await getPublicKeyFixed(COMPANION_DEVICE_KEY_TAG);
  return normalizeEcKey(key);
}

function normalizeEcKey(key: PublicKey): CompanionPublicKeyJwk {
  if (key.kty !== 'EC' || key.crv !== 'P-256') {
    throw new Error('This device did not provide the required hardware-backed P-256 key.');
  }
  return parseCompanionPublicKeyJwk({
    kty: 'EC',
    crv: 'P-256',
    x: key.x,
    y: key.y,
    alg: 'ES256',
    use: 'sig',
    key_ops: ['verify'],
  });
}

function isCryptoError(error: unknown): error is CryptoError {
  return typeof error === 'object' && error !== null && 'message' in error && typeof (error as { readonly message?: unknown }).message === 'string';
}

function hardwareKeyError(error: unknown): Error {
  if (isCryptoError(error)) return new Error(`Hardware-backed device key unavailable (${error.message}).`);
  return error instanceof Error ? error : new Error('Hardware-backed device key is unavailable.');
}
