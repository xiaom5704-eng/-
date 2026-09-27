import { copyFile, cp, mkdir, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { prepareLabelOcr } from './prepare-label-ocr.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve('public/ocr');
const packageDir = name => path.dirname(require.resolve(`${name}/package.json`));
await mkdir(path.join(root, 'core'), { recursive: true });
await mkdir(path.join(root, 'lang'), { recursive: true });
await copyFile(path.join(packageDir('tesseract.js'), 'dist/worker.min.js'), path.join(root, 'worker.min.js'));
const core = packageDir('tesseract.js-core');
for (const file of await readdir(core)) {
  if (file.endsWith('.wasm.js')) await copyFile(path.join(core, file), path.join(root, 'core', file));
}
for (const language of ['eng', 'chi_tra']) {
  await copyFile(path.join(packageDir(`@tesseract.js-data/${language}`), '4.0.0_best_int', `${language}.traineddata.gz`), path.join(root, 'lang', `${language}.traineddata.gz`));
}
const pdf = packageDir('pdfjs-dist');
for (const folder of ['cmaps', 'standard_fonts', 'wasm']) await cp(path.join(pdf, folder), path.join(root, folder), { recursive: true });
for (const [name, file] of [['tesseract.js', 'LICENSE.md'], ['tesseract.js-core', 'LICENSE'], ['pdfjs-dist', 'LICENSE']]) {
  await copyFile(path.join(packageDir(name), file), path.join(root, `${name}-LICENSE.txt`));
}
console.log('OCR 引擎、繁中／英文模型與 PDF 字型已準備完成（由本機提供）。');
await prepareLabelOcr();
