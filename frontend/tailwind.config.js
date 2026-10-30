// All colours come from CSS variables (see src/index.css) so light/dark are two palettes of one system.
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;
export default {
  darkMode: ['class', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: v('bg'), surface: v('surface'), surface2: v('surface-2'), line: v('line'), fg: v('fg'), muted: v('muted'),
        accent: v('accent'), 'accent-ink': v('accent-ink'), 'accent-soft': v('accent-soft'),
        success: v('success'), warn: v('warn'), danger: v('danger'), info: v('info'),
      },
      fontFamily: { head: ['Syne', 'Inter', 'sans-serif'], body: ['Inter', 'system-ui', 'sans-serif'], mono: ['JetBrains Mono', 'ui-monospace', 'monospace'] },
      boxShadow: { card: 'var(--shadow-card)', pop: 'var(--shadow-pop)' },
      borderRadius: { xl: '0.875rem' },
    },
  },
};
