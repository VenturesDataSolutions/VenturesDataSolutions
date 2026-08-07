// worker/src/kv.js
export async function getCountyLock(kv, countyId) {
  const value = await kv.get(countyId, { type: 'json' });
  return value || null;
}

export async function setCountyLock(kv, countyId, lock) {
  await kv.put(countyId, JSON.stringify(lock));
}

export async function clearCountyLock(kv, countyId) {
  await kv.delete(countyId);
}

export async function getPricingMode(kv) {
  const mode = await kv.get('settings:pricing_mode');
  return mode === 'full' ? 'full' : 'founding';
}
