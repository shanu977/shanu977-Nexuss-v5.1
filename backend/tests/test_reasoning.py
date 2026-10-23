# pyrefly: ignore [missing-import]
from app.utils.reasoning import filter_reasoning


def test_leaves_normal_response_unchanged():
    assert filter_reasoning("Hello") == "Hello"
    assert filter_reasoning("The sky is blue.\nThat is the answer.") == (
        "The sky is blue.\nThat is the answer."
    )


def test_removes_complete_thinking_response_block():
    raw = "\n".join(
        [
            " thinking",
            "Here's a thinking process that leads to the suggested answer:",
            "1. Analyze the request.",
            "2. Look at the screenshot.",
            " response",
            "Final answer.",
        ]
    )
    assert filter_reasoning(raw) == "Final answer."


def test_handles_multiple_reasoning_blocks():
    raw = "\n".join(
        [
            " thinking",
            "reasoning 1",
            " response",
            "Answer 1",
            "",
            " thinking",
            "reasoning 2",
            " response",
            "Answer 2",
        ]
    )
    assert filter_reasoning(raw) == "Answer 1\n\nAnswer 2"


def test_keeps_answer_text_before_a_later_reasoning_block():
    raw = "\n".join(
        ["Preamble.", "", " thinking", "internal reasoning", " response", "Main answer."]
    )
    assert filter_reasoning(raw) == "Preamble.\n\nMain answer."


def test_removes_angle_bracket_reasoning_tags():
    assert filter_reasoning("<thinking>step by step</thinking>Final answer.") == (
        "Final answer."
    )
    assert filter_reasoning(
        "<thinking>reasoning</thinking><response>Answer.</response>"
    ) == "Answer."


def test_matches_uppercase_and_whitespace_tag_variants():
    assert filter_reasoning("<THINKING>\nreasoning\n</THINKING>\nAnswer.") == "Answer."
    assert filter_reasoning("< THINK >\nreasoning\n</ THINK >\nAnswer.") == "Answer."
    assert filter_reasoning("<thinking >\nreasoning\n</thinking >\nAnswer.") == "Answer."
    assert filter_reasoning("<RESPONSE>The answer.</RESPONSE>") == "The answer."


def test_does_not_touch_normal_prose_containing_think_or_response():
    assert filter_reasoning("I think this solution is correct.") == (
        "I think this solution is correct."
    )
    assert filter_reasoning("Thinking about it, the HTTP response was 200.") == (
        "Thinking about it, the HTTP response was 200."
    )
    assert filter_reasoning("Please think carefully before answering.") == (
        "Please think carefully before answering."
    )


def test_strips_stray_reasoning_close_boundary_without_removing_the_answer():
    assert filter_reasoning("<response>The answer is here.</response>") == (
        "The answer is here."
    )


def test_never_exposes_reasoning_when_the_stream_ends_inside_the_block():
    raw = "\n".join([" thinking", "unfinished internal reasoning"])
    assert filter_reasoning(raw) == ""


def test_discards_everything_after_an_unclosed_reasoning_tag():
    assert filter_reasoning("<thinking>reasoning\nFinal answer.") == ""


def test_filters_screen_share_style_response_with_reasoning():
    raw = "\n".join(
        [
            " thinking",
            "The user's screen shows a Python terminal.",
            "The visible error is ModuleNotFoundError for pandas.",
            "The user wants the cause and a fix.",
            " response",
            "The error is ModuleNotFoundError: No module named 'pandas'. Install it with `pip install pandas`.",
        ]
    )
    assert filter_reasoning(raw) == (
        "The error is ModuleNotFoundError: No module named 'pandas'. "
        "Install it with `pip install pandas`."
    )


def test_filters_reasoning_delimited_with_crlf_line_endings():
    raw = "thinking\r\ninternal reasoning\r\nresponse\r\nFinal answer.\r\n"
    assert filter_reasoning(raw) == "Final answer."


def test_never_exposes_reasoning_when_a_crlf_block_is_unclosed():
    raw = " thinking\r\nunfinished internal reasoning"
    assert filter_reasoning(raw) == ""


def test_keeps_numbered_answer_with_result_heading():
    raw = (
        "Here is the fix:\n\n"
        "1. Stop the service.\n"
        "2. Run the migration.\n"
        "3. Restart.\n\n"
        "Summary: applied the fix in 3 steps."
    )
    assert filter_reasoning(raw) == raw


def test_keeps_plan_heading_answer():
    raw = "Plan:\n- update config\n- restart server\n\nResult: the server is healthy again."
    assert filter_reasoning(raw) == raw


def test_keeps_decision_heading_answer():
    raw = "Decision: the bug is in chatStore, not the backend."
    assert filter_reasoning(raw) == raw


def test_strips_internal_cot_heading_but_keeps_output_generation_answer():
    raw = (
        "Strategy: pick a friendly greeting\n"
        "Draft: say hello\n"
        'Final Output Generation -> "Hello! How can I help you today?"'
    )
    assert filter_reasoning(raw) == "Hello! How can I help you today?"


def test_keeps_context_rich_reply_intact():
    raw = (
        "The Nexus connector failed because the token expired at 14:02 UTC.\n"
        "\n"
        "Next steps:\n"
        "1. Open the connector settings.\n"
        "2. Paste a fresh token.\n"
        "3. Reconnect and check the status light.\n"
        "\n"
        "Result: reconnection should succeed immediately after saving the token."
    )
    assert filter_reasoning(raw) == raw


def test_does_not_rewrite_greeting_when_no_deliberation_leaked():
    raw = "Hello! How can I help you with your code today?"
    assert filter_reasoning(raw) == raw


def test_streaming_after_planning_heading_does_not_freeze():
    from app.utils.reasoning import ReasoningFilter

    f = ReasoningFilter()
    out = f.push("Strategy: think first.\n")
    out += f.push("Now the real answer.\n")
    out += f.flush()
    assert "Now the real answer." in out