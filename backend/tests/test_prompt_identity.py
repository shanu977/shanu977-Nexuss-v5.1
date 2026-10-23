# pyrefly: ignore [missing-import]
from app.services import prompt_service


def test_build_messages_includes_user_name_system_line():
    msgs = prompt_service.build_messages(
        [{"role": "user", "content": "hi"}], "what is 2+2?", user_name="Priya Sharma"
    )
    system = msgs[0]
    assert system["role"] == "system"
    assert "user's name is Priya Sharma" in system["content"]
    assert msgs[-1] == {"role": "user", "content": "what is 2+2?"}


def test_build_messages_without_user_name_has_no_identity_line():
    msgs = prompt_service.build_messages(
        [{"role": "user", "content": "hi"}], "what is 2+2?"
    )
    assert "user's name is" not in msgs[0]["content"]


def test_build_messages_blank_user_name_is_ignored():
    msgs = prompt_service.build_messages(
        [{"role": "user", "content": "hi"}], "what is 2+2?", user_name="   "
    )
    assert "user's name is" not in msgs[0]["content"]


def test_build_messages_identity_uses_first_name_guidance():
    msgs = prompt_service.build_messages(
        [], "hello", user_name="Priya Sharma"
    )
    content = msgs[0]["content"]
    assert "Use their first name naturally when it fits" in content


def test_build_vision_messages_passes_user_name():
    msgs = prompt_service.build_vision_messages(
        [], "what is on my screen", "data:image/png;base64,xxx", user_name="Alex"
    )
    assert "user's name is Alex" in msgs[0]["content"]


def test_user_name_never_replaces_the_base_prompt():
    msgs = prompt_service.build_messages([], "hello", user_name="Alex")
    base = prompt_service.build_system_prompt()
    assert msgs[0]["content"].startswith(base)
