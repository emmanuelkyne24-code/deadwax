from tests.conftest import auth_headers, register_user


def test_register_returns_tokens(client):
    tokens = register_user(client)
    assert "access_token" in tokens
    assert "refresh_token" in tokens


def test_register_duplicate_email_rejected(client):
    register_user(client, email="dupe@example.com")
    resp = client.post(
        "/auth/register", json={"email": "dupe@example.com", "password": "correcthorsebattery"}
    )
    assert resp.status_code == 400


def test_login_wrong_password_rejected(client):
    register_user(client, email="pw@example.com", password="correcthorsebattery")
    resp = client.post("/auth/login", json={"email": "pw@example.com", "password": "wrong-password"})
    assert resp.status_code == 401


def test_me_requires_auth(client):
    resp = client.get("/users/me")
    assert resp.status_code == 401


def test_me_with_token_returns_profile(client):
    tokens = register_user(client, email="profile@example.com")
    resp = client.get("/users/me", headers=auth_headers(tokens))
    assert resp.status_code == 200
    assert resp.json()["email"] == "profile@example.com"


def test_refresh_rotates_token_and_old_one_is_dead(client):
    tokens = register_user(client, email="rotate@example.com")
    first_refresh = tokens["refresh_token"]

    resp = client.post("/auth/refresh", json={"refresh_token": first_refresh})
    assert resp.status_code == 200
    new_tokens = resp.json()
    assert new_tokens["refresh_token"] != first_refresh

    # The old refresh token must be dead after rotation.
    replay = client.post("/auth/refresh", json={"refresh_token": first_refresh})
    assert replay.status_code == 401
