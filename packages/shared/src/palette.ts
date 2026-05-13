export const PALETTE = {
  darkMatter: '#0B0C10',
  starlight: '#C5C6C7',
  neonCyan: '#66FCF1',
  mutedCyan: '#45A29E',
  electricPurple: '#BC13FE',
  marketingRed: '#FF6B6B',
  financeGold: '#F1C40F',
  researchPurple: '#9B59B6',
  publishingOrange: '#E67E22',
  devopsGreen: '#2ECC71',
} as const;

export type PaletteKey = keyof typeof PALETTE;

export const PALETTE_NUM: Record<PaletteKey, number> = Object.fromEntries(
  Object.entries(PALETTE).map(([k, v]) => [k, parseInt(v.slice(1), 16)]),
) as Record<PaletteKey, number>;
