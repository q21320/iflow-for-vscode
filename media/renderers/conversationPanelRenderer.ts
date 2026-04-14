import type { Conversation } from '../../src/protocol';
import { escapeAttr } from '../webviewUtils';
import { escapeHtml } from '../markdownRenderer';
import { timeAgo } from './sharedRendererUtils';

export function renderConversationPanel(opts: {
  conversations: Conversation[];
  search: string;
  showPanel: boolean;
  currentConversationId: string | null;
}): string {
  const { conversations, search, showPanel, currentConversationId } = opts;
  const filtered = conversations.filter((c) =>
    search === '' ||
    c.title.toLowerCase().includes(search.toLowerCase())
  );

  const now = Date.now();
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const yesterdayStart = todayStart - 86400000;

  const groups: { label: string; items: Conversation[] }[] = [];
  const today: Conversation[] = [];
  const yesterday: Conversation[] = [];
  const earlier: Conversation[] = [];

  for (const c of filtered) {
    if (c.updatedAt >= todayStart) {
      today.push(c);
    } else if (c.updatedAt >= yesterdayStart) {
      yesterday.push(c);
    } else {
      earlier.push(c);
    }
  }

  if (today.length > 0) groups.push({ label: 'Today', items: today });
  if (yesterday.length > 0) groups.push({ label: 'Yesterday', items: yesterday });
  if (earlier.length > 0) groups.push({ label: 'Earlier', items: earlier });

  return `
    <div class="conversation-panel ${showPanel ? '' : 'hidden'}" id="conversation-panel" role="dialog" aria-label="Conversation list">
      <div class="conversation-panel-search">
        <input type="text" id="conversation-search" placeholder="搜索会话..." value="${escapeAttr(search)}" aria-label="Search conversations" />
      </div>
      <div class="conversation-panel-list" role="listbox" aria-label="Conversations">
        ${groups.length === 0 ? '<div class="conversation-panel-empty">No conversations found</div>' : ''}
        ${groups.map((g) => `
          <div class="conversation-group-label">${g.label}</div>
          ${g.items.map((c) => `
            <div
              class="conversation-item ${c.id === currentConversationId ? 'active' : ''}"
              data-id="${c.id}"
              role="option"
              tabindex="0"
              aria-selected="${c.id === currentConversationId ? 'true' : 'false'}"
            >
              <div class="conversation-item-info">
                <div class="conversation-item-title">${escapeHtml(c.title)}</div>
                <div class="conversation-item-meta">
                  <span>${c.messages.length} 条消息</span>
                </div>
              </div>
              <span class="conversation-item-time">${timeAgo(c.updatedAt, now)}</span>
              <button class="conversation-item-delete" data-delete-id="${c.id}" title="删除"  aria-label="Delete conversation ${escapeAttr(c.title)}">&times;</button>
            </div>
          `).join('')}
        `).join('')}
      </div>
    </div>
  `;
}
