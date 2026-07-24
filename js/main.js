/**
 * Node Graph Editor Tutorial — Navigation & Syntax Highlighting
 */

// === Syntax highlighter for Rust code ===
const RUST_KEYWORDS = new Set([
  'fn', 'let', 'mut', 'pub', 'use', 'mod', 'struct', 'enum', 'trait', 'impl',
  'match', 'if', 'else', 'for', 'while', 'loop', 'return', 'break', 'continue',
  'as', 'ref', 'move', 'where', 'async', 'await', 'dyn', 'const', 'static',
  'unsafe', 'extern', 'crate', 'super', 'self', 'Self', 'type', 'in'
]);

const RUST_TYPES = new Set([
  'String', 'Vec', 'Option', 'Result', 'Box', 'Rc', 'Arc', 'HashMap',
  'HashSet', 'BTreeMap', 'BTreeSet', 'bool', 'char', 'i8', 'i16', 'i32',
  'i64', 'isize', 'u8', 'u16', 'u32', 'u64', 'usize', 'f32', 'f64', 'str',
  'Context', 'Ui', 'Condition', 'AppConfig', 'RunError', 'PinId', 'NodeId',
  'LinkId', 'EditorContext', 'NodeEditorFrame', 'PinKind', 'PinShape',
  'ColorElement', 'MiniMapLocation', 'StyleFlags', 'MouseButton',
  'ImNodesExt', 'NodeEditorUiExt', 'WgpuRenderer', 'WinitPlatform',
  'WgpuInitInfo', 'Application', 'FrameContext', 'AddOns', 'AddOnsConfig',
  'EditorConfig', 'SaveReasonFlags', 'SettingsHandler', 'EventLoop',
  'ControlFlow', 'WindowEvent', 'LogicalSize', 'Window', 'Instant',
  'ApplicationHandler', 'DockingConfig', 'Theme', 'RedrawMode',
  'RunnerCallbacks', 'RunnerConfig', 'WgpuConfig', 'GpuApi', 'DearAppError'
]);

function highlightRust(code) {
  let result = '';
  let i = 0;
  const len = code.length;

  while (i < len) {
    // Comments
    if (code[i] === '/' && code[i + 1] === '/') {
      let end = code.indexOf('\n', i);
      if (end === -1) end = len;
      const comment = code.slice(i, end);
      result += `<span class="tok-comment">${escHtml(comment)}</span>`;
      i = end;
      continue;
    }

    // Doc comments /// or //!
    if (code[i] === '/' && code[i + 1] === '/' && code[i + 2] === '/') {
      let end = code.indexOf('\n', i);
      if (end === -1) end = len;
      result += `<span class="tok-comment">${escHtml(code.slice(i, end))}</span>`;
      i = end;
      continue;
    }

    // Strings (regular and raw)
    if (code[i] === '"') {
      // Raw string r"..." or r#"..."#
      if (code[i - 1] === 'r') {
        // Check for raw string with hashes
        let hashCount = 0;
        let j = i + 1;
        if (code[j] === '#') {
          while (code[j] === '#') { hashCount++; j++; }
        }
        // find closing
        let endPat = '"'.padEnd(hashCount + 1, '#');
        let end = code.indexOf(endPat, i);
        if (end === -1) end = len;
        result += `<span class="tok-string">${escHtml(code.slice(i - 1, end + hashCount + 1))}</span>`;
        i = end + hashCount + 1;
        continue;
      }
      // Regular string
      let end = i + 1;
      while (end < len && !(code[end] === '"' && code[end - 1] !== '\\')) {
        end++;
      }
      end++;
      result += `<span class="tok-string">${escHtml(code.slice(i, end))}</span>`;
      i = end;
      continue;
    }

    // Char literals
    if (code[i] === "'" && i + 1 < len && code[i + 2] === "'" && code[i + 1] !== '\\') {
      result += `<span class="tok-string">${escHtml(code.slice(i, i + 3))}</span>`;
      i += 3;
      continue;
    }
    // Lifetimes like 'a, 'static
    if (code[i] === "'" && /[a-z]/i.test(code[i + 1])) {
      let end = i + 1;
      while (end < len && /[a-zA-Z0-9_]/.test(code[end])) end++;
      result += `<span class="tok-lifetime">${escHtml(code.slice(i, end))}</span>`;
      i = end;
      continue;
    }

    // Attributes #[...] and #![...]
    if (code[i] === '#' && code[i + 1] === '[') {
      let depth = 0;
      let end = i;
      while (end < len) {
        if (code[end] === '[') depth++;
        if (code[end] === ']') { depth--; if (depth === 0) { end++; break; } }
        end++;
      }
      result += `<span class="tok-attr">${escHtml(code.slice(i, end))}</span>`;
      i = end;
      continue;
    }

    // Macros (identifiers followed by !)
    if (/[a-z_]/i.test(code[i])) {
      let end = i;
      while (end < len && /[a-zA-Z0-9_]/.test(code[end])) end++;
      let word = code.slice(i, end);

      if (code[end] === '!') {
        result += `<span class="tok-macro">${escHtml(word)}</span>`;
        i = end;
        continue;
      }

      if (RUST_KEYWORDS.has(word)) {
        result += `<span class="tok-keyword">${escHtml(word)}</span>`;
      } else if (RUST_TYPES.has(word)) {
        result += `<span class="tok-type">${escHtml(word)}</span>`;
      } else if (/^[A-Z]/.test(word)) {
        result += `<span class="tok-type">${escHtml(word)}</span>`;
      } else {
        // Check if it's a function call (followed by paren)
        let j = end;
        while (j < len && code[j] === ' ') j++;
        if (code[j] === '(') {
          result += `<span class="tok-fn">${escHtml(word)}</span>`;
        } else {
          result += `<span class="tok-plain">${escHtml(word)}</span>`;
        }
      }
      i = end;
      continue;
    }

    // Numbers
    if (/[0-9]/.test(code[i])) {
      let end = i;
      while (end < len && /[0-9a-fA-Fx._eE+\-]/.test(code[end])) end++;
      result += `<span class="tok-number">${escHtml(code.slice(i, end))}</span>`;
      i = end;
      continue;
    }

    // Default: passthrough
    result += escHtml(code[i]);
    i++;
  }

  return result;
}

function escHtml(ch) {
  if (ch === '<') return '&lt;';
  if (ch === '>') return '&gt;';
  if (ch === '&') return '&amp;';
  return ch;
}

// === Apply highlighting to all code blocks ===
function highlightAll() {
  document.querySelectorAll('.code-block pre code').forEach(block => {
    if (!block.dataset.highlighted) {
      block.innerHTML = highlightRust(block.textContent);
      block.dataset.highlighted = 'true';
    }
  });
}

// === Copy button functionality ===
function setupCopyButtons() {
  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const codeEl = btn.closest('.code-block').querySelector('pre code');
      const text = codeEl.textContent;
      navigator.clipboard.writeText(text).then(() => {
        const orig = btn.textContent;
        btn.textContent = '✓ Copied';
        setTimeout(() => { btn.textContent = orig; }, 2000);
      });
    });
  });
}

// === Navigation ===
const chapters = [
  { id: 'intro', title: 'Introduction', section: 'Getting Started', num: '01' },
  { id: 'what-is', title: 'What is dear-imgui-rs?', section: 'Getting Started', num: '02' },
  { id: 'setup', title: 'Project Setup & Structure', section: 'Getting Started', num: '03' },
  { id: 'first-window', title: 'Your First Window', section: 'Core Concepts', num: '04' },
  { id: 'architecture', title: 'Application Architecture', section: 'Core Concepts', num: '05' },
  { id: 'node-editor', title: 'Introducing the Node Editor', section: 'Building the Editor', num: '06' },
  { id: 'nodes', title: 'Building Nodes & Pins', section: 'Building the Editor', num: '07' },
  { id: 'links', title: 'Links & Connections', section: 'Building the Editor', num: '08' },
  { id: 'styling', title: 'Modern Styling & Theming', section: 'Polish', num: '09' },
  { id: 'interactions', title: 'Interactions & UX', section: 'Polish', num: '10' },
  { id: 'persistence', title: 'State Persistence', section: 'Polish', num: '11' },
  { id: 'production', title: 'Production Architecture', section: 'Best Practices', num: '12' },
  { id: 'conclusion', title: 'Conclusion & Resources', section: 'Best Practices', num: '13' },
];

function buildSidebar() {
  const nav = document.querySelector('.sidebar-nav');
  let currentSection = '';
  let html = '';

  chapters.forEach(ch => {
    if (ch.section !== currentSection) {
      currentSection = ch.section;
      html += `<div class="nav-section-title">${currentSection}</div>`;
    }
    html += `<a href="#${ch.id}" class="nav-link" data-chapter="${ch.id}">
      <span class="nav-number">${ch.num}</span>
      <span>${ch.title}</span>
    </a>`;
  });

  nav.innerHTML = html;
}

function showChapter(chapterId) {
  // Hide all chapters
  document.querySelectorAll('.chapter-section').forEach(s => s.classList.remove('active'));

  // Show target
  const target = document.getElementById(`chapter-${chapterId}`);
  if (target) {
    target.classList.add('active');
  }

  // Update active nav link
  document.querySelectorAll('.nav-link').forEach(l => {
    l.classList.toggle('active', l.dataset.chapter === chapterId);
  });

  // Close mobile sidebar
  document.querySelector('.sidebar')?.classList.remove('open');

  // Scroll to top
  window.scrollTo({ top: 0, behavior: 'instant' });

  // Highlight code
  highlightAll();
  setupCopyButtons();

  // Update browser hash
  if (location.hash !== '#' + chapterId) {
    history.replaceState(null, '', '#' + chapterId);
  }
}

function setupNavigation() {
  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const chapterId = link.dataset.chapter;
      showChapter(chapterId);
    });
  });

  // Handle browser back/forward
  window.addEventListener('popstate', () => {
    const hash = location.hash.slice(1) || 'intro';
    showChapter(hash);
  });

  // Initial chapter from hash
  const initialHash = location.hash.slice(1) || 'intro';
  showChapter(chapters.some(c => c.id === initialHash) ? initialHash : 'intro');
}

function setupMobileMenu() {
  const toggle = document.querySelector('.menu-toggle');
  const sidebar = document.querySelector('.sidebar');
  toggle?.addEventListener('click', () => {
    sidebar.classList.toggle('open');
  });
}

// === Init ===
document.addEventListener('DOMContentLoaded', () => {
  buildSidebar();
  setupNavigation();
  setupMobileMenu();
  highlightAll();
  setupCopyButtons();
});
