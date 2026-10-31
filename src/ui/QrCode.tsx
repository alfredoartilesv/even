import { useMemo } from "react";
import { encode } from "uqr";

/**
 * A QR code as one SVG path. Always dark on white, in dark mode too: phone cameras and jsQR read
 * that best, and the white quiet zone around it is part of the code.
 */
export function QrCode({ text, label, size = 220 }: { text: string; label: string; size?: number }) {
  const { path, n } = useMemo(() => {
    const qr = encode(text, { ecc: "M", border: 3 });
    let d = "";
    qr.data.forEach((row, y) => row.forEach((on, x) => on && (d += `M${x} ${y}h1v1h-1z`)));
    return { path: d, n: qr.size };
  }, [text]);
  return (
    <svg className="qr-code" role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges">
      <rect width={n} height={n} fill="var(--qr-light)" />
      <path d={path} fill="var(--qr-dark)" />
    </svg>
  );
}
