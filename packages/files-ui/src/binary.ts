interface BinarySignature {
  name: string;
  offset?: number;
  bytes?: readonly number[];
  ascii?: string;
}

const SIGNATURES: readonly BinarySignature[] = [
  { name: "PNG image", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { name: "JPEG image", bytes: [0xff, 0xd8, 0xff] },
  { name: "Windows executable", ascii: "MZ" },
  { name: "MP4/QuickTime media", offset: 4, ascii: "ftyp" },
  { name: "RIFF media", ascii: "RIFF" },
  { name: "Ogg media", ascii: "OggS" },
  { name: "FLAC audio", ascii: "fLaC" },
  { name: "MP3 audio", ascii: "ID3" },
  { name: "GIF image", ascii: "GIF87a" },
  { name: "GIF image", ascii: "GIF89a" },
  { name: "PDF document", ascii: "%PDF-" },
  { name: "ZIP archive", bytes: [0x50, 0x4b, 0x03, 0x04] },
  { name: "ZIP archive", bytes: [0x50, 0x4b, 0x05, 0x06] },
  { name: "ZIP archive", bytes: [0x50, 0x4b, 0x07, 0x08] },
  { name: "gzip archive", bytes: [0x1f, 0x8b] },
  { name: "bzip2 archive", ascii: "BZh" },
  { name: "XZ archive", bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] },
  { name: "Zstandard archive", bytes: [0x28, 0xb5, 0x2f, 0xfd] },
  { name: "ELF executable", bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { name: "WebAssembly binary", bytes: [0x00, 0x61, 0x73, 0x6d] },
  { name: "RAR archive", ascii: "Rar!\u001a\u0007" },
  { name: "7-Zip archive", bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { name: "SQLite database", ascii: "SQLite format 3\u0000" },
  { name: "OLE compound document", bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
  { name: "Java class", bytes: [0xca, 0xfe, 0xba, 0xbe] },
  { name: "Mach-O binary", bytes: [0xfe, 0xed, 0xfa, 0xce] },
  { name: "Mach-O binary", bytes: [0xce, 0xfa, 0xed, 0xfe] },
  { name: "Mach-O binary", bytes: [0xfe, 0xed, 0xfa, 0xcf] },
  { name: "Mach-O binary", bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { name: "BMP image", ascii: "BM" },
  { name: "TIFF image", bytes: [0x49, 0x49, 0x2a, 0x00] },
  { name: "TIFF image", bytes: [0x4d, 0x4d, 0x00, 0x2a] },
  { name: "icon image", bytes: [0x00, 0x00, 0x01, 0x00] },
];

function signatureBytes(signature: BinarySignature): Uint8Array {
  if (signature.bytes) return Uint8Array.from(signature.bytes);
  return Buffer.from(signature.ascii ?? "", "latin1");
}

export function detectBinary(buffer: Uint8Array): { binary: boolean; kind?: string } {
  for (const signature of SIGNATURES) {
    const bytes = signatureBytes(signature);
    const offset = signature.offset ?? 0;
    if (buffer.length < offset + bytes.length) continue;
    let matches = true;
    for (let index = 0; index < bytes.length; index += 1) {
      if (buffer[offset + index] !== bytes[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return { binary: true, kind: signature.name };
  }
  if (buffer.includes(0)) return { binary: true, kind: "NUL-delimited/binary data" };
  return { binary: false };
}
