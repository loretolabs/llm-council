"""FastAPI backend for LLM Council."""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import List, Dict, Any
import uuid
import json
import asyncio

from . import storage
from .council import (
    generate_conversation_title,
    stage1_collect_responses,
    stage2_collect_rankings,
    stage3_synthesize_final,
    calculate_aggregate_rankings,
)

app = FastAPI(title="LLM Council API")

# Enable CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class CreateConversationRequest(BaseModel):
    """Request to create a new conversation."""
    pass


class SendMessageRequest(BaseModel):
    """Request to send a message in a conversation."""
    content: str


class ConversationMetadata(BaseModel):
    """Conversation metadata for list view."""
    id: str
    created_at: str
    title: str
    message_count: int


class Conversation(BaseModel):
    """Full conversation with all messages."""
    id: str
    created_at: str
    title: str
    messages: List[Dict[str, Any]]


def build_conversation_history(conversation: Dict[str, Any], current_query: str) -> List[Dict[str, str]]:
    """
    Build OpenAI-format message history from stored conversation.
    Uses stage3 synthesis as assistant response if available, else first stage1 response.
    """
    messages = []
    for msg in conversation["messages"]:
        if msg["role"] == "user":
            messages.append({"role": "user", "content": msg["content"]})
        elif msg["role"] == "assistant" and msg.get("stage3"):
            messages.append({"role": "assistant", "content": msg["stage3"]["response"]})
        elif msg["role"] == "assistant" and msg.get("stage1"):
            messages.append({"role": "assistant", "content": msg["stage1"][0]["response"]})
    messages.append({"role": "user", "content": current_query})
    return messages


def get_prior_history(conversation: Dict[str, Any]) -> List[Dict[str, str]]:
    """
    Build conversation history excluding the current (last) user+assistant exchange.
    Used by stage3 to provide full conversation context.
    """
    messages = []
    for msg in conversation["messages"][:-2]:  # Exclude last user + assistant pair
        if msg["role"] == "user":
            messages.append({"role": "user", "content": msg["content"]})
        elif msg["role"] == "assistant" and msg.get("stage3"):
            messages.append({"role": "assistant", "content": msg["stage3"]["response"]})
        elif msg["role"] == "assistant" and msg.get("stage1"):
            messages.append({"role": "assistant", "content": msg["stage1"][0]["response"]})
    return messages or None


@app.get("/")
async def root():
    """Health check endpoint."""
    return {"status": "ok", "service": "LLM Council API"}


@app.get("/api/conversations", response_model=List[ConversationMetadata])
async def list_conversations():
    """List all conversations (metadata only)."""
    return storage.list_conversations()


@app.post("/api/conversations", response_model=Conversation)
async def create_conversation(request: CreateConversationRequest):
    """Create a new conversation."""
    conversation_id = str(uuid.uuid4())
    conversation = storage.create_conversation(conversation_id)
    return conversation


@app.get("/api/conversations/{conversation_id}", response_model=Conversation)
async def get_conversation(conversation_id: str):
    """Get a specific conversation with all its messages."""
    conversation = storage.get_conversation(conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conversation


@app.post("/api/conversations/{conversation_id}/message/stream")
async def send_message_stream(conversation_id: str, request: SendMessageRequest):
    """
    Send a message and run Stage 1 only (parallel model queries).
    Stage 2 and Stage 3 are triggered separately on demand.
    """
    conversation = storage.get_conversation(conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    is_first_message = len(conversation["messages"]) == 0

    async def event_generator():
        try:
            # Add user message
            storage.add_user_message(conversation_id, request.content)

            # Reload conversation to include the user message we just added
            conv = storage.get_conversation(conversation_id)

            # Start title generation in parallel (don't await yet)
            title_task = None
            if is_first_message:
                title_task = asyncio.create_task(generate_conversation_title(request.content))

            # Build conversation history for multi-turn support
            messages = build_conversation_history(conversation, request.content)

            # Stage 1: Collect responses
            yield f"data: {json.dumps({'type': 'stage1_start'})}\n\n"
            stage1_results = await stage1_collect_responses(messages)
            yield f"data: {json.dumps({'type': 'stage1_complete', 'data': stage1_results})}\n\n"

            # Save assistant message with Stage 1 only
            storage.add_assistant_message(conversation_id, stage1_results)

            # Wait for title generation if it was started
            if title_task:
                title = await title_task
                storage.update_conversation_title(conversation_id, title)
                yield f"data: {json.dumps({'type': 'title_complete', 'data': {'title': title}})}\n\n"

            # Send completion event
            yield f"data: {json.dumps({'type': 'complete'})}\n\n"

        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        }
    )


@app.post("/api/conversations/{conversation_id}/messages/{message_index}/stage2")
async def run_stage2(conversation_id: str, message_index: int):
    """
    Run Stage 2 (peer review/ranking) on an existing assistant message's Stage 1 results.
    """
    conversation = storage.get_conversation(conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    messages = conversation["messages"]
    if message_index < 0 or message_index >= len(messages):
        raise HTTPException(status_code=400, detail="Invalid message index")

    assistant_msg = messages[message_index]
    if assistant_msg["role"] != "assistant" or not assistant_msg.get("stage1"):
        raise HTTPException(status_code=400, detail="Message has no Stage 1 results")

    # Find the user query (the message immediately before this assistant message)
    if message_index == 0 or messages[message_index - 1]["role"] != "user":
        raise HTTPException(status_code=400, detail="Cannot find user query for this message")

    user_query = messages[message_index - 1]["content"]
    stage1_results = assistant_msg["stage1"]

    async def event_generator():
        try:
            yield f"data: {json.dumps({'type': 'stage2_start'})}\n\n"

            stage2_results, label_to_model = await stage2_collect_rankings(user_query, stage1_results)
            aggregate_rankings = calculate_aggregate_rankings(stage2_results, label_to_model)

            metadata = {
                "label_to_model": label_to_model,
                "aggregate_rankings": aggregate_rankings,
            }

            # Persist to storage
            storage.update_assistant_stage(
                conversation_id, message_index, "stage2", stage2_results, metadata=metadata
            )

            yield f"data: {json.dumps({'type': 'stage2_complete', 'data': stage2_results, 'metadata': metadata})}\n\n"
            yield f"data: {json.dumps({'type': 'complete'})}\n\n"

        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        }
    )


@app.post("/api/conversations/{conversation_id}/messages/{message_index}/stage3")
async def run_stage3(conversation_id: str, message_index: int):
    """
    Run Stage 3 (chairman synthesis) on an existing assistant message.
    Includes full conversation history for multi-turn context.
    """
    conversation = storage.get_conversation(conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    messages = conversation["messages"]
    if message_index < 0 or message_index >= len(messages):
        raise HTTPException(status_code=400, detail="Invalid message index")

    assistant_msg = messages[message_index]
    if assistant_msg["role"] != "assistant" or not assistant_msg.get("stage1"):
        raise HTTPException(status_code=400, detail="Message has no Stage 1 results")
    if not assistant_msg.get("stage2"):
        raise HTTPException(status_code=400, detail="Stage 2 must be run before Stage 3")

    # Find the user query
    if message_index == 0 or messages[message_index - 1]["role"] != "user":
        raise HTTPException(status_code=400, detail="Cannot find user query for this message")

    user_query = messages[message_index - 1]["content"]
    stage1_results = assistant_msg["stage1"]
    stage2_results = assistant_msg["stage2"]

    # Build prior conversation history for multi-turn context
    history = get_prior_history(conversation)

    async def event_generator():
        try:
            yield f"data: {json.dumps({'type': 'stage3_start'})}\n\n"

            stage3_result = await stage3_synthesize_final(
                user_query, stage1_results, stage2_results,
                conversation_history=history
            )

            # Persist to storage
            storage.update_assistant_stage(
                conversation_id, message_index, "stage3", stage3_result
            )

            yield f"data: {json.dumps({'type': 'stage3_complete', 'data': stage3_result})}\n\n"
            yield f"data: {json.dumps({'type': 'complete'})}\n\n"

        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        }
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
