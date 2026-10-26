/**
 * Generate PDF invoices for the sandbox inbox.
 *
 * Creates: sandbox/inbox/acme-industries-oct.pdf
 *
 * WHY generate PDFs rather than committing binary files:
 * - Keeps the repo clean (no large binaries).
 * - The content is version-controlled in this script.
 * - Easy to regenerate if you need to change the test data.
 *
 * Run: npm run make-pdfs (or node sandbox/scripts/make-pdfs.js)
 */

import PDFDocument from 'pdfkit';
import { createWriteStream } from 'fs';
import { mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INBOX = path.join(__dirname, '..', 'inbox');

async function createAcmeIndustriesPdf() {
  await mkdir(INBOX, { recursive: true });

  const outPath = path.join(INBOX, 'acme-industries-oct.pdf');
  const doc = new PDFDocument({ margin: 60, size: 'A4' });
  const stream = createWriteStream(outPath);
  doc.pipe(stream);

  // ── Header ──
  doc.fontSize(20).font('Helvetica-Bold').text('Acme Industries', { align: 'center' });
  doc.fontSize(10).font('Helvetica').text('500 Industrial Blvd, Chicago IL', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(8).fillColor('#666').text('invoices@acmeindustries.example', { align: 'center' });
  doc.fillColor('#000');

  doc.moveDown(1.5);

  // ── Title ──
  doc.fontSize(16).font('Helvetica-Bold').text('INVOICE', { align: 'center' });
  doc.moveDown(1);

  // ── Invoice details ──
  const leftX = 60;
  const rightX = 350;
  const detailsY = doc.y;

  doc.fontSize(10).font('Helvetica');
  doc.text('Bill To:', leftX, detailsY);
  doc.font('Helvetica-Bold').text('Acme Corp', leftX, detailsY + 15);
  doc.font('Helvetica').text('Finance Department', leftX, detailsY + 28);

  doc.font('Helvetica-Bold');
  doc.text('Invoice Number:', rightX, detailsY);
  doc.font('Helvetica').text('AI-2024-0891', rightX + 105, detailsY);

  doc.font('Helvetica-Bold').text('Date:', rightX, detailsY + 18);
  doc.font('Helvetica').text('October 12, 2024', rightX + 105, detailsY + 18);

  doc.font('Helvetica-Bold').text('Due Date:', rightX, detailsY + 36);
  doc.font('Helvetica').text('November 12, 2024', rightX + 105, detailsY + 36);

  doc.font('Helvetica-Bold').text('Currency:', rightX, detailsY + 54);
  doc.font('Helvetica').text('USD', rightX + 105, detailsY + 54);

  doc.moveDown(6);

  // ── Line items table ──
  const tableTop = doc.y;
  const col1 = 60;
  const col2 = 380;
  const colWidth = doc.page.width - 120;

  // Table header
  doc.rect(col1, tableTop, colWidth, 20).fill('#f0f0f0');
  doc.fillColor('#000');
  doc.font('Helvetica-Bold').fontSize(9);
  doc.text('Description', col1 + 8, tableTop + 5);
  doc.text('Amount', col2, tableTop + 5, { width: 100, align: 'right' });

  // Table rows
  doc.font('Helvetica').fontSize(9);
  const items = [
    ['Industrial valve assembly (20 units)', '$3,200.00'],
    ['Custom fabrication - mounting brackets', '$1,150.00'],
    ['Shipping & handling', '$350.00'],
    ['Quality inspection certificate', '$500.00'],
  ];

  let rowY = tableTop + 25;
  for (const [desc, amt] of items) {
    doc.text(desc, col1 + 8, rowY);
    doc.text(amt, col2, rowY, { width: 100, align: 'right' });
    rowY += 18;
  }

  // Separator
  doc.moveTo(col1, rowY + 5).lineTo(col1 + colWidth, rowY + 5).stroke('#ccc');

  // Total
  rowY += 15;
  doc.font('Helvetica-Bold').fontSize(11);
  doc.text('TOTAL:', col2 - 50, rowY);
  doc.text('$5,200.00', col2, rowY, { width: 100, align: 'right' });

  doc.moveDown(4);

  // ── Footer ──
  doc.fontSize(9).font('Helvetica').fillColor('#666');
  doc.text('Payment Terms: Net 30', leftX);
  doc.text('Please remit payment to: invoices@acmeindustries.example', leftX);
  doc.moveDown(1);
  doc.text('Thank you for your business.', leftX);

  doc.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', () => {
      console.log(`[make-pdfs] Created: ${outPath}`);
      resolve();
    });
    stream.on('error', reject);
  });
}

async function main() {
  console.log('[make-pdfs] Generating PDF invoices...');
  await createAcmeIndustriesPdf();
  console.log('[make-pdfs] Done ✓');
}

main().catch(err => {
  console.error('[make-pdfs] Failed:', err);
  process.exit(1);
});
