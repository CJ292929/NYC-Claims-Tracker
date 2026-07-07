// Test pdfjs-dist text extraction
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFileSync } from 'fs';

// Create a minimal valid PDF for testing
// We'll use a simple approach - just test that the import works
console.log('pdfjs-dist imported successfully');
console.log('getDocument type:', typeof getDocument);

// Test with a minimal PDF buffer
const minimalPdf = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n' +
  '4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 100 700 Td (Hello World) Tj ET\nendstream\nendobj\n' +
  '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n' +
  'xref\n0 6\n0000000000 65535 f\n0000000009 00000 n\n0000000058 00000 n\n0000000115 00000 n\n0000000266 00000 n\n0000000360 00000 n\n' +
  'trailer<</Size 6/Root 1 0 R>>\nstartxref\n441\n%%EOF'
);

try {
  const loadingTask = getDocument({ data: new Uint8Array(minimalPdf) });
  const pdf = await loadingTask.promise;
  console.log('PDF loaded, pages:', pdf.numPages);
  const page = await pdf.getPage(1);
  const content = await page.getTextContent();
  const text = content.items.map(item => ('str' in item ? item.str : '')).join(' ');
  console.log('Extracted text:', text);
  console.log('SUCCESS: pdfjs-dist works correctly');
} catch (e) {
  console.log('Error:', e.message);
}
