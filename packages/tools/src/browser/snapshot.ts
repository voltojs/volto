/**
 * Snapshot contract and formatter for the agent browser.
 *
 * The page-side script assigns `data-volto-ref="eN"` to interactive elements
 * and returns a small, ordered node list. The host formats that list as text;
 * refs die on the next snapshot or page change.
 */

export interface BrowserState {
  url: string;
  title: string;
  status: "live" | "loading" | "crashed";
  viewport: { width: number; height: number };
}

export interface SnapshotOutcome {
  text: string;
  truncated: boolean;
}

export interface ActionOutcome extends SnapshotOutcome {
  state: BrowserState;
}

export interface DiagnosticsOutcome {
  text: string;
  truncated: boolean;
}

export interface StorageStateOutcome {
  path: string;
  savedAt: number;
}

/** One page node as returned by `SNAPSHOT_SCRIPT`. */
export interface SnapshotNode {
  depth: number;
  role: string;
  name?: string;
  text?: string;
  ref?: string;
  level?: number;
  checked?: boolean;
  disabled?: boolean;
}

export interface FormatSnapshotOptions {
  /** Hard cap for the formatted text. Defaults to 8000. */
  maxChars?: number;
  /** Emit only text nodes, one per line. */
  textOnly?: boolean;
}

const DEFAULT_MAX_CHARS = 8000;
const TRUNCATION_MARKER = "\n... [truncated]";

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function truncate(text: string, maxChars: number): SnapshotOutcome {
  if (text.length <= maxChars) return { text, truncated: false };
  if (maxChars <= TRUNCATION_MARKER.length) {
    return { text: text.slice(0, maxChars), truncated: true };
  }
  return {
    text: text.slice(0, maxChars - TRUNCATION_MARKER.length) + TRUNCATION_MARKER,
    truncated: true,
  };
}

function formatNode(node: SnapshotNode): string {
  const indent = "  ".repeat(Math.max(0, node.depth));
  if (node.role === "text") {
    return `${indent}- text: ${normalize(node.text ?? "")}`;
  }
  const parts = [`${indent}- ${node.role}`];
  if (node.name !== undefined && node.name !== "") parts[0] += ` "${normalize(node.name)}"`;
  if (node.level !== undefined) parts.push(`[level=${node.level}]`);
  if (node.ref !== undefined) parts.push(`[ref=${node.ref}]`);
  if (node.checked === true) parts.push("[checked]");
  if (node.disabled === true) parts.push("[disabled]");
  return parts.join(" ");
}

/**
 * Render a node list as the compact text the model reads.
 * Pure: deterministic, no I/O, no clock.
 */
export function formatSnapshot(
  nodes: readonly SnapshotNode[],
  opts: FormatSnapshotOptions = {},
): SnapshotOutcome {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  if (opts.textOnly === true) {
    const text = nodes
      .filter((node) => node.role === "text")
      .map((node) => normalize(node.text ?? ""))
      .filter((line) => line !== "")
      .join("\n");
    return truncate(text, maxChars);
  }
  return truncate(nodes.map(formatNode).join("\n"), maxChars);
}

/**
 * Page-side expression evaluated with `page.evaluate`. It clears previous
 * refs, walks visible DOM in order, and returns SnapshotNode[].
 *
 * Kept as a string so the runtime host can inject it without importing
 * browser globals into this package.
 */
export const SNAPSHOT_SCRIPT = String.raw`
(() => {
  var MAX_NODES = 500;
  var refCounter = 0;
  var nodes = [];

  function textOf(el) {
    return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function isRendered(el) {
    var view = el.ownerDocument && el.ownerDocument.defaultView;
    if (!view) return false;
    var style = view.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function hasBox(el) {
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function textHasBox(node) {
    var range = document.createRange();
    range.selectNodeContents(node);
    var rect = range.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function roleOf(el) {
    var explicit = el.getAttribute("role");
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "input") {
      var type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button" || type === "reset") return "button";
      return "textbox";
    }
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") return "heading";
    if (tag === "ul" || tag === "ol") return "list";
    if (tag === "li") return "listitem";
    if (tag === "nav") return "navigation";
    if (tag === "main") return "main";
    if (tag === "header") return "banner";
    if (tag === "footer") return "contentinfo";
    if (tag === "img") return "img";
    return "text";
  }

  function isInteractive(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return true;
    if (tag === "button" || tag === "input" || tag === "select" || tag === "textarea") return true;
    var editable = el.getAttribute("contenteditable");
    if (editable === "true" || editable === "") return true;
    var role = el.getAttribute("role");
    return role === "button" || role === "link" || role === "checkbox" || role === "radio" ||
      role === "tab" || role === "menuitem" || role === "switch";
  }

  function accessibleName(el) {
    var aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    var labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      var parts = [];
      for (var i = 0; i < labelledBy.split(/\s+/).length; i += 1) {
        var id = labelledBy.split(/\s+/)[i];
        var labelEl = id ? el.ownerDocument.getElementById(id) : null;
        if (labelEl) parts.push(textOf(labelEl));
      }
      var joined = parts.join(" ").trim();
      if (joined) return joined;
    }
    if (el.id) {
      var labels = el.ownerDocument.querySelectorAll("label");
      for (var j = 0; j < labels.length; j += 1) {
        if (labels[j].htmlFor === el.id) {
          var labelText = textOf(labels[j]);
          if (labelText) return labelText;
        }
      }
    }
    var alt = el.getAttribute("alt");
    if (alt && alt.trim()) return alt.trim();
    var placeholder = el.getAttribute("placeholder");
    if (placeholder && placeholder.trim()) return placeholder.trim();
    var title = el.getAttribute("title");
    if (title && title.trim()) return title.trim();
    return textOf(el).slice(0, 80);
  }

  function push(node) {
    if (nodes.length < MAX_NODES) nodes.push(node);
  }

  function walk(raw, depth) {
    if (nodes.length >= MAX_NODES || !raw) return;
    if (raw.nodeType === 3) {
      var value = (raw.textContent || "").replace(/\s+/g, " ").trim();
      if (value && raw.parentElement && isRendered(raw.parentElement) && textHasBox(raw)) {
        push({ depth: depth, role: "text", text: value.slice(0, 300) });
      }
      return;
    }
    if (raw.nodeType !== 1) return;
    var el = raw;
    var tag = el.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template") return;
    if (el.getAttribute("aria-hidden") === "true" &&
        !el.querySelector('[role="dialog"], [role="alertdialog"]')) return;
    if (!isRendered(el)) return;
    var boxed = hasBox(el);

    var role = roleOf(el);
    var nextDepth = depth;
    if (isInteractive(el)) {
      if (boxed) {
        var ref = "e" + (++refCounter);
        el.setAttribute("data-volto-ref", ref);
        var item = { depth: depth, role: role, ref: ref };
        var name = accessibleName(el);
        if (name) item.name = name;
        if (el.disabled === true) item.disabled = true;
        if (el.checked === true) item.checked = true;
        push(item);
        nextDepth = depth + 1;
      }
    } else if (role === "heading" || role === "list" || role === "listitem" ||
      role === "navigation" || role === "main" || role === "banner" || role === "contentinfo") {
      if (boxed) {
        var structural = { depth: depth, role: role };
        var label = accessibleName(el);
        if (label && role !== "list" && role !== "main" && role !== "banner" && role !== "contentinfo") {
          structural.name = label;
        }
        if (role === "heading") {
          var level = parseInt(tag.charAt(1), 10);
          if (level) structural.level = level;
        }
        push(structural);
        nextDepth = depth + 1;
      }
    }

    for (var child = el.firstChild; child; child = child.nextSibling) {
      walk(child, nextDepth);
    }
  }

  var previous = document.querySelectorAll("[data-volto-ref]");
  for (var k = 0; k < previous.length; k += 1) previous[k].removeAttribute("data-volto-ref");
  if (document.body) walk(document.body, 0);
  return nodes;
})()
`;