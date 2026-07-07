import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');
console.log('pdfParse type:', typeof pdfParse);
console.log('pdfParse.default type:', typeof pdfParse?.default);
console.log('Is function:', typeof pdfParse === 'function');
console.log('keys:', Object.keys(pdfParse ?? {}).slice(0, 5));
