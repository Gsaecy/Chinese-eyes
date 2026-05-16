// Simple 1x1 PNG generator - creates a minimal valid PNG as placeholder
// This script creates a proper 48x48 PNG icon

const fs = require('fs');
const path = require('path');

// Minimal PNG generator (48x48, colored circle with "CN" text-like representation)
// Using a simple approach: create a valid 48x48 PNG with a green circle
function createPNG() {
    // PNG Signature
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    
    // IHDR chunk (width=48, height=48, 8-bit RGBA)
    const width = 48;
    const height = 48;
    const bitDepth = 8;
    const colorType = 6; // RGBA
    const compression = 0;
    const filter = 0;
    const interlace = 0;
    
    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(width, 0);
    ihdrData.writeUInt32BE(height, 4);
    ihdrData[8] = bitDepth;
    ihdrData[9] = colorType;
    ihdrData[10] = compression;
    ihdrData[11] = filter;
    ihdrData[12] = interlace;
    
    // Create IHDR chunk
    const ihdrType = Buffer.from('IHDR');
    const ihdrLength = Buffer.alloc(4);
    ihdrLength.writeUInt32BE(13, 0);
    const ihdrCrcData = Buffer.concat([ihdrType, ihdrData]);
    const ihdrCrc = crc32(ihdrCrcData);
    const ihdrCrcBuf = Buffer.alloc(4);
    ihdrCrcBuf.writeUInt32BE(ihdrCrc, 0);
    
    const ihdrChunk = Buffer.concat([ihdrLength, ihdrType, ihdrData, ihdrCrcBuf]);
    
    // IDAT chunk - raw pixel data (filter byte + RGBA per row)
    const rawData = [];
    for (let y = 0; y < height; y++) {
        rawData.push(0); // filter byte: None
        for (let x = 0; x < width; x++) {
            // Center at (24, 24), radius ~20
            const dx = x - 23.5;
            const dy = y - 23.5;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist <= 20) {
                // Circle - green #1a9 (26, 153, 153)
                rawData.push(26, 153, 153, 255);
            } else {
                // Transparent
                rawData.push(0, 0, 0, 0);
            }
        }
    }
    
    // Compress with zlib (deflate)
    const zlib = require('zlib');
    const compressed = zlib.deflateSync(Buffer.from(rawData));
    
    const idatType = Buffer.from('IDAT');
    const idatLength = Buffer.alloc(4);
    idatLength.writeUInt32BE(compressed.length, 0);
    const idatCrcData = Buffer.concat([idatType, compressed]);
    const idatCrc = crc32(idatCrcData);
    const idatCrcBuf = Buffer.alloc(4);
    idatCrcBuf.writeUInt32BE(idatCrc, 0);
    
    const idatChunk = Buffer.concat([idatLength, idatType, compressed, idatCrcBuf]);
    
    // IEND chunk
    const iendType = Buffer.from('IEND');
    const iendLength = Buffer.alloc(4);
    iendLength.writeUInt32BE(0, 0);
    const iendCrcData = iendType;
    const iendCrc = crc32(iendCrcData);
    const iendCrcBuf = Buffer.alloc(4);
    iendCrcBuf.writeUInt32BE(iendCrc, 0);
    
    const iendChunk = Buffer.concat([iendLength, iendType, iendCrcBuf]);
    
    return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

// CRC32 calculation
function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let j = 0; j < 8; j++) {
            if (crc & 1) {
                crc = (crc >>> 1) ^ 0xEDB88320;
            } else {
                crc = crc >>> 1;
            }
        }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Write the PNG
const pngData = createPNG();
const outputPath = path.join(__dirname, '..', 'media', 'icon.png');
fs.writeFileSync(outputPath, pngData);
console.log('Icon PNG created at:', outputPath);
console.log('File size:', pngData.length, 'bytes');