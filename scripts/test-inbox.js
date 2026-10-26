/**
 * Quick test: verify all inbox files are readable.
 * - .txt files: read content and show first few lines
 * - .pdf files: parse with pdf-parse and show extracted text
 *
 * Run: node scripts/test-inbox.js
 */

import { readdir, readFile } from 'fs/promises';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');

/** Helper: parse a PDF buffer and return { text, numpages } */
async function parsePdf(buffer) {
  const parser = new PDFParse(new Uint8Array(buffer));
  await parser.load();
  const info = await parser.getInfo();
  const numpages = info?.total || 1;
  const result = await parser.getText();
  const text = typeof result === 'string' ? result : (result?.text || '');
  await parser.destroy();
  return { text, numpages };
}

const INBOX = path.resolve('sandbox/inbox');

async function main() {
  const files = (await readdir(INBOX)).filter(f => !f.startsWith('.'));
  console.log(`Found ${files.length} files in inbox:\n`);

  for (const file of files.sort()) {
    const filePath = path.join(INBOX, file);
    const ext = path.extname(file).toLowerCase();

    console.log(`── ${file} ──`);

    if (ext === '.txt' || ext === '.md') {
      const content = await readFile(filePath, 'utf-8');
      // Show first 3 non-empty lines as preview.
      const preview = content.split('\n').filter(l => l.trim()).slice(0, 3);
      preview.forEach(l => console.log(`  ${l.trim()}`));
    } else if (ext === '.pdf') {
      const buffer = await readFile(filePath);
      const data = await parsePdf(buffer);
      // Show first 3 non-empty lines of extracted text.
      const preview = data.text.split('\n').filter(l => l.trim()).slice(0, 5);
      preview.forEach(l => console.log(`  ${l.trim()}`));
      console.log(`  (${data.numpages} page(s), ${data.text.length} chars extracted)`);
    }
    console.log('');
  }

  // Verify key data points the agent needs to extract.
  console.log('── Data verification ──');

  const globexOrig = await readFile(path.join(INBOX, 'globex_original.txt'), 'utf-8');
  const globexResub = await readFile(path.join(INBOX, 'globex_resubmission.txt'), 'utf-8');
  console.log(`Globex "original" mentions Oct: ${globexOrig.includes('October') ? '✓' : '✗'} (this is the LATEST)`);
  console.log(`Globex "resubmission" mentions Sept: ${globexResub.includes('September') ? '✓' : '✗'} (this is OLDER)`);

  const initech = await readFile(path.join(INBOX, 'initech-billing-oct.txt'), 'utf-8');
  console.log(`Initech has Indian format amount: ${initech.includes('1,24,500') ? '✓' : '✗'}`);
  console.log(`Initech invoice number: ${initech.includes('INV-2047') ? 'INV-2047 ✓' : '✗'}`);

  const dup = await readFile(path.join(INBOX, 'initech-payment-reminder.txt'), 'utf-8');
  console.log(`Duplicate file has INV-2041: ${dup.includes('INV-2041') ? '✓' : '✗'}`);

  const pdfBuf = await readFile(path.join(INBOX, 'acme-industries-oct.pdf'));
  const pdfData = await parsePdf(pdfBuf);
  console.log(`Acme Industries PDF has AI-2024-0891: ${pdfData.text.includes('AI-2024-0891') ? '✓' : '✗'}`);
  console.log(`Acme Industries PDF has $5,200: ${pdfData.text.includes('5,200') ? '✓' : '✗'}`);

  console.log('\nAll inbox tests done!');
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
