// Cosine retrieval assumes unit-length descriptors. Reject damaged vectors
// instead of normalizing them into apparently valid matching evidence.
/** @param {unknown} vector @param {number} dimensions */
export function isUnitVisionVector(vector, dimensions) {
  if (!(vector instanceof Float32Array) || !Number.isInteger(dimensions) || dimensions < 1 || vector.length !== dimensions) return false;
  let squaredNorm = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) return false;
    squaredNorm += value * value;
  }
  return Math.abs(Math.sqrt(squaredNorm) - 1) < 0.001;
}
