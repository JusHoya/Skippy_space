// Color tokens, hex<->num, lighten/darken. PRD §3.4 + §12.3.
//
// Hex strings are kept as the source of truth (so CSS + Tailwind + design tokens
// can share them). Pixi wants numeric color, so `hexToNum` is provided.

export const PALETTE = {
  // Core (PRD §3.4)
  darkMatter: '#0B0C10',
  starlight: '#C5C6C7',
  neonCyan: '#66FCF1',
  mutedCyan: '#45A29E',
  electricPurple: '#BC13FE',
  // Board accents (PRD §12.3)
  marketingRed: '#FF6B6B',
  financeGold: '#F1C40F',
  researchPurple: '#9B59B6',
  publishingOrange: '#E67E22',
  devopsGreen: '#2ECC71',
} as const;

export type PaletteToken = keyof typeof PALETTE;

/** Numeric variant for Pixi APIs that want `number` rather than `'#RRGGBB'`. */
export const PALETTE_NUM: { [K in PaletteToken]: number } = {
  darkMatter: 0x0b0c10,
  starlight: 0xc5c6c7,
  neonCyan: 0x66fcf1,
  mutedCyan: 0x45a29e,
  electricPurple: 0xbc13fe,
  marketingRed: 0xff6b6b,
  financeGold: 0xf1c40f,
  researchPurple: 0x9b59b6,
  publishingOrange: 0xe67e22,
  devopsGreen: 0x2ecc71,
};

/** Convert `'#RRGGBB'` (with or without leading `#`) into a 24-bit number. */
export function hexToNum(hex: string): number {
  const s = hex.startsWith('#') ? hex.slice(1) : hex;
  const n = Number.parseInt(s, 16);
  if (Number.isNaN(n)) {
    throw new Error(`hexToNum: invalid hex "${hex}"`);
  }
  return n;
}

/** Convert a 24-bit number into `'#RRGGBB'`. */
export function numToHex(n: number): string {
  return `#${(n & 0xffffff).toString(16).padStart(6, '0').toUpperCase()}`;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Lighten `hex` toward white by `amt` in `[0, 1]`. */
export function lighten(hex: string, amt: number): string {
  const n = hexToNum(hex);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const k = clamp(amt, 0, 1);
  const nr = Math.round(r + (255 - r) * k);
  const ng = Math.round(g + (255 - g) * k);
  const nb = Math.round(b + (255 - b) * k);
  return numToHex((nr << 16) | (ng << 8) | nb);
}

/** Darken `hex` toward black by `amt` in `[0, 1]`. */
export function darken(hex: string, amt: number): string {
  const n = hexToNum(hex);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const k = 1 - clamp(amt, 0, 1);
  const nr = Math.round(r * k);
  const ng = Math.round(g * k);
  const nb = Math.round(b * k);
  return numToHex((nr << 16) | (ng << 8) | nb);
}
