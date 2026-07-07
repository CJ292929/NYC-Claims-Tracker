import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const m = require('pdf-parse');
const fns = Object.entries(m).filter(([k,v]) => typeof v === 'function');
console.log('All function exports:', fns.map(([k]) => k));
console.log('Total exports:', Object.keys(m).length);

// Try the ESM import
import * as pdfEsm from 'pdf-parse';
const esmFns = Object.entries(pdfEsm).filter(([k,v]) => typeof v === 'function');
console.log('ESM function exports:', esmFns.map(([k]) => k));
