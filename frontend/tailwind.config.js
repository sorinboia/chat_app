const defaultTheme = require('tailwindcss/defaultTheme');

module.exports = {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          primary: '#E21D38',
          surface: '#F7F8FB',
          dark: '#111217',
        },
      },
      fontFamily: {
        sans: ['Inter', ...defaultTheme.fontFamily.sans],
      },
      boxShadow: {
        card: '0 18px 40px rgba(17, 18, 23, 0.08)',
      },
    },
  },
  plugins: [],
};
