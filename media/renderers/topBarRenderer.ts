export function renderTopBar(title: string, conversationPanelHtml: string, showConversationPanel: boolean): string {
  return `
    <div class="top-bar">
      <div class="conversation-selector">
        <button
          id="conversation-trigger"
          class="conversation-trigger"
          title="Switch conversation"
          aria-label="Switch conversation"
          aria-haspopup="listbox"
          aria-expanded="${showConversationPanel ? 'true' : 'false'}"
          aria-controls="conversation-panel"
        >
          <span>${title}</span>
          <span class="chevron">▼</span>
        </button>
        ${conversationPanelHtml}
      </div>
      <div class="toolbar">
         <button id="new-conversation-top-btn" class="icon-btn" title="New Chat" aria-label="Start new conversation">
           <span class="icon">+</span>
         </button>
      </div>
    </div>
  `;
}
