import { createRequire } from 'module';
import { readFileSync } from 'fs';
const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');
console.log('PDFParse type:', typeof PDFParse);

// Create a simple test PDF buffer using a known PDF
// First test with a real PDF if available, otherwise just test the class
const parser = new PDFParse();
console.log('parser methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(parser)).filter(m => m !== 'constructor'));
