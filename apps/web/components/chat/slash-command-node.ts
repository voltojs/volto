// apps/web/components/chat/slash-command-node.ts
'use client';

import { Node, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/**
 * Inline atom chip for a selected slash command. Serializes as `/name` via
 * renderText so submit payloads stay plain text (same contract as file
 * mentions). Hover surfaces a fixed-position floating card with the command
 * description — overflow on the editor scroller would clip a CSS ::after
 * tooltip, so the card is portal'd to document.body.
 */
export const SlashCommandNode = Node.create({
  name: 'slashCommand',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      name: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-name') ?? '',
        renderHTML: (attributes) => ({ 'data-name': attributes.name }),
      },
      description: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-description') ?? '',
        renderHTML: (attributes) => ({ 'data-description': attributes.description }),
      },
      kind: {
        default: 'skill',
        parseHTML: (element) => element.getAttribute('data-kind') ?? 'skill',
        renderHTML: (attributes) => ({ 'data-kind': attributes.kind }),
      },
    };
  },

  parseHTML() {
    return [{ tag: `span[data-type="${this.name}"]` }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const name = String(node.attrs.name ?? '');
    const description = String(node.attrs.description ?? '');
    return [
      'span',
      mergeAttributes(
        {
          'data-type': this.name,
          class: 'slash-command-chip',
          'data-description': description,
          // Screen-reader label; visual tooltip is handled by the plugin below
          // (native title would double with the floating card).
          'aria-label': description ? `/${name}：${description}` : `/${name}`,
        },
        HTMLAttributes,
      ),
      `/${name}`,
    ];
  },

  renderText({ node }) {
    return `/${node.attrs.name}`;
  },

  addProseMirrorPlugins() {
    return [createSlashCommandTooltipPlugin()];
  },
});

const TOOLTIP_CLASS = 'slash-command-tooltip';

function createSlashCommandTooltipPlugin() {
  let tooltipEl: HTMLElement | null = null;
  let activeChip: HTMLElement | null = null;

  const hide = () => {
    tooltipEl?.remove();
    tooltipEl = null;
    activeChip = null;
  };

  const show = (chip: HTMLElement) => {
    const description = chip.getAttribute('data-description');
    if (!description) {
      hide();
      return;
    }
    if (activeChip === chip && tooltipEl) return;
    hide();
    activeChip = chip;
    tooltipEl = document.createElement('div');
    tooltipEl.className = TOOLTIP_CLASS;
    tooltipEl.setAttribute('role', 'tooltip');
    tooltipEl.textContent = description;
    document.body.appendChild(tooltipEl);
    positionTooltip(tooltipEl, chip);
  };

  const onPointerOver = (view: EditorView, event: Event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      hide();
      return false;
    }
    const chip = target.closest<HTMLElement>('.slash-command-chip');
    if (chip && view.dom.contains(chip)) show(chip);
    else hide();
    return false;
  };

  const onPointerOut = (view: EditorView, event: Event) => {
    void view;
    const target = event.target;
    if (!(target instanceof Element)) return false;
    const chip = target.closest<HTMLElement>('.slash-command-chip');
    if (!chip) return false;
    // TipTap's Node is imported above — compare against the DOM Node constructor.
    const related = (event as MouseEvent).relatedTarget;
    if (related instanceof globalThis.Node && chip.contains(related)) return false;
    hide();
    return false;
  };

  const onFocusOut = () => {
    hide();
    return false;
  };

  return new Plugin({
    key: new PluginKey('slashCommandChipTooltip'),
    props: {
      handleDOMEvents: {
        mouseover: onPointerOver,
        mouseout: onPointerOut,
        // Keyboard / touch: reveal on focus; hide on blur.
        focusin: onPointerOver,
        focusout: onFocusOut,
      },
    },
    view() {
      return {
        destroy: hide,
      };
    },
  });
}

function positionTooltip(tooltip: HTMLElement, chip: HTMLElement): void {
  const rect = chip.getBoundingClientRect();
  const gap = 8;
  // Place above when there is room; otherwise fall below the chip.
  const aboveTop = rect.top - tooltip.offsetHeight - gap;
  const top = aboveTop >= 8 ? aboveTop : rect.bottom + gap;
  const maxLeft = window.innerWidth - tooltip.offsetWidth - 8;
  tooltip.style.left = `${Math.max(8, Math.min(rect.left, maxLeft))}px`;
  tooltip.style.top = `${Math.max(8, top)}px`;
}
