// Test the ESM import path
import pdfParseModule from 'pdf-parse';
console.log('ESM default type:', typeof pdfParseModule);
console.log('ESM default.default type:', typeof pdfParseModule?.default);

// Try the node subpath
import * as pdfParseNode from 'pdf-parse/node';
console.log('node subpath type:', typeof pdfParseNode);
console.log('node subpath default type:', typeof pdfParseNode?.default);
console.log('node subpath keys:', Object.keys(pdfParseNode ?? {}).slice(0, 5));
