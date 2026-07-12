// Generates organized brand logo assets and favicons from the raw NYC Home
// Rehab source images. Run manually: `node scripts/generate-favicons.js`
// (or `npm run generate-favicons`). Source images are not vector, so no SVG
// output is produced — see README note below.
import sharp from "sharp";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LOGOS_DIR = path.join(ROOT, "client/src/assets/logos");
const PUBLIC_DIR = path.join(ROOT, "client/public");

const ICON_SOURCE = path.join(LOGOS_DIR, "logo-icon-source.png");
const FULL_SOURCE = path.join(LOGOS_DIR, "logo-full-source.jpeg");

const BRAND_CREAM = "#FAF5EE";

/**
 * The provided icon PNG has a flat white background baked in (no alpha
 * channel). This chroma-keys near-white pixels out to alpha 0, with a small
 * gradient band so anti-aliased edges don't get a hard cutout.
 */
async function whiteKeyToTransparent(inputPath) {
  const img = sharp(inputPath).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  for (let i = 0; i < data.length; i += channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const whiteness = (r + g + b) / 3;

    let alpha;
    if (whiteness >= 248) alpha = 0;
    else if (whiteness <= 225) alpha = 255;
    else alpha = Math.round(((248 - whiteness) / (248 - 225)) * 255);

    data[i + 3] = Math.min(data[i + 3], alpha);
  }

  return sharp(data, { raw: { width, height, channels } }).png();
}

function roundedRectSvg(size, radius, fill) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="${fill}"/>
    </svg>`
  );
}

/** Minimal ICO container embedding raw PNG entries (supported since Vista+, valid in all modern browsers). */
function buildIco(pngBuffers) {
  const count = pngBuffers.length;
  const headerSize = 6 + count * 16;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  let offset = headerSize;
  const entries = [];
  pngBuffers.forEach(({ size, buffer }, idx) => {
    const entryOffset = 6 + idx * 16;
    header.writeUInt8(size >= 256 ? 0 : size, entryOffset); // width (0 = 256)
    header.writeUInt8(size >= 256 ? 0 : size, entryOffset + 1); // height
    header.writeUInt8(0, entryOffset + 2); // color palette
    header.writeUInt8(0, entryOffset + 3); // reserved
    header.writeUInt16LE(1, entryOffset + 4); // color planes
    header.writeUInt16LE(32, entryOffset + 6); // bits per pixel
    header.writeUInt32LE(buffer.length, entryOffset + 8); // size in bytes
    header.writeUInt32LE(offset, entryOffset + 12); // offset
    offset += buffer.length;
    entries.push(buffer);
  });

  return Buffer.concat([header, ...entries]);
}

async function main() {
  fs.mkdirSync(LOGOS_DIR, { recursive: true });
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });

  console.log("Removing baked-in white background from icon source...");
  const transparentIcon = await whiteKeyToTransparent(ICON_SOURCE);
  const trimmed = await transparentIcon.clone().trim().toBuffer();

  // Master icon: transparent, padded square, used as the source for every
  // derived size below.
  const master = await sharp(trimmed)
    .resize(1024, 1024, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  await sharp(master).toFile(path.join(LOGOS_DIR, "logo-icon.png"));
  console.log("Wrote src/assets/logos/logo-icon.png (1024x1024, transparent)");

  // Full vertical lockup: trim the cream padding down, keep the baked-in
  // cream background (it matches the brand cream page background so this is
  // fine for header/login usage; not chroma-keyed since JPEG noise would
  // produce ugly halos around the serif text).
  const fullTrimmed = await sharp(FULL_SOURCE).trim({ background: BRAND_CREAM, threshold: 12 }).toBuffer();
  const fullTrimmedMeta = await sharp(fullTrimmed).metadata();
  // The source canvas has a lot of deliberate blank space below the
  // logo+text block (intended for signage/print, not a web header), which
  // trim() alone can't remove since it's the same cream as the background.
  // Crop top-anchored to a tighter content-only box.
  const contentHeight = Math.min(fullTrimmedMeta.height, Math.round(fullTrimmedMeta.width * 0.8));
  const fullCropped = await sharp(fullTrimmed)
    .extract({ left: 0, top: 0, width: fullTrimmedMeta.width, height: contentHeight })
    .toBuffer();
  const pad = Math.round(fullTrimmedMeta.width * 0.06);
  const fullPadded = await sharp(fullCropped)
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: BRAND_CREAM })
    .png()
    .toBuffer();
  const fullMeta = await sharp(fullPadded).metadata();
  await sharp(fullPadded)
    .resize({ width: Math.min(900, fullMeta.width), withoutEnlargement: true })
    .toFile(path.join(LOGOS_DIR, "logo-full.png"));
  console.log("Wrote src/assets/logos/logo-full.png");

  // "White" variant for dark (navy sidebar) backgrounds: the source has no
  // true monochrome-white master, and programmatically recoloring the navy
  // shape risks looking wrong on a client-facing mark. Instead, mount the
  // full-color icon on a small white rounded chip so it stays legible and
  // on-brand against the navy sidebar.
  const chipSize = 512;
  const chipRadius = 96;
  const chipBg = await sharp(roundedRectSvg(chipSize, chipRadius, "#FFFFFF")).png().toBuffer();
  const iconForChip = await sharp(master)
    .resize(Math.round(chipSize * 0.74), Math.round(chipSize * 0.74), { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();
  const inset = Math.round((chipSize - chipSize * 0.74) / 2);
  await sharp(chipBg)
    .composite([{ input: iconForChip, left: inset, top: inset }])
    .png()
    .toFile(path.join(LOGOS_DIR, "logo-white.png"));
  console.log("Wrote src/assets/logos/logo-white.png (icon-on-white-chip, for dark backgrounds)");

  // Favicons / PWA icons, all derived from the transparent master icon.
  const sizes = [
    { file: "favicon-16x16.png", size: 16, dir: PUBLIC_DIR },
    { file: "favicon-32x32.png", size: 32, dir: PUBLIC_DIR },
    { file: "android-chrome-192x192.png", size: 192, dir: PUBLIC_DIR },
    { file: "android-chrome-512x512.png", size: 512, dir: PUBLIC_DIR },
  ];
  for (const { file, size, dir } of sizes) {
    await sharp(master).resize(size, size).png().toFile(path.join(dir, file));
    console.log(`Wrote public/${file}`);
  }

  // Apple touch icon: iOS ignores alpha and renders it as black, so flatten
  // onto the brand cream background instead of leaving it transparent.
  await sharp(master)
    .resize(180, 180)
    .flatten({ background: BRAND_CREAM })
    .png()
    .toFile(path.join(PUBLIC_DIR, "apple-touch-icon.png"));
  console.log("Wrote public/apple-touch-icon.png (180x180, flattened onto brand cream)");

  // favicon.ico: 16 + 32px PNG-in-ICO container (valid since Windows Vista,
  // renders correctly in every current browser).
  const ico16 = await sharp(master).resize(16, 16).png().toBuffer();
  const ico32 = await sharp(master).resize(32, 32).png().toBuffer();
  const ico = buildIco([
    { size: 16, buffer: ico16 },
    { size: 32, buffer: ico32 },
  ]);
  fs.writeFileSync(path.join(PUBLIC_DIR, "favicon.ico"), ico);
  console.log("Wrote public/favicon.ico");

  console.log("\nDone. Note: source images are raster (PNG/JPEG), so no .svg logo variants were generated, and no separate horizontal lockup exists (Logo component falls back to the full logo for that variant).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
