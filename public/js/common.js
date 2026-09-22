// Shared helpers for all Noter pages
(function () {
  const PASSWORD_HEADER = 'X-Noter-Password';
  const URL_PATTERN = /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9\-]+\.[a-z]{2,}[^\s]*/gi;

  // Renders text into el, turning URLs into links. Only text nodes and
  // anchors are created, so note content is never parsed as HTML.
  function renderLinkified(el, text) {
    el.replaceChildren();
    let last = 0;
    for (const match of text.matchAll(URL_PATTERN)) {
      if (match.index > last) el.append(text.slice(last, match.index));
      const url = match[0];
      const link = document.createElement('a');
      link.href = /^https?:\/\//i.test(url) ? url : 'https://' + url;
      link.textContent = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      el.append(link);
      last = match.index + url.length;
    }
    if (last < text.length) el.append(text.slice(last));
  }

  function extractPlainText(el) {
    return el.innerText || el.textContent || '';
  }

  // Passwords live in sessionStorage so they are forgotten when the browser closes
  function getPassword(key) {
    try {
      return sessionStorage.getItem('pw_' + key) || '';
    } catch (err) {
      return '';
    }
  }

  function setPassword(key, password) {
    try {
      if (password) sessionStorage.setItem('pw_' + key, password);
      else sessionStorage.removeItem('pw_' + key);
    } catch (err) {
      // storage unavailable: the password just won't be remembered
    }
  }

  function authHeaders(password, extra) {
    const headers = Object.assign({}, extra);
    if (password) headers[PASSWORD_HEADER] = encodeURIComponent(password);
    return headers;
  }

  // Older versions kept page passwords in localStorage in plain text; remove them
  try {
    Object.keys(localStorage)
      .filter(key => key.startsWith('pw_'))
      .forEach(key => localStorage.removeItem(key));
  } catch (err) {
    // storage unavailable
  }

  function initThemeToggle(button) {
    const themeStyle = document.getElementById('theme-style');
    let theme = 'light';
    try {
      theme = localStorage.getItem('theme') || 'light';
    } catch (err) {
      // storage unavailable
    }

    function apply() {
      themeStyle.href = theme === 'dark' ? '/dark.css' : '/style.css';
      if (button) button.textContent = theme === 'dark' ? '☀️' : '🌙';
    }

    apply();
    if (!button) return;
    button.addEventListener('click', () => {
      theme = theme === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem('theme', theme);
      } catch (err) {
        // storage unavailable
      }
      apply();
    });
  }

  window.Noter = { renderLinkified, extractPlainText, getPassword, setPassword, authHeaders, initThemeToggle };
})();
