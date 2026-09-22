// Applies the saved theme before first paint to avoid a flash of the wrong theme
try {
  const theme = localStorage.getItem('noter-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch (err) {
  // storage unavailable: follow the system theme
}
