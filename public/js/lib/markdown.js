// Markdown rendering: marked for parsing, DOMPurify for sanitizing, then a
// few notebook touches (checklists you can tick, [[page]] links, #tags, bare
// domain links, attachment URLs, copy buttons on code).
import { marked } from '/vendor/marked.esm.js';
import DOMPurify from '/vendor/purify.es.mjs';

marked.setOptions({ gfm: true, breaks: true });

const TASK_LINE = /^((?:\s*>)*\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\](?=\s|$)/;
const FENCE = /^\s*(```|~~~)/;
const BARE_DOMAIN = /(^|[\s(])((?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|edu|gov|co|us|uk|ca|au|de|ai|me|info|tv|gg|xyz|so|ly|to|fm|news|blog)(?:\/[^\s<]*)?)/gi;
const WIKILINK = /\[\[([a-z0-9_-]{1,100})\]\]/gi;
const HASHTAG = /(^|\s)#([a-z][\w-]{1,30})/gi;

// Line numbers (0-based) of task list items, skipping fenced code
export function taskLines(text) {
  const lines = text.split('\n');
  const result = [];
  let inFence = false;
  lines.forEach((line, index) => {
    if (FENCE.test(line)) inFence = !inFence;
    else if (!inFence && TASK_LINE.test(line)) result.push(index);
  });
  return result;
}

// Flips "[ ]" <-> "[x]" on the given line
export function toggleTaskLine(text, lineIndex, checked) {
  const lines = text.split('\n');
  lines[lineIndex] = lines[lineIndex].replace(TASK_LINE, (m, prefix) => `${prefix}[${checked ? 'x' : ' '}]`);
  return lines.join('\n');
}

function isExternal(href) {
  try {
    const url = new URL(href, window.location.href);
    return url.origin !== window.location.origin;
  } catch (err) {
    return false;
  }
}

// Replaces regex matches inside text nodes (outside links/code) with nodes
function transformText(root, pattern, build) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      return parent && parent.closest('a, code, pre') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    }
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    pattern.lastIndex = 0;
    if (!pattern.test(text)) continue;
    pattern.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      const lead = match[1] && match.length > 2 ? match[1] : '';
      const start = match.index + lead.length;
      if (start > last) fragment.append(text.slice(last, start));
      fragment.append(build(match));
      last = match.index + match[0].length;
    }
    if (last < text.length) fragment.append(text.slice(last));
    node.replaceWith(fragment);
  }
}

/**
 * Renders markdown into `container`.
 * options.attachmentUrl(file) -> URL for "attachments/<file>" references
 * options.pageUrl(name)       -> URL for [[name]] links
 * options.tagUrl(tag)         -> URL for #tag links (omit to leave tags as text)
 * options.onToggleTask(line, checked) -> enables clickable checkboxes
 */
export function renderMarkdown(container, text, options = {}) {
  const html = marked.parse(text || '');
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select'],
    FORBID_ATTR: ['style']
  });

  // Attachments referenced as attachments/<file>
  if (options.attachmentUrl) {
    for (const node of fragment.querySelectorAll('img[src], a[href]')) {
      const attr = node.tagName === 'IMG' ? 'src' : 'href';
      const value = node.getAttribute(attr);
      const match = /^(?:\.\/)?attachments\/(.+)$/.exec(value || '');
      if (match) node.setAttribute(attr, options.attachmentUrl(decodeURIComponent(match[1])));
    }
  }
  for (const img of fragment.querySelectorAll('img')) {
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
  }

  if (options.pageUrl) {
    transformText(fragment, WIKILINK, match => {
      const name = match[1].toLowerCase();
      return Object.assign(document.createElement('a'), { href: options.pageUrl(name), textContent: name, className: 'wikilink' });
    });
  }
  transformText(fragment, BARE_DOMAIN, match => {
    let url = match[2];
    const trailing = /[.,;:!?)]+$/.exec(url);
    const link = document.createElement('a');
    if (trailing) url = url.slice(0, -trailing[0].length);
    link.href = `https://${url}`;
    link.textContent = url;
    const frag = document.createDocumentFragment();
    frag.append(link);
    if (trailing) frag.append(trailing[0]);
    return frag;
  });
  if (options.tagUrl) {
    transformText(fragment, HASHTAG, match => Object.assign(document.createElement('a'), {
      href: options.tagUrl(match[2].toLowerCase()),
      textContent: `#${match[2]}`,
      className: 'hashtag'
    }));
  }

  for (const link of fragment.querySelectorAll('a[href]')) {
    if (isExternal(link.getAttribute('href'))) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
  }

  // Copy buttons on code blocks
  for (const pre of fragment.querySelectorAll('pre')) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy-btn';
    button.textContent = 'Copy';
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pre.querySelector('code')?.textContent || pre.textContent);
        button.textContent = 'Copied';
      } catch (err) {
        button.textContent = 'Press Ctrl+C';
      }
      setTimeout(() => (button.textContent = 'Copy'), 1500);
    });
    pre.append(button);
  }

  // Checklists
  const boxes = [...fragment.querySelectorAll('li > input[type="checkbox"], li > p > input[type="checkbox"]')];
  const lines = taskLines(text || '');
  const interactive = options.onToggleTask && boxes.length === lines.length;
  boxes.forEach((box, i) => {
    const li = box.closest('li');
    li.classList.add('task');
    li.classList.toggle('done', box.checked);
    if (interactive) {
      box.disabled = false;
      box.setAttribute('aria-label', 'Toggle item');
      box.addEventListener('change', () => {
        li.classList.toggle('done', box.checked);
        options.onToggleTask(lines[i], box.checked);
      });
    }
  });

  container.replaceChildren(fragment);
}
