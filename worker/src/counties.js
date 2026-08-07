// worker/src/counties.js
import countiesData from '../data/counties.json' with { type: 'json' };

export function loadCounties() {
  return countiesData;
}

export function isValidCountyId(counties, countyId) {
  return counties.some((c) => c.id === countyId);
}

export function findCounty(counties, countyId) {
  return counties.find((c) => c.id === countyId);
}
