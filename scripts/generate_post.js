#!/usr/bin/env node
/**
 * @ruhekodex Post Generator
 * Generiert PNG-Slides (schwarz/weiß) und postet via Blotato auf TikTok + Instagram
 */

const { Canvas, FontLibrary } = require('skia-canvas');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// === CONFIG ===
const BLOTATO_API_KEY = process.env.BLOTATO_API_KEY || 'blt_579IiEiE/J3SDtGSjscu4ZJnSJNUxd3vS3HtXyqzG0U=';
const BLOTATO_MCP_URL = 'https://mcp.blotato.com/mcp';
const TIKTOK_ACCOUNT_ID = '41347';
const INSTAGRAM_ACCOUNT_ID = '45672';

const REPO_DIR = path.resolve(__dirname, '..');
const READY_DIR = path.join(REPO_DIR, 'ready-to-post');
const POSTED_DIR = path.join(REPO_DIR, 'posted');
const FONT_PATH = path.join(__dirname, 'fonts', 'PlayfairDisplay.ttf');
const TMP_DIR = path.join(REPO_DIR, 'tmp_slides');

// === DESIGN ===
const W = 1080;
const H = 1350;
const BG = '#000000';
const FG = '#FFFFFF';
const MARGIN = 110;
const FONT_SIZE = 74;
const LINE_SPACING = 1.5;

// === FONT ===
FontLibrary.use('Playfair', FONT_PATH);

// === HELPERS ===
function wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let current = '';

  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width <= maxWidth) {
      current = test;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

async function createSlide(text, outputPath) {
  const canvas = new Canvas(W, H);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  // Font
  ctx.fillStyle = FG;
  ctx.font = `bold ${FONT_SIZE}px Playfair`;
  ctx.textAlign = 'left';

  const maxWidth = W - MARGIN * 2;
  const lines = wrapText(ctx, text, maxWidth);
  const lineH = FONT_SIZE * LINE_SPACING;
  const totalH = lines.length * lineH;
  let y = (H - totalH) / 2 + FONT_SIZE;

  for (const line of lines) {
    const lineWidth = ctx.measureText(line).width;
    const x = (W - lineWidth) / 2;
    ctx.fillText(line, x, y);
    y += lineH;
  }

  const buf = await canvas.toBuffer('png');
  fs.writeFileSync(outputPath, buf);
  console.log(`✓ Slide erstellt: ${path.basename(outputPath)}`);
}

// === PARSE MARKDOWN ===
function parsePost(filepath) {
  const content = fs.readFileSync(filepath, 'utf-8');

  // Extract Text-Overlay
  const overlayMatch = content.match(/## Text-Overlay\s*```\s*([\s\S]*?)\s*```/);
  const overlayText = overlayMatch ? overlayMatch[1].trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n') : '';

  // Split into slides by double newlines, filter out @handle lines
  const slides = overlayText
    .split(/\n\n+/)
    .map(s => s.trim().replace(/\n/g, ' '))
    .filter(s => s.length > 3)
    .filter(s => !s.startsWith('@'));

  // Extract Caption
  const captionMatch = content.match(/## Caption\s*\n(.+)/);
  const caption = captionMatch ? captionMatch[1].trim() : '';

  return { slides, caption };
}

// === BLOTATO API ===
async function blatoCall(toolName, args) {
  const res = await axios.post(BLOTATO_MCP_URL, {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: { name: toolName, arguments: args }
  }, {
    headers: {
      'Authorization': `Bearer ${BLOTATO_API_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    }
  });

  const content = res.data?.result?.content;
  if (!content) throw new Error(`Blotato ${toolName} fehlgeschlagen: ${JSON.stringify(res.data)}`);
  const text = content[0]?.text || '{}';
  if (res.data?.result?.isError) throw new Error(text);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function uploadImage(imagePath) {
  const fileName = path.basename(imagePath);

  // 1. Presigned URL holen
  const presigned = await blatoCall('blotato_create_presigned_upload_url', {
    filename: fileName,
    contentType: 'image/png'
  });

  const uploadUrl = presigned.item?.uploadUrl || presigned.uploadUrl || presigned.presignedUrl;
  const mediaUrl = presigned.item?.mediaUrl || presigned.mediaUrl || presigned.publicUrl;

  if (!uploadUrl) throw new Error(`Kein uploadUrl: ${JSON.stringify(presigned)}`);

  // 2. Bild hochladen
  const fileData = fs.readFileSync(imagePath);
  await axios.put(uploadUrl, fileData, {
    headers: { 'Content-Type': 'image/png' }
  });

  console.log(`✓ Hochgeladen: ${fileName}`);
  return mediaUrl;
}

async function createPost(mediaUrls, caption) {
  const accounts = [
    { id: TIKTOK_ACCOUNT_ID, platform: 'tiktok' },
    { id: INSTAGRAM_ACCOUNT_ID, platform: 'instagram' }
  ];

  for (const account of accounts) {
    try {
      const args = {
        text: caption,
        mediaUrls,
        accountId: account.id,
        platform: account.platform
      };
      if (account.platform === 'tiktok') {
        args.privacyLevel = 'PUBLIC_TO_EVERYONE';
        args.disabledComments = false;
        args.disabledDuet = false;
        args.disabledStitch = false;
        args.isBrandedContent = false;
        args.isYourBrand = false;
        args.isAiGenerated = false;
      }
      const result = await blatoCall('blotato_create_post', args);
      console.log(`✓ Gepostet auf ${account.platform}: ${result.item?.id || result.postSubmissionId || JSON.stringify(result)}`);
    } catch (e) {
      console.error(`✗ Fehler bei ${account.platform}: ${e.message}`);
    }
  }
}

// === MAIN ===
async function main() {
  // 1. Nächste Datei finden
  const files = fs.readdirSync(READY_DIR)
    .filter(f => f.endsWith('.md') && f !== '.gitkeep')
    .sort();

  if (files.length === 0) {
    console.log('Keine Posts in ready-to-post/ gefunden.');
    process.exit(0);
  }

  const nextFile = files[0];
  const filePath = path.join(READY_DIR, nextFile);
  console.log(`\n📄 Post: ${nextFile}`);

  // 2. Inhalt parsen
  const { slides, caption } = parsePost(filePath);
  console.log(`   ${slides.length} Slides, Caption: "${caption.substring(0, 50)}..."`);

  if (slides.length === 0) {
    console.error('❌ Keine Slides gefunden – Dateiformat prüfen.');
    process.exit(1);
  }

  // 3. Temp-Ordner
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

  // 4. PNG-Slides generieren
  const imagePaths = [];
  for (let i = 0; i < slides.length; i++) {
    const imgPath = path.join(TMP_DIR, `slide_${i + 1}.png`);
    await createSlide(slides[i], imgPath);
    imagePaths.push(imgPath);
  }

  // 5. Bilder hochladen
  console.log('\n📤 Lade Bilder hoch...');
  const mediaUrls = [];
  for (const imgPath of imagePaths) {
    const url = await uploadImage(imgPath);
    mediaUrls.push(url);
  }

  // 6. Post erstellen
  console.log('\n📱 Erstelle Posts...');
  await createPost(mediaUrls, caption);

  // 7. Datei nach posted/ verschieben
  const destPath = path.join(POSTED_DIR, nextFile);
  fs.renameSync(filePath, destPath);
  console.log(`\n✓ ${nextFile} → posted/`);

  // 8. Aufräumen
  for (const imgPath of imagePaths) fs.unlinkSync(imgPath);
  fs.rmdirSync(TMP_DIR);

  console.log('\n✅ Fertig!');
}

main().catch(err => {
  console.error('❌ Fehler:', err.message);
  process.exit(1);
});
