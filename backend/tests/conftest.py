import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app.db.session import Base, get_db
from app.main import app
from app.models.record import Record

TEST_DATABASE_URL = "postgresql+psycopg2://postgres:postgres@localhost:5432/deadwax_test"

engine = create_engine(TEST_DATABASE_URL)
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


@pytest.fixture(scope="session", autouse=True)
def _create_schema():
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture(autouse=True)
def _truncate_between_tests():
    yield
    with engine.begin() as conn:
        for table in reversed(Base.metadata.sorted_tables):
            conn.execute(text(f'TRUNCATE TABLE "{table.name}" CASCADE'))


@pytest.fixture()
def db_session():
    session = TestingSessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture()
def client(db_session):
    def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture()
def sample_record(db_session):
    record = Record(
        catalog_number="DW-TEST-1",
        title="Test Pressing",
        artist="Fixture Artist",
        genre="Jazz",
        year=1980,
        price=25,
        stock=3,
        side_a=["A1"],
        side_b=["B1"],
    )
    db_session.add(record)
    db_session.commit()
    db_session.refresh(record)
    return record


def register_user(client, email="buyer@example.com", password="correcthorsebattery"):
    resp = client.post("/auth/register", json={"email": email, "password": password})
    assert resp.status_code == 201, resp.text
    return resp.json()


def auth_headers(tokens):
    return {"Authorization": f"Bearer {tokens['access_token']}"}
