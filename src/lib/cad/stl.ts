import type { BufferGeometry } from "three";

export function geometriesToStl(geoms: BufferGeometry[]): ArrayBuffer {
  let count = 0;
  for (const geom of geoms) {
    const pos = geom.getAttribute("position");
    if (!pos) continue;
    const idx = geom.getIndex();
    count += idx ? idx.count / 3 : pos.count / 3;
  }
  const buffer = new ArrayBuffer(84 + count * 50);
  const view = new DataView(buffer);
  const header = "Ferrite CAD binary STL";
  for (let i = 0; i < header.length && i < 80; i++) view.setUint8(i, header.charCodeAt(i));
  view.setUint32(80, count, true);
  let offset = 84;
  const writeTri = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number) => {
    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    view.setFloat32(offset, nx, true);
    view.setFloat32(offset + 4, ny, true);
    view.setFloat32(offset + 8, nz, true);
    view.setFloat32(offset + 12, ax, true);
    view.setFloat32(offset + 16, ay, true);
    view.setFloat32(offset + 20, az, true);
    view.setFloat32(offset + 24, bx, true);
    view.setFloat32(offset + 28, by, true);
    view.setFloat32(offset + 32, bz, true);
    view.setFloat32(offset + 36, cx, true);
    view.setFloat32(offset + 40, cy, true);
    view.setFloat32(offset + 44, cz, true);
    view.setUint16(offset + 48, 0, true);
    offset += 50;
  };
  for (const geom of geoms) {
    const pos = geom.getAttribute("position");
    if (!pos) continue;
    const idx = geom.getIndex();
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i += 3) {
      const ia = idx ? idx.getX(i) : i;
      const ib = idx ? idx.getX(i + 1) : i + 1;
      const ic = idx ? idx.getX(i + 2) : i + 2;
      writeTri(pos.getX(ia), pos.getY(ia), pos.getZ(ia), pos.getX(ib), pos.getY(ib), pos.getZ(ib), pos.getX(ic), pos.getY(ic), pos.getZ(ic));
    }
  }
  return buffer;
}

export function download(filename: string, data: BlobPart, type: string) {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function safeName(name: string): string {
  return name.replace(/[^\w\u0400-\u04FF-]+/g, "_").replace(/^_+|_+$/g, "") || "part";
}
