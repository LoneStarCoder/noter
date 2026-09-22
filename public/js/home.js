// Home page: page picker and "create page" bar
(function () {
  const select = document.getElementById('page-select');
  const newPageInput = document.getElementById('new-page-name');

  function goToPage(name) {
    window.location.href = `/person/${encodeURIComponent(name)}`;
  }

  fetch('/pages')
    .then(res => res.json())
    .then(pages => {
      select.replaceChildren(new Option('Select a page', '', true, true));
      select.options[0].disabled = true;
      pages.forEach(name => select.appendChild(new Option(name, name)));
    })
    .catch(() => {
      select.replaceChildren(new Option('Failed to load pages', '', true, true));
    });

  document.getElementById('go-btn').addEventListener('click', () => {
    if (select.value) goToPage(select.value);
  });

  function createPage() {
    const name = newPageInput.value.trim().toLowerCase();
    if (!name || !/^[a-z0-9_\-]+$/.test(name)) {
      alert('Invalid name. Use only letters, numbers, hyphens, or underscores.');
      return;
    }
    goToPage(name);
  }

  document.getElementById('create-btn').addEventListener('click', createPage);
  newPageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createPage();
  });
})();
