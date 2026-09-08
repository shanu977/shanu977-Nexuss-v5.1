from typing import Dict, List

SYSTEM_PROMPT = (
    "You are a helpful, concise AI assistant. Answer the user's questions "
    "clearly and directly. When the user asks to write code, provide complete, "
    "correct code using appropriate libraries and APIs (for example, datetime/time "
    "for current time, or fetch for real-time data). Use the conversation history "
    "for context. Never reveal internal reasoning or planning. Respond only with "
    "the final answer for the user."
)

# Token budget (not chars) so the assembled request stays inside
# llama-3.3-70b's 128k token context window even for CJK-heavy text
# (CJK ~1 token/char vs ~4 chars/token for Latin).
MAX_CONTEXT_TOKENS = 100_000


class ContextLimitError(Exception):
    """Raised when a single message exceeds the AI model's context budget."""


def build_system_prompt() -> str:
    """Return the base system prompt for the AI."""
    return SYSTEM_PROMPT


def estimate_tokens(text: str) -> int:
    """Rough dependency-free token estimate.

    CJK characters cost ~1 token each; other characters average ~4/token.
    Not exact, but a safe upper-ish bound for context sizing.
    """
    cjk = sum(
        1
        for ch in text
        if "\u4e00" <= ch <= "\u9fff"
        or "\u3040" <= ch <= "\u30ff"
        or "\uac00" <= ch <= "\ud7af"
    )
    other = len(text) - cjk
    return cjk + other // 4 + (1 if other % 4 else 0)


def build_messages(
    history: List[Dict[str, str]],
    user_message: str,
    max_tokens: int = MAX_CONTEXT_TOKENS,
) -> List[Dict[str, str]]:
    """Build the full message list sent to the AI provider.

    Order: system prompt -> (trimmed) conversation history -> new user message.
    History is already ordered oldest -> newest. To stay under the context
    budget the oldest history messages are dropped first; the newest context
    (and the user message itself) is always kept.

    Raises ContextLimitError if the user message alone would exceed the budget.
    """
    system = {"role": "system", "content": build_system_prompt()}
    user = {"role": "user", "content": user_message}

    fixed_tokens = estimate_tokens(system["content"]) + estimate_tokens(
        user["content"]
    )
    if fixed_tokens > max_tokens:
        raise ContextLimitError(
            "Message is too long for the AI model. Please shorten it and try again."
        )

    budget = max_tokens - fixed_tokens
    kept: List[Dict[str, str]] = []
    total = 0
    for message in reversed(history):  # newest first
        cost = estimate_tokens(message["content"])
        if total + cost > budget:
            break
        kept.append(message)
        total += cost

    return [system] + list(reversed(kept)) + [user]


def build_vision_messages(
    history: List[Dict[str, str]],
    user_message: str,
    image_data_url: str,
    max_tokens: int = MAX_CONTEXT_TOKENS,
) -> List[Dict]:
    """Build the full message list for a screen-analysis request.

    Reuses the text budget/trimming from `build_messages` (history stays plain
    text) and attaches the single captured frame to the current user message as
    an OpenAI-style `image_url` content part. Only the live frame the user just
    asked about is sent; nothing is stored server-side.

    Raises ContextLimitError if the text alone would exceed the budget.
    """
    messages = build_messages(history, user_message, max_tokens=max_tokens)
    messages[-1] = {
        "role": "user",
        "content": [
            {"type": "text", "text": user_message},
            {"type": "image_url", "image_url": {"url": image_data_url}},
        ],
    }
    return messages


WORKSPACE_CONTEXT_TEMPLATE = (
    "The user has granted access to a local workspace (a folder on their "
    "computer). Below is the workspace context (files, sections, or workspace "
    "status) the workspace engine selected for this request. Use it to answer "
    "accurately; never invent files or contents that are not shown. If the "
    "workspace context is irrelevant to the question, ignore it.\n\n{context}"
)

# The client-side Workspace Agent turns a valid block into a diff the user must
# approve. The model MUST NOT claim to have modified files: it only proposes.
AGENT_CHANGE_GUIDANCE = (
    "\n\nIf the user asks you to change code in this workspace, you may propose "
    "the exact edits by ending your reply with a fenced code block tagged "
    "`workspace-change` containing JSON like: "
    '{"changes":[{"path":"src/example.py","content":"<full new file content>"}]}. '
    "The client shows a diff and only applies it after the user approves. "
    "Never claim you edited files yourself."
    "\n\nFor directory creation, include the path in a mkdir proposal via "
    '{"changes":[{"path":"new/folder/.keep","content":""}]} or rely on parent '
    "dirs being auto-created when you create a file inside them."
    "\n\nFor terminal execution, you may propose a command with a fenced block "
    "tagged `workspace-command` like: "
    '{"run":{"command":"npm test","cwd":""},"test":{"cwd":""} }. '
    "Commands are validated against a policy (npm/pnpm/yarn/bun, python -m pytest, "
    "go test, cargo, make) and require user approval before execution. "
    "Output is returned to you on the next turn."
)


def attach_workspace_context(
    messages: List[Dict],
    workspace_context: str,
    max_tokens: int = MAX_CONTEXT_TOKENS,
) -> List[Dict]:
    """Insert a workspace-context note before the current (last) user message.

    Chat history and the workspace note stay separate prompt regions. The
    client already caps the context to a small budget; as a hard guard the note
    is truncated from the front (keeping the newest, most relevant sections)
    when it alone would exceed the context budget. Blank context is ignored.
    """
    text = workspace_context.strip()
    if not text:
        return messages
    content = WORKSPACE_CONTEXT_TEMPLATE.format(context=text)
    if estimate_tokens(content) > max_tokens:
        tail = text[-max(1, max_tokens * 4 - 400) :]
        content = WORKSPACE_CONTEXT_TEMPLATE.format(context=tail)
    note = {"role": "system", "content": content + AGENT_CHANGE_GUIDANCE}
    return messages[:-1] + [note, messages[-1]]
