/**
 * API client for the LLM Council backend.
 */

const API_BASE = 'http://localhost:8001';

/**
 * Shared SSE stream reader. Reads events from a fetch response and calls onEvent for each.
 */
async function readSSEStream(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value);
    const lines = chunk.split('\n');

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        try {
          const event = JSON.parse(data);
          onEvent(event.type, event);
        } catch (e) {
          console.error('Failed to parse SSE event:', e);
        }
      }
    }
  }
}

export const api = {
  /**
   * List all conversations.
   */
  async listConversations() {
    const response = await fetch(`${API_BASE}/api/conversations`);
    if (!response.ok) {
      throw new Error('Failed to list conversations');
    }
    return response.json();
  },

  /**
   * Create a new conversation.
   */
  async createConversation() {
    const response = await fetch(`${API_BASE}/api/conversations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    if (!response.ok) {
      throw new Error('Failed to create conversation');
    }
    return response.json();
  },

  /**
   * Get a specific conversation.
   */
  async getConversation(conversationId) {
    const response = await fetch(
      `${API_BASE}/api/conversations/${conversationId}`
    );
    if (!response.ok) {
      throw new Error('Failed to get conversation');
    }
    return response.json();
  },

  /**
   * Send a message and receive streaming Stage 1 results.
   */
  async sendMessageStream(conversationId, content, onEvent, signal = null) {
    const response = await fetch(
      `${API_BASE}/api/conversations/${conversationId}/message/stream`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
        signal,
      }
    );

    if (!response.ok) {
      throw new Error('Failed to send message');
    }

    await readSSEStream(response, onEvent);
  },

  /**
   * Run Stage 2 (peer review) on a specific assistant message.
   */
  async runStage2Stream(conversationId, messageIndex, onEvent, signal = null) {
    const response = await fetch(
      `${API_BASE}/api/conversations/${conversationId}/messages/${messageIndex}/stage2`,
      {
        method: 'POST',
        signal,
      }
    );

    if (!response.ok) {
      throw new Error('Failed to run Stage 2');
    }

    await readSSEStream(response, onEvent);
  },

  /**
   * Run Stage 3 (synthesis) on a specific assistant message.
   */
  async runStage3Stream(conversationId, messageIndex, onEvent, signal = null) {
    const response = await fetch(
      `${API_BASE}/api/conversations/${conversationId}/messages/${messageIndex}/stage3`,
      {
        method: 'POST',
        signal,
      }
    );

    if (!response.ok) {
      throw new Error('Failed to run Stage 3');
    }

    await readSSEStream(response, onEvent);
  },
};
