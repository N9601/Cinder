// Rasterizes icons/logo.svg into 16/48/128 PNGs in icons/.
// Run with: node tools/render-icons.js  (from project root or tools/)

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const ICONS = path.join(__dirname, '..', 'icons');
const SVG = path.join(ICONS, 'logo.svg');
const SIZES = [16, 48, 128];

(async () => {
  const svgBuffer = fs.readFileSync(SVG);
  for (const size of SIZES) {
    // High density forces sharp to rasterize the SVG at a larger internal
    // resolution before downsampling — gives much better antialiasing.
    const density = Math.max(72, Math.ceil(72 * (256 / size)));
    const out = path.join(ICONS, `icon${size}.png`);
    await sharp(svgBuffer, { density })
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(out);
    console.log(`wrote ${out}`);
  }
})();
