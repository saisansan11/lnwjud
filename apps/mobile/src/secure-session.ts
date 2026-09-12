import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { parseStoredSession, type StoredCompanionSession } from './protocol';

const SESSION_KEY = 'lnwjud.companion.session.v1';
const DEVICE_ID_KEY = 'lnwjud.companion.device-id.v1';
const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export async function loadSession(): Promise<StoredCompanionSession | null> {
  if (!await SecureStore.isAvailableAsync()) throw new Error('Secure credential storage is unavailable on this device.');
  const raw = await SecureStore.getItemAsync(SESSION_KEY, secureOptions);
  if (raw === null) return null;
  try {
    return parseStoredSession(raw);
  } catch (error) {
    await SecureStore.deleteItemAsync(SESSION_KEY, secureOptions);
    throw error;
  }
}

export async function saveSession(session: StoredCompanionSession): Promise<void> {
  if (!await SecureStore.isAvailableAsync()) throw new Error('Secure credential storage is unavailable on this device.');
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session), secureOptions);
}

export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_KEY, secureOptions);
}

export async function getOrCreateDeviceId(): Promise<string> {
  if (!await SecureStore.isAvailableAsync()) throw new Error('Secure credential storage is unavailable on this device.');
  const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY, secureOptions);
  if (existing !== null && existing.length >= 8 && existing.length <= 256) return existing;
  const created = Crypto.randomUUID();
  await SecureStore.setItemAsync(DEVICE_ID_KEY, created, secureOptions);
  return created;
}
