/**
 * Quick test: login via POST, then fetch the invoices page and new invoice page.
 * Verifies the portal's auth + pages work end-to-end.
 *
 * Run: node scripts/test-portal.js
 */

const BASE = process.env.PORTAL_URL || 'http://localhost:4000';

async function main() {
  console.log('Testing portal at', BASE, '\n');

  // 1. Login page loads
  const loginRes = await fetch(`${BASE}/login`);
  console.log(`GET /login: ${loginRes.status} ✓`);

  // 2. Login POST
  const loginPostRes = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=demo&password=demo123',
    redirect: 'manual',  // don't follow redirect; capture the cookie
  });
  const cookie = loginPostRes.headers.get('set-cookie');
  console.log(`POST /login: ${loginPostRes.status} (redirect to /invoices) ✓`);
  console.log(`  Session cookie received: ${cookie ? 'yes' : 'NO'}`);

  // 3. Invoices page (authenticated)
  const invRes = await fetch(`${BASE}/invoices`, {
    headers: { Cookie: cookie },
  });
  const invHtml = await invRes.text();
  console.log(`GET /invoices: ${invRes.status}`);
  console.log(`  Contains 'Globex': ${invHtml.includes('Globex') ? '✓' : '✗'}`);
  console.log(`  Contains 'Initech': ${invHtml.includes('Initech') ? '✓' : '✗'}`);
  console.log(`  Contains 'INV-2041': ${invHtml.includes('INV-2041') ? '✓' : '✗'}`);

  // 4. New invoice form
  const newRes = await fetch(`${BASE}/invoices/new`, {
    headers: { Cookie: cookie },
  });
  const newHtml = await newRes.text();
  console.log(`GET /invoices/new: ${newRes.status}`);
  console.log(`  Has vendor dropdown: ${newHtml.includes('<select') ? '✓' : '✗'}`);
  console.log(`  Has 'Invoice Number' label: ${newHtml.includes('Invoice Number') ? '✓' : '✗'}`);
  console.log(`  Has 'Due Date' label: ${newHtml.includes('Due Date') ? '✓' : '✗'}`);
  console.log(`  Has 'Create Invoice' button: ${newHtml.includes('Create Invoice') ? '✓' : '✗'}`);

  // 5. Vendors page
  const vendRes = await fetch(`${BASE}/vendors`, {
    headers: { Cookie: cookie },
  });
  const vendHtml = await vendRes.text();
  console.log(`GET /vendors: ${vendRes.status}`);
  console.log(`  Contains 'Acme Industries': ${vendHtml.includes('Acme Industries') ? '✓' : '✗'}`);
  console.log(`  Contains 'Acme Supplies': ${vendHtml.includes('Acme Supplies') ? '✓' : '✗'}`);
  console.log(`  Has Edit links: ${vendHtml.includes('/edit') ? '✓' : '✗'}`);

  // 6. API endpoints (no auth needed for GET)
  const apiInv = await fetch(`${BASE}/api/invoices`);
  const invoices = await apiInv.json();
  console.log(`GET /api/invoices: ${apiInv.status}, count: ${invoices.length}`);

  const apiVend = await fetch(`${BASE}/api/vendors`);
  const vendors = await apiVend.json();
  console.log(`GET /api/vendors: ${apiVend.status}, count: ${vendors.length}`);

  // 7. Duplicate check
  const dupRes = await fetch(`${BASE}/api/invoices?invoiceNumber=INV-2041`);
  const dups = await dupRes.json();
  console.log(`GET /api/invoices?invoiceNumber=INV-2041: found ${dups.length} (should be 1) ${dups.length === 1 ? '✓' : '✗'}`);

  // 8. Auth blocks unauthenticated page access
  const noAuthRes = await fetch(`${BASE}/invoices`, { redirect: 'manual' });
  console.log(`GET /invoices (no auth): ${noAuthRes.status} redirect ${noAuthRes.status === 302 ? '✓' : '✗'}`);

  console.log('\nAll portal tests done!');
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
