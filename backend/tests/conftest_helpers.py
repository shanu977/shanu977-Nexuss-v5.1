import os
import sys

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL", "sqlite:///./test_chatbot.db")

connect_args: dict = {}
if TEST_DATABASE_URL.startswith("sqlite"):
    connect_args["check_same_thread"] = False

engine_kwargs: dict = {}
if connect_args:
    engine_kwargs["connect_args"] = connect_args

engine = create_engine(TEST_DATABASE_URL, **engine_kwargs)
TestingSessionLocal = sessionmaker(
    bind=engine, autocommit=False, autoflush=False
)


def override_get_db():
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()
