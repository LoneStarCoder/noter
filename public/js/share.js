// Read-only view for share links (/s/<token>)
import { renderMarkdown } from './lib/markdown.js';
import { timeAgo } from './lib/ui.js';

const token = window.location.pathname.split('/').pop();
const content = document.getElementById('share-content');
const info = document.getElementById('share-info');

(async () => {
  let page;
  try {
    const res = await fetch(`/api/share/${encodeURIComponent(token)}`);
    if (!res.ok) throw new Error(res.status === 404 ? 'This link is no longer valid.' : 'Could not load this page.');
    page = await res.json();
  } catch (err) {
    content.textContent = err.message;
    return;
  }
  document.title = `${page.name} · Noter`;
  document.getElementById('share-title').textContent = page.name;
  info.textContent = `${page.name} · updated ${timeAgo(page.updatedAt)}${page.updatedBy ? ' by ' + page.updatedBy : ''}`;
  renderMarkdown(content, page.text, {
    attachmentUrl: file => `/api/share/${encodeURIComponent(token)}/attachments/${encodeURIComponent(file)}`
  });
})();
