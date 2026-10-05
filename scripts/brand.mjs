/**
 * Derives every brand asset the app needs from the three source images in
 * `brand-source/`. Run it after changing the artwork:
 *
 *   node scripts/brand.mjs
 *
 * Keeping this as a script rather than committing hand-exported files means the
 * favicon, the app icon and the login banner can never drift apart.
 */
import sharp from "sharp";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "brand-source");
const webBrand = join(root, "web", "public", "brand");
const tauriIcons = join(root, "desktop", "src-tauri", "icons");

mkdirSync(webBrand, { recursive: true });
mkdirSync(tauriIcons, { recursive: true });

// The badge on the "small icon" artwork is the app icon; the crop is measured
// against the source image, so it only changes if the artwork does.
const badge = () =>
  sharp(join(src, "kivora_small_icon.png")).extract({ left: 142, top: 180, width: 276, height: 276 });

// The bare letterform, for places where a rounded badge would look wrong.
const mark = () =>
  sharp(join(src, "kivora_icon.png")).extract({ left: 152, top: 85, width: 400, height: 400 });

// The full lock-up, minus the printed edge of the source mock-up.
const wordmark = () =>
  sharp(join(src, "kivora_full_logo.png")).extract({ left: 44, top: 44, width: 768, height: 540 });

// ---- web -------------------------------------------------------------------

// These end up inside the server binary, so they are quantised rather than
// stored as full-colour PNGs. The artwork is a dark metal render: 128 colours
// is visually indistinguishable and roughly a fifth of the bytes.
const web = { palette: true, colours: 128, quality: 82, compressionLevel: 9 };

await badge().resize(512, 512).png(web).toFile(join(webBrand, "icon-512.png"));
await badge().resize(192, 192).png(web).toFile(join(webBrand, "icon-192.png"));
await badge().resize(180, 180).png(web).toFile(join(webBrand, "apple-touch-icon.png"));
await badge().resize(32, 32).png(web).toFile(join(webBrand, "favicon-32.png"));
await mark().resize(256, 256).png(web).toFile(join(webBrand, "mark-256.png"));

// The login banner is the one large image; WebP saves about 90% over PNG and
// every WebView Kivora targets has supported it for years.
await wordmark().resize(900, 627).webp({ quality: 84 }).toFile(join(webBrand, "logo.webp"));
await wordmark().resize(560, 390).png(web).toFile(join(webBrand, "logo.png"));

// ---- favicon.ico -----------------------------------------------------------
// The ICO container is a 6-byte header plus a 16-byte directory entry per size,
// each pointing at an embedded PNG. Small enough to write by hand; not worth a
// dependency.
// Windows only ever asks for the small sizes here; 128 and 256 would triple
// the file for an icon nobody sees at that size in a browser tab.
const icoSizes = [16, 32, 48];
const icoImages = [];
for (const size of icoSizes) icoImages.push(await badge().resize(size, size).png(web).toBuffer());

function buildIco(sizes, images) {
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((s, i) => {
    const at = 6 + i * 16;
    header.writeUInt8(s === 256 ? 0 : s, at);
    header.writeUInt8(s === 256 ? 0 : s, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(images[i].length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += images[i].length;
  });
  return Buffer.concat([header, ...images]);
}

const ico = buildIco(icoSizes, icoImages);
writeFileSync(join(webBrand, "favicon.ico"), ico);

// The desktop installer does want the large sizes.
writeFileSync(
  join(tauriIcons, "icon.ico"),
  buildIco(
    [16, 32, 48, 64, 128, 256],
    await Promise.all(
      [16, 32, 48, 64, 128, 256].map((s) => badge().resize(s, s).png({ compressionLevel: 9 }).toBuffer()),
    ),
  ),
);

// ---- desktop ---------------------------------------------------------------

await badge().resize(32, 32).png().toFile(join(tauriIcons, "32x32.png"));
await badge().resize(128, 128).png().toFile(join(tauriIcons, "128x128.png"));
await badge().resize(256, 256).png().toFile(join(tauriIcons, "128x128@2x.png"));
await badge().resize(512, 512).png().toFile(join(tauriIcons, "icon.png"));

// ---- web app manifest ------------------------------------------------------

writeFileSync(
  join(root, "web", "public", "manifest.webmanifest"),
  JSON.stringify(
    {
      name: "Kivora",
      short_name: "Kivora",
      description: "Self-hosted end-to-end encrypted messenger",
      start_url: "/",
      display: "standalone",
      background_color: "#0d1017",
      theme_color: "#0d1017",
      icons: [
        { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      ],
    },
    null,
    2,
  ) + "\n",
);

console.log("brand assets written");
