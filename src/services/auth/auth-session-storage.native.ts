import type { SupportedStorage } from '@supabase/supabase-js';

async function getStorage() {
  const { default: AsyncStorage } = await import(
    '@react-native-async-storage/async-storage'
  );

  return AsyncStorage;
}

export const authSessionStorage: SupportedStorage = {
  async getItem(key) {
    return (await getStorage()).getItem(key);
  },
  async setItem(key, value) {
    await (await getStorage()).setItem(key, value);
  },
  async removeItem(key) {
    await (await getStorage()).removeItem(key);
  },
};
