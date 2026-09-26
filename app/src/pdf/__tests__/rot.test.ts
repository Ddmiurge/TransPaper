import { describe, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('rot', () => {
  it('第 30 页 pos_ 项的矩阵', async () => {
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(readFileSync('fixtures/single-column-sample.pdf')),
      standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts') + '/',
      disableFontFace: true,
      useSystemFonts: false,
    }).promise;
    const page = await doc.getPage(30);
    const tc = await page.getTextContent();
    for (const raw of tc.items as any[]) {
      if (typeof raw.str === 'string' && raw.str.includes('pos_')) {
        console.log(
          'ITEM [' + raw.str.slice(0, 20) + '] T=' +
            JSON.stringify(raw.transform.map((n: number) => Number(n.toFixed(2))))
        );
      }
    }
  });
});
