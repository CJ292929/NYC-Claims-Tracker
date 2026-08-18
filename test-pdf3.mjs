// Test the node subpath which should work in Node.js ESM
import * as pdfParseNode from 'pdf-parse/node';
console.log('node subpath keys:', Object.keys(pdfParseNode ?? {}).slice(0, 10));
console.log('default type:', typeof pdfParseNode?.default);

// Try calling it
import { readFileSync } from 'fs';
const buf = readFileSync('/tmp/test_claims.xlsx');
try {
  const result = await pdfParseNode.default(buf);
  console.log('result:', result?.text?.slice(0, 100));
} catch(e) {
  console.log('error calling default:', e.message?.slice(0, 100));
}
