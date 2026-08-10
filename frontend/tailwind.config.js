/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        // Identical to bg by design: the uniform grey rounded panel is gone.
        // A panel is a hairline and an alignment, or — floating over the map —
        // a flat dark plate held by a border.
        surface: "var(--surface)",
        // The one quiet fill left: hover states and inputs with a body.
        surface2: "var(--surface-2)",
        hover: "var(--hover)",
        line: "var(--line)",
        hair: "var(--hair)",
        "line-soft": "var(--line-soft)",
        ink: "var(--ink)",
        ink2: "var(--ink-2)",
        ink3: "var(--ink-3)",
        // DECORATION ONLY (3.2:1). Rules, tick marks, disabled affordances,
        // echoes of something already stated. Quiet facts belong on ink3.
        ink4: "var(--ink-4)",
        // The single signal colour. Standing-estimate figures and live /
        // primary states. Nothing else.
        accent: "var(--accent)",
        "accent-soft": "var(--accent-soft)",
        "accent-ink": "var(--accent-ink)",
        good: "var(--good)",
        bad: "var(--bad)",
        background: "var(--background)",
        foreground: "var(--foreground)",
        card: { DEFAULT: "var(--card)", foreground: "var(--card-foreground)" },
        popover: { DEFAULT: "var(--popover)", foreground: "var(--popover-foreground)" },
        primary: { DEFAULT: "var(--primary)", foreground: "var(--primary-foreground)" },
        secondary: { DEFAULT: "var(--secondary)", foreground: "var(--secondary-foreground)" },
        muted: { DEFAULT: "var(--muted)", foreground: "var(--muted-foreground)" },
        destructive: { DEFAULT: "var(--destructive)", foreground: "var(--destructive-foreground)" },
        border: "var(--border)",
        input: "var(--input)",
        ring: "var(--ring)",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "ui-sans-serif", "system-ui", "-apple-system", "sans-serif"],
        // `font-mono` is DEMOTED, not removed: in this design filenames,
        // coordinates, timestamps and counts are Inter with tabular figures,
        // so the utility resolves to the sans stack and existing call sites
        // keep rendering — just without the typewriter costume. Reach for
        // `font-hash` / `.hash` when the text really is a hash.
        mono: ["var(--font-inter)", "ui-sans-serif", "system-ui", "-apple-system", "sans-serif"],
        hash: ["IBM Plex Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      fontSize: {
        // One scale, and it steps hard: everything that is not a figure sits
        // between 10 and 14.5px so the figures can be the only loud thing.
        "2xs": ["10px", "14px"],
        xs: ["11px", "16px"],
        sm: ["12px", "16.5px"],
        base: ["12.5px", "17px"],
        lead: ["14.5px", "19px"],
        title: ["17px", { lineHeight: "21px", letterSpacing: "-0.02em" }],
        page: ["22px", { lineHeight: "26px", letterSpacing: "-0.028em" }],
        // The heroes. Figures are set with optical tightening because tabular
        // numerals are wider than the lowercase they sit next to.
        fig: ["26px", { lineHeight: "26px", letterSpacing: "-0.03em" }],
        hero: ["46px", { lineHeight: "40px", letterSpacing: "-0.038em" }],
      },
      borderRadius: {
        // Square. The instrument has no rounded corners; `rounded-full`
        // survives for the few things that genuinely are dots.
        none: "0",
        DEFAULT: "0",
        sm: "0",
        md: "0",
        lg: "0",
        xl: "0",
        "2xl": "0",
        "3xl": "0",
        full: "9999px",
      },
      boxShadow: {
        // Only for things that leave the page plane (portals over the map).
        // Structure elsewhere is hairlines, not elevation.
        pop: "0 12px 32px rgb(0 0 0 / 0.5)",
      },
    },
  },
  plugins: [],
}
