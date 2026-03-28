import { useState, useEffect } from 'react';
import Sidebar from './components/Sidebar';
import ChatInterface from './components/ChatInterface';
import { api } from './api';
import './App.css';

function App() {
  const [conversations, setConversations] = useState([]);
  const [currentConversationId, setCurrentConversationId] = useState(null);
  const [currentConversation, setCurrentConversation] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [abortController, setAbortController] = useState(null);

  // Load conversations on mount
  useEffect(() => {
    loadConversations();
  }, []);

  // Load conversation details when selected
  useEffect(() => {
    if (currentConversationId) {
      loadConversation(currentConversationId);
    }
  }, [currentConversationId]);

  const loadConversations = async () => {
    try {
      const convs = await api.listConversations();
      setConversations(convs);
    } catch (error) {
      console.error('Failed to load conversations:', error);
    }
  };

  const loadConversation = async (id) => {
    try {
      const conv = await api.getConversation(id);
      setCurrentConversation(conv);
    } catch (error) {
      console.error('Failed to load conversation:', error);
    }
  };

  const handleNewConversation = async () => {
    try {
      const newConv = await api.createConversation();
      setConversations([
        { id: newConv.id, created_at: newConv.created_at, message_count: 0 },
        ...conversations,
      ]);
      setCurrentConversationId(newConv.id);
    } catch (error) {
      console.error('Failed to create conversation:', error);
    }
  };

  const handleSelectConversation = (id) => {
    setCurrentConversationId(id);
  };

  const handleCancel = () => {
    if (abortController) {
      abortController.abort();
      setAbortController(null);
      setIsLoading(false);
      // Reload conversation from backend to get persisted state
      if (currentConversationId) {
        loadConversation(currentConversationId);
      }
    }
  };

  const handleSendMessage = async (content) => {
    if (!currentConversationId) return;

    const controller = new AbortController();
    setAbortController(controller);
    setIsLoading(true);

    try {
      // Optimistically add user message to UI
      const userMessage = { role: 'user', content };
      setCurrentConversation((prev) => ({
        ...prev,
        messages: [...prev.messages, userMessage],
      }));

      // Create a partial assistant message (Stage 1 only)
      const assistantMessage = {
        role: 'assistant',
        stage1: null,
        stage2: null,
        stage3: null,
        metadata: null,
        loading: {
          stage1: false,
          stage2: false,
          stage3: false,
        },
      };

      setCurrentConversation((prev) => ({
        ...prev,
        messages: [...prev.messages, assistantMessage],
      }));

      await api.sendMessageStream(currentConversationId, content, (eventType, event) => {
        switch (eventType) {
          case 'stage1_start':
            setCurrentConversation((prev) => {
              const messages = [...prev.messages];
              const lastMsg = { ...messages[messages.length - 1] };
              lastMsg.loading = { ...lastMsg.loading, stage1: true };
              messages[messages.length - 1] = lastMsg;
              return { ...prev, messages };
            });
            break;

          case 'stage1_complete':
            setCurrentConversation((prev) => {
              const messages = [...prev.messages];
              const lastMsg = { ...messages[messages.length - 1] };
              lastMsg.stage1 = event.data;
              lastMsg.loading = { ...lastMsg.loading, stage1: false };
              messages[messages.length - 1] = lastMsg;
              return { ...prev, messages };
            });
            break;

          case 'title_complete':
            loadConversations();
            break;

          case 'complete':
            loadConversations();
            setIsLoading(false);
            setAbortController(null);
            break;

          case 'error':
            console.error('Stream error:', event.message);
            setIsLoading(false);
            setAbortController(null);
            break;

          default:
            console.log('Unknown event type:', eventType);
        }
      }, controller.signal);
    } catch (error) {
      if (error.name === 'AbortError') {
        // Cancelled by user, state already handled in handleCancel
        return;
      }
      console.error('Failed to send message:', error);
      setCurrentConversation((prev) => ({
        ...prev,
        messages: prev.messages.slice(0, -2),
      }));
      setIsLoading(false);
      setAbortController(null);
    }
  };

  const updateMessageAtIndex = (messageIndex, updater) => {
    setCurrentConversation((prev) => {
      const messages = [...prev.messages];
      messages[messageIndex] = updater({ ...messages[messageIndex] });
      return { ...prev, messages };
    });
  };

  const handleRunStage2 = async (messageIndex) => {
    if (!currentConversationId) return;

    const controller = new AbortController();
    setAbortController(controller);
    setIsLoading(true);

    updateMessageAtIndex(messageIndex, (msg) => ({
      ...msg,
      loading: { ...msg.loading, stage2: true },
    }));

    try {
      await api.runStage2Stream(currentConversationId, messageIndex, (eventType, event) => {
        switch (eventType) {
          case 'stage2_complete':
            updateMessageAtIndex(messageIndex, (msg) => ({
              ...msg,
              stage2: event.data,
              metadata: event.metadata,
              loading: { ...msg.loading, stage2: false },
            }));
            break;

          case 'complete':
            setIsLoading(false);
            setAbortController(null);
            break;

          case 'error':
            console.error('Stage 2 error:', event.message);
            updateMessageAtIndex(messageIndex, (msg) => ({
              ...msg,
              loading: { ...msg.loading, stage2: false },
            }));
            setIsLoading(false);
            setAbortController(null);
            break;
        }
      }, controller.signal);
    } catch (error) {
      if (error.name === 'AbortError') return;
      console.error('Failed to run Stage 2:', error);
      updateMessageAtIndex(messageIndex, (msg) => ({
        ...msg,
        loading: { ...msg.loading, stage2: false },
      }));
      setIsLoading(false);
      setAbortController(null);
    }
  };

  const handleRunStage3 = async (messageIndex) => {
    if (!currentConversationId) return;

    const controller = new AbortController();
    setAbortController(controller);
    setIsLoading(true);

    updateMessageAtIndex(messageIndex, (msg) => ({
      ...msg,
      loading: { ...msg.loading, stage3: true },
    }));

    try {
      await api.runStage3Stream(currentConversationId, messageIndex, (eventType, event) => {
        switch (eventType) {
          case 'stage3_complete':
            updateMessageAtIndex(messageIndex, (msg) => ({
              ...msg,
              stage3: event.data,
              loading: { ...msg.loading, stage3: false },
            }));
            break;

          case 'complete':
            setIsLoading(false);
            setAbortController(null);
            break;

          case 'error':
            console.error('Stage 3 error:', event.message);
            updateMessageAtIndex(messageIndex, (msg) => ({
              ...msg,
              loading: { ...msg.loading, stage3: false },
            }));
            setIsLoading(false);
            setAbortController(null);
            break;
        }
      }, controller.signal);
    } catch (error) {
      if (error.name === 'AbortError') return;
      console.error('Failed to run Stage 3:', error);
      updateMessageAtIndex(messageIndex, (msg) => ({
        ...msg,
        loading: { ...msg.loading, stage3: false },
      }));
      setIsLoading(false);
      setAbortController(null);
    }
  };

  return (
    <div className="app">
      <Sidebar
        conversations={conversations}
        currentConversationId={currentConversationId}
        onSelectConversation={handleSelectConversation}
        onNewConversation={handleNewConversation}
      />
      <ChatInterface
        conversation={currentConversation}
        onSendMessage={handleSendMessage}
        onRunStage2={handleRunStage2}
        onRunStage3={handleRunStage3}
        onCancel={handleCancel}
        isLoading={isLoading}
      />
    </div>
  );
}

export default App;
