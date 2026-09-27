import path from 'node:path';

export const MODEL_ID = 'Xenova/dinov2-small';
export const MODEL_REVISION = 'c2bb04a51fab207c420665f1946016107bffc701';
export const MODEL_VERSION = `dinov2-small-q8-${MODEL_REVISION}-contain224-cls-v1`;
export const GALLERY_REVISION = '3370346474892c7df2ade7a0f73ad892fce3636f';
export const GALLERY_REPO = 'https://github.com/liangRXdev/pill-detective-tw';
export const VISION_ROOT = path.resolve(process.env.VISION_DATA_DIR || 'data/vision');
export const MODEL_ROOT = path.join(VISION_ROOT, 'models');
export const MODEL_PATH = path.join(MODEL_ROOT, MODEL_ID);
export const INDEX_PATH = path.join(VISION_ROOT, 'index.db');
export const IMAGE_ROOT = path.join(VISION_ROOT, 'images');
export const PACKAGE_ROOT = path.join(VISION_ROOT, 'packages');
export const PACKAGE_INDEX_PATH = path.join(PACKAGE_ROOT, 'index.db');
export const PACKAGE_IMAGE_ROOT = path.join(PACKAGE_ROOT, 'images');
export const DIMENSIONS = 384;
