// The source hash a rendered PNG carries in a tEXt chunk ("source-sha256").

import crypto from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";

export function digest(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function withStamp(png, sha) {
  const data = Buffer.from(`source-sha256\0${sha}`, "latin1");
  const type = Buffer.from("tEXt", "latin1");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([type, data])) >>> 0);
  const iend = png.length - 12;
  return Buffer.concat([png.subarray(0, iend), len, type, data, crc, png.subarray(iend)]);
}

export function stampOf(file) {
  if (!fs.existsSync(file)) return null;
  const png = fs.readFileSync(file);
  for (let at = 8; at + 8 <= png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.toString("latin1", at + 4, at + 8) === "tEXt") {
      const [key, value] = png.toString("latin1", at + 8, at + 8 + length).split("\0");
      if (key === "source-sha256") return value;
    }
    at += 12 + length;
  }
  return null;
}
